import {
  snippetCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";

import { COMMANDS, COMMANDS_BY_NAME, HEADER_KEYS, paramsFor } from "./maestroSchema";
import type { FlowCatalog, FlowCatalogEntry } from "./types";

/**
 * Autocomplete for Maestro flow YAML: commands and callable subflows where a
 * step goes, a command's parameters inside its block, file paths in the
 * parameters that take one, and env variables inside `${…}`. Everything is
 * driven off indentation, which is all the structure a half-typed flow has.
 */

export interface CompletionSources {
  /** Env names the project defines outside this file. */
  envNames: () => string[];
  /** Subflows and scripts this flow can call. */
  catalog: () => FlowCatalog;
  /** Path of the flow being edited, relative to the flows directory. */
  currentPath: () => string | undefined;
}

/** Parameters whose value is a path into the flows directory. */
const PATH_PARAMS = new Set(["file", "files", "path", "script"]);
/** Token characters in a path or alias, so completion starts at its beginning. */
const PATH_TOKEN = /^[@\w./-]*$/;

const indentOf = (line: string) => line.length - line.trimStart().length;

/** Command owning the block the cursor sits in, by walking up to a shallower list item. */
function enclosingCommand(lines: string[], row: number, indent: number): string | null {
  for (let i = row - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.trim()) continue;
    const at = indentOf(line);
    if (at >= indent) continue;
    const match = /^-\s+([A-Za-z]\w*):/.exec(line.trim());
    return match ? match[1] : null;
  }
  return null;
}

/** Names declared in the document: `env:` keys and every `${VAR}` already used. */
function documentEnvNames(doc: string): string[] {
  const names = new Set<string>();
  const lines = doc.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*env:\s*$/.test(lines[i])) continue;
    const blockIndent = indentOf(lines[i]);
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (!line.trim()) continue;
      if (indentOf(line) <= blockIndent) break;
      const key = /^([A-Za-z_]\w*)\s*:/.exec(line.trim());
      if (key) names.add(key[1]);
    }
  }
  for (const match of doc.matchAll(/\$\{\s*([A-Za-z_]\w*)/g)) names.add(match[1]);
  return [...names];
}

const commandOptions = (dash: string): Completion[] =>
  COMMANDS.map((c) => ({
    label: c.name,
    type: "keyword",
    detail: c.doc,
    // Selector commands read best inline; the rest open a block.
    apply: dash + (c.selector ? `${c.name}: ` : `${c.name}:\n    `),
  }));

const headerOptions: Completion[] = HEADER_KEYS.map((k) => ({
  label: k.name,
  type: "property",
  detail: k.detail,
  apply: `${k.name}: `,
}));

/** How a flow refers to another file: its alias when it has one, else relative. */
function reference(entry: FlowCatalogEntry, currentPath?: string): string {
  return entry.alias ?? relativeTo(entry.path, currentPath);
}

function relativeTo(target: string, currentPath?: string): string {
  const fromDir = currentPath ? currentPath.split("/").slice(0, -1) : [];
  const to = target.split("/");
  let shared = 0;
  while (shared < fromDir.length && shared < to.length - 1 && fromDir[shared] === to[shared]) shared++;
  const up: string[] = Array(fromDir.length - shared).fill("..");
  const joined = [...up, ...to.slice(shared)].join("/");
  return up.length === 0 ? `./${joined}` : joined;
}

/**
 * A subflow as a ready-made step: `runFlow` with the file filled in, and — when
 * the subflow declares parameters — the `env:` block it needs, cursor waiting in
 * the first value. Chaining subflows is how a POM suite is written, so this is
 * the completion that matters most.
 */
export function callSnippet(entry: FlowCatalogEntry, dash: string, currentPath?: string): string {
  const ref = reference(entry, currentPath);
  if (entry.kind === "script") return `${dash}runScript: "${ref}"`;
  if (entry.params.length === 0) return `${dash}runFlow: "${ref}"`;
  // `${}` is an empty snippet field: tab jumps from one value to the next.
  const env = entry.params.map((p) => `      ${p}: \${}`).join("\n");
  return `${dash}runFlow:\n    file: "${ref}"\n    env:\n${env}\n`;
}

function subflowOption(entry: FlowCatalogEntry, dash: string, currentPath?: string): Completion {
  return snippetCompletion(callSnippet(entry, dash, currentPath), {
    label: entry.alias ?? entry.path,
    type: "function",
    detail:
      entry.kind === "script"
        ? "script"
        : entry.params.length
          ? `subflow · env: ${entry.params.join(", ")}`
          : "subflow",
  });
}

/** Every way to refer to a callable file, alias and relative alike. */
function pathOptions(
  catalog: FlowCatalog,
  kind: FlowCatalogEntry["kind"] | null,
  currentPath?: string,
): Completion[] {
  const options: Completion[] = [];
  for (const entry of catalog.entries) {
    if (kind && entry.kind !== kind) continue;
    const refs = new Set([entry.alias, relativeTo(entry.path, currentPath)].filter(Boolean) as string[]);
    for (const ref of refs) {
      options.push({
        label: ref,
        type: "file",
        detail: entry.params.length ? `env: ${entry.params.join(", ")}` : entry.kind,
      });
    }
  }
  return options;
}

export function maestroCompletion(sources: CompletionSources) {
  return (context: CompletionContext): CompletionResult | null => {
    const doc = context.state.doc.toString();
    const line = context.state.doc.lineAt(context.pos);
    const before = context.state.sliceDoc(line.from, context.pos);
    const lines = doc.split(/\r?\n/);
    const row = line.number - 1;

    // ${ENV_VAR} — anywhere, including inside a quoted string.
    const envMatch = /\$\{\s*([A-Za-z_]\w*)?$/.exec(before);
    if (envMatch) {
      // Scan the document with the half-typed `${…` removed, so the fragment
      // under the cursor doesn't come back as a suggestion.
      const start = context.pos - envMatch[0].length;
      const scanned = doc.slice(0, start) + doc.slice(context.pos);
      const names = new Set([...documentEnvNames(scanned), ...sources.envNames()]);
      if (names.size === 0) return null;
      return {
        from: context.pos - (envMatch[1]?.length ?? 0),
        options: [...names].sort().map((name) => ({ label: name, type: "variable", detail: "env" })),
        validFor: /^\w*$/,
      };
    }

    // A path value: `file: @pages/…`, `script: ./helpers/…`.
    const pathValue = /(?:^|\s)-?\s*([A-Za-z]\w*):\s+"?([@\w./-]*)$/.exec(before);
    if (pathValue && PATH_PARAMS.has(pathValue[1])) {
      const command = enclosingCommand(lines, row, indentOf(before));
      const kind = command === "runScript" ? "script" : command === "runFlow" ? "flow" : null;
      const options = pathOptions(sources.catalog(), kind, sources.currentPath());
      if (options.length === 0) return null;
      return { from: context.pos - pathValue[2].length, options, validFor: PATH_TOKEN };
    }

    const trimmed = before.trimStart();
    const separator = doc.indexOf("\n---");
    const inHeader = separator !== -1 && context.pos <= separator;

    // A step: "- ", "- ta|", or a bare path typed at the start of a line.
    const step = /^(-\s*)?([@\w./-]*)$/.exec(trimmed);
    if (step && !inHeader && indentOf(before) === 0 && (step[1] || step[2] || context.explicit)) {
      const dash = step[1] ? "" : "- ";
      const typed = step[2];
      if (!context.explicit && !step[1] && !typed) return null;
      const catalog = sources.catalog();
      const currentPath = sources.currentPath();
      return {
        from: context.pos - typed.length,
        options: [
          ...commandOptions(dash),
          ...catalog.entries
            .filter((e) => e.path !== currentPath)
            .map((e) => subflowOption(e, dash, currentPath)),
        ],
        validFor: PATH_TOKEN,
      };
    }

    const word = /([A-Za-z]\w*)?$/.exec(before);
    const from = context.pos - (word?.[1]?.length ?? 0);
    const typed = word?.[1] ?? "";
    // Only complete at the end of a key — never inside a value.
    if (/:\s.*$/.test(before.slice(0, before.length - typed.length))) return null;
    if (!context.explicit && !typed) return null;

    // A bare key inside a command's block → that command's parameters.
    if (/^[A-Za-z]*$/.test(trimmed)) {
      const command = enclosingCommand(lines, row, indentOf(before));
      const def = command ? COMMANDS_BY_NAME.get(command) : null;
      if (def) {
        return {
          from,
          options: paramsFor(def).map((p) => ({
            label: p.name,
            type: "property",
            detail: p.detail,
            apply: `${p.name}: `,
          })),
          validFor: /^\w*$/,
        };
      }
      // Above the `---`, the header keys are what's on offer.
      if (inHeader || separator === -1) {
        return { from, options: headerOptions, validFor: /^\w*$/ };
      }
    }
    return null;
  };
}
