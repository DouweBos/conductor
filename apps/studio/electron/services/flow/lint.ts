import { readFile } from "node:fs/promises";
import path from "node:path";

import { referenceOnLine, resolveReference } from "../../../app/lib/flowRefs";
import { COMMANDS_BY_NAME, HEADER_KEYS, paramsFor } from "../../../app/lib/maestroSchema";
import type { FileEntry, FlowCatalog, LintProblem } from "../../../app/lib/types";
import { listCases } from "../cases/casesService";
import { getProjectInfo, listFlows } from "../file/fileService";
import { loadFlowCatalog } from "./catalog";
import { indexReferences } from "./references";

/**
 * Everything we can tell is wrong with a flow without running it. The command
 * schema and the flow catalog are already indexed for autocomplete, so the same
 * data answers "does this command exist", "does that file exist", and "does this
 * call pass what the subflow reads".
 */

/** Names supplied by the runner rather than by a flow: `-e APP_ID=…`. */
const GLOBAL_ENV = /^[A-Z][A-Z0-9_]*$/;
/** Roots that are script output or Maestro built-ins, never flow parameters. */
const NOT_PARAMS = new Set(["output", "response", "maestro", "console", "json"]);

const indentOf = (line: string) => line.length - line.trimStart().length;

export async function lintProject(): Promise<LintProblem[]> {
  const project = getProjectInfo();
  if (!project) return [];
  const catalog = await loadFlowCatalog();
  const known = new Set(catalog.entries.map((e) => e.path));
  const calledFlows = new Set((await indexReferences()).map((ref) => ref.to));
  const problems: LintProblem[] = [];

  for (const file of flatten(await listFlows()).filter((f) => /\.(ya?ml)$/i.test(f.name))) {
    let content: string;
    try {
      content = await readFile(path.join(project.flowsDir, file.path), "utf8");
    } catch {
      continue;
    }
    problems.push(...lintFlow(file.path, content, catalog, known, calledFlows.has(file.path)));
  }
  problems.push(...(await lintCases(known)));
  return problems;
}

/** Lint a single flow's current buffer, for as-you-type diagnostics. */
export async function lintOne(flowPath: string, content: string): Promise<LintProblem[]> {
  const catalog = await loadFlowCatalog();
  const known = new Set(catalog.entries.map((e) => e.path));
  const called = new Set((await indexReferences()).map((ref) => ref.to));
  return lintFlow(flowPath, content, catalog, known, called.has(flowPath));
}

export function lintFlow(
  flowPath: string,
  content: string,
  catalog: FlowCatalog,
  known: Set<string>,
  /** True when other flows call this one, so its `${…}` are parameters. */
  isSubflow = false,
): LintProblem[] {
  const problems: LintProblem[] = [];
  const lines = content.split(/\r?\n/);
  const separator = lines.findIndex((l) => /^---\s*$/.test(l));
  const declared = new Set<string>(headerEnvKeys(lines, separator));

  let command: { name: string; indent: number } | null = null;

  lines.forEach((line, index) => {
    const at = index + 1;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;

    if (separator >= 0 && index < separator) {
      const key = /^([A-Za-z]\w*)\s*:/.exec(trimmed);
      if (key && indentOf(line) === 0 && !HEADER_KEYS.some((h) => h.name === key[1])) {
        problems.push(problem(flowPath, at, "warning", `Unknown flow header key "${key[1]}".`, line));
      }
      return;
    }

    // A step opens a new command block.
    const step = /^-\s+([A-Za-z]\w*)\s*:?/.exec(trimmed);
    if (step && indentOf(line) === 0) {
      command = { name: step[1], indent: 0 };
      if (!COMMANDS_BY_NAME.has(step[1])) {
        problems.push(problem(flowPath, at, "error", `Unknown command "${step[1]}".`, line));
      }
    } else if (command && indentOf(line) <= command.indent) {
      command = null;
    }

    // Keys inside a command block must be parameters of that command.
    const key = /^([A-Za-z]\w*)\s*:/.exec(trimmed);
    if (key && command && indentOf(line) === 4 && !trimmed.startsWith("-")) {
      const def = COMMANDS_BY_NAME.get(command.name);
      if (def && !paramsFor(def).some((p) => p.name === key[1])) {
        problems.push(
          problem(flowPath, at, "warning", `"${key[1]}" is not a parameter of ${command.name}.`, line),
        );
      }
    }

    // References must resolve to a file that exists.
    const raw = referenceOnLine(line);
    if (raw) {
      const target = resolveReference(raw, flowPath, catalog.aliases);
      if (!target) {
        problems.push(problem(flowPath, at, "error", `Unknown path alias in "${raw}".`, line));
      } else if (!known.has(target)) {
        problems.push(problem(flowPath, at, "error", `"${raw}" does not exist (${target}).`, line));
      } else if (!isSubflow) {
        // Maestro passes the caller's env down, so a subflow forwarding to
        // another can rely on inheritance. Only an entry point has to be explicit.
        problems.push(...missingParams(flowPath, lines, index, target, catalog));
      }
    }
  });

  // Every ${param} the steps read has to come from somewhere. A subflow's
  // parameters come from its callers, so this only means anything for a flow
  // nothing calls — there, an unsupplied name is just broken.
  const body = separator >= 0 ? lines.slice(separator + 1) : lines;
  const provided = new Set([...declared, ...envKeysAnywhere(body)]);
  const seen = new Set<string>();
  if (!isSubflow) body.forEach((line, offset) => {
    for (const match of line.matchAll(/\$\{\s*([A-Za-z_][\w.]*)/g)) {
      const name = match[1];
      if (name.includes(".") || NOT_PARAMS.has(name) || GLOBAL_ENV.test(name)) continue;
      if (provided.has(name) || seen.has(name)) continue;
      seen.add(name);
      problems.push(
        problem(
          flowPath,
          (separator >= 0 ? separator + 1 : 0) + offset + 1,
          "info",
          `"${name}" has no default — callers must pass it in env.`,
          line,
        ),
      );
    }
  });

  return problems;
}

/** A `runFlow` that doesn't pass everything the subflow reads. */
function missingParams(
  flowPath: string,
  lines: string[],
  index: number,
  target: string,
  catalog: FlowCatalog,
): LintProblem[] {
  const entry = catalog.entries.find((e) => e.path === target);
  if (!entry || entry.params.length === 0) return [];

  // The env block is a sibling of `file:`, so scope the scan to the whole step.
  let start = index;
  while (start > 0 && !/^\s*-\s+\S/.test(lines[start])) start -= 1;
  const stepIndent = indentOf(lines[start]);
  let end = start + 1;
  while (end < lines.length && (!lines[end].trim() || indentOf(lines[end]) > stepIndent)) end += 1;

  const passed = new Set<string>();
  for (let i = start; i < end; i++) {
    const env = /^(\s*)env:\s*$/.exec(lines[i]);
    if (!env) continue;
    for (let j = i + 1; j < end; j++) {
      if (!lines[j].trim()) continue;
      if (indentOf(lines[j]) <= env[1].length) break;
      const key = /^\s*([A-Za-z_]\w*)\s*:/.exec(lines[j]);
      if (key) passed.add(key[1]);
    }
  }

  const missing = entry.params.filter((p) => !passed.has(p));
  if (missing.length === 0) return [];
  return [
    problem(
      flowPath,
      index + 1,
      "warning",
      `${target} reads ${missing.join(", ")} — pass ${missing.length === 1 ? "it" : "them"} in env.`,
      lines[index],
    ),
  ];
}

/** Cases pointing nowhere, and flows no case covers. */
async function lintCases(known: Set<string>): Promise<LintProblem[]> {
  const problems: LintProblem[] = [];
  let cases;
  try {
    cases = await listCases();
  } catch {
    return problems;
  }
  const ids = new Set<string>();
  for (const testCase of cases) {
    if (ids.has(testCase.id)) {
      problems.push(problem(testCase.filePath, 1, "error", `Duplicate case id "${testCase.id}".`, ""));
    }
    ids.add(testCase.id);
    if (testCase.flow && !known.has(testCase.flow)) {
      problems.push(
        problem(testCase.filePath, 1, "error", `Case points at a missing flow: ${testCase.flow}.`, ""),
      );
    }
  }
  return problems;
}

function headerEnvKeys(lines: string[], separator: number): string[] {
  const header = separator >= 0 ? lines.slice(0, separator) : [];
  const keys: string[] = [];
  for (let i = 0; i < header.length; i++) {
    if (!/^env:\s*$/.test(header[i])) continue;
    for (let j = i + 1; j < header.length; j++) {
      if (!header[j].trim()) continue;
      if (/^\S/.test(header[j])) break;
      const key = /^\s+([A-Za-z_]\w*)\s*:/.exec(header[j]);
      if (key) keys.push(key[1]);
    }
    break;
  }
  return keys;
}

/** Keys of any `env:` block — a flow can define values for its own subflows. */
function envKeysAnywhere(lines: string[]): string[] {
  const keys: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const start = /^(\s*)env:\s*$/.exec(lines[i]);
    if (!start) continue;
    for (let j = i + 1; j < lines.length; j++) {
      if (!lines[j].trim()) continue;
      if (indentOf(lines[j]) <= start[1].length) break;
      const key = /^\s*([A-Za-z_]\w*)\s*:/.exec(lines[j]);
      if (key) keys.push(key[1]);
    }
  }
  return keys;
}

function problem(
  file: string,
  line: number,
  severity: LintProblem["severity"],
  message: string,
  text: string,
): LintProblem {
  return { file, line, severity, message, text: text.trim() };
}

function flatten(entries: FileEntry[]): FileEntry[] {
  const out: FileEntry[] = [];
  const walk = (list: FileEntry[]) => {
    for (const entry of list) {
      if (entry.type === "file") out.push(entry);
      if (entry.children) walk(entry.children);
    }
  };
  walk(entries);
  return out;
}
