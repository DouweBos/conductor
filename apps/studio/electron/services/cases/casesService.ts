import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { Document, isMap, isSeq, parseDocument, parse as parseYaml } from "yaml";

import type { CaseMatrix, CaseStep, TestCase, TestCaseInput } from "../../../app/lib/types";
import { getProjectInfo } from "../file/fileService";
import { studioDir } from "../util/studioPaths";
import { decorate, listResults } from "./resultsService";

const DEFAULT_DIMENSION = "platform";
/** Legacy location: cases used to be written into the repo under test. */
const IN_REPO = "test-cases";

function casesRoot(): string {
  const project = getProjectInfo();
  if (!project) throw new Error("No project is open.");
  return studioDir("cases", project.root);
}

export async function listCases(): Promise<TestCase[]> {
  const root = casesRoot();
  await adoptRepoCases(root);
  if (!existsSync(root)) return [];
  const files = (await readdir(root)).filter((f) => /\.(ya?ml)$/i.test(f));
  const cases: TestCase[] = [];
  for (const file of files) {
    const abs = path.join(root, file);
    try {
      const raw = parseYaml(await readFile(abs, "utf8")) as Record<string, unknown>;
      const parsed = normalizeCase(raw, abs);
      if (parsed) cases.push(parsed);
    } catch {
      // skip malformed case files
    }
  }
  // Executions come from the local results log — the only source of truth now.
  decorate(cases, await listResults());
  return cases.sort((a, b) => a.id.localeCompare(b.id));
}

function normalizeCase(raw: Record<string, unknown>, filePath: string): TestCase | null {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id ?? "").trim();
  const title = String(raw.title ?? "").trim();
  if (!id || !title) return null;

  // One case can carry several matrix ids — the TV and mobile rows of the same
  // user story are one case here, but CI job names still use either id.
  const altIds = Array.isArray(raw.altIds) ? raw.altIds.map(String).filter(Boolean) : undefined;

  const flows: Record<string, string> = {};
  if (raw.flows && typeof raw.flows === "object") {
    for (const [key, value] of Object.entries(raw.flows as Record<string, unknown>)) {
      if (value) flows[key] = String(value);
    }
  }

  const tags: Record<string, string[]> = {};
  if (raw.tags && typeof raw.tags === "object") {
    for (const [dim, value] of Object.entries(raw.tags as Record<string, unknown>)) {
      tags[dim] = Array.isArray(value) ? value.map(String) : [String(value)];
    }
  }
  return {
    id,
    title,
    description: raw.description ? String(raw.description) : undefined,
    userStory: raw.userStory ? String(raw.userStory) : undefined,
    tags,
    altIds: altIds?.length ? altIds : undefined,
    owner: raw.owner ? String(raw.owner) : undefined,
    state: raw.state ? String(raw.state) : undefined,
    links: Array.isArray(raw.links) ? raw.links.map(String).filter(Boolean) : undefined,
    preconditions: stringList(raw.preconditions),
    postconditions: stringList(raw.postconditions),
    steps: normalizeSteps(raw.steps),
    flow: raw.flow ? String(raw.flow) : undefined,
    flows: Object.keys(flows).length ? flows : undefined,
    filePath,
  };
}

function stringList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const list = raw.map(String).map((v) => v.trim()).filter(Boolean);
  return list.length ? list : undefined;
}

/** Steps may be plain strings (`- Open the app`) or the action/expected form. */
function normalizeSteps(raw: unknown): CaseStep[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const steps: CaseStep[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      if (item.trim()) steps.push({ action: item.trim() });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const action = String(row.action ?? row.step ?? "").trim();
    if (!action) continue;
    const env: Record<string, string> = {};
    if (row.env && typeof row.env === "object") {
      for (const [k, v] of Object.entries(row.env as Record<string, unknown>)) env[k] = String(v);
    }
    steps.push({
      action,
      data: row.data ? String(row.data) : undefined,
      expected: row.expected ? String(row.expected) : undefined,
      pom: row.pom ? String(row.pom) : undefined,
      env: Object.keys(env).length ? env : undefined,
    });
  }
  return steps.length ? steps : undefined;
}

/**
 * One-time pickup of cases an earlier version wrote into the repo. Copied, not
 * moved: the repo's copy is left exactly as it was for the user to delete (or
 * keep) themselves.
 */
async function adoptRepoCases(root: string): Promise<void> {
  const project = getProjectInfo();
  if (!project || existsSync(root)) return;
  const legacy = path.join(project.root, IN_REPO);
  if (!existsSync(legacy)) return;
  await mkdir(root, { recursive: true });
  for (const file of (await readdir(legacy)).filter((f) => /\.(ya?ml)$/i.test(f))) {
    await copyFile(path.join(legacy, file), path.join(root, file));
  }
}

export async function buildMatrix(dimension = DEFAULT_DIMENSION): Promise<CaseMatrix> {
  const cases = await listCases();
  const columns = [
    ...new Set(cases.flatMap((c) => c.tags[dimension] ?? [])),
  ].sort();
  return { dimension, columns, cases };
}

// ── Authoring ───────────────────────────────────────────────────────────────

/** `DT-1 Can I …?` -> `DT-1-can-i.yaml`, matching what the importer writes. */
function fileNameFor(id: string, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60)
    .replace(/-$/, "");
  return `${id}${slug ? `-${slug}` : ""}.yaml`;
}

async function fileForId(id: string): Promise<string | null> {
  const root = casesRoot();
  if (!existsSync(root)) return null;
  for (const file of await readdir(root)) {
    if (!/\.(ya?ml)$/i.test(file)) continue;
    try {
      const raw = parseYaml(await readFile(path.join(root, file), "utf8")) as Record<string, unknown>;
      if (String(raw?.id ?? "").trim() === id) return path.join(root, file);
    } catch {
      // malformed files can't own an id
    }
  }
  return null;
}

const CLEARABLE = [
  "altIds",
  "description",
  "userStory",
  "flow",
  "flows",
  "owner",
  "links",
  "state",
  "steps",
  "preconditions",
  "postconditions",
];

/**
 * Keep id and tag lists on one line (`platform: [tv, mobile]`) — the default
 * block style turns a compact case file into a page of bullets on every save.
 */
function compact(doc: Document, key: string, value: unknown): unknown {
  if (key === "altIds" || key === "links") {
    const node = doc.createNode(value);
    if (isSeq(node)) node.flow = true;
    return node;
  }
  if (key !== "tags") return value;
  const node = doc.createNode(value);
  if (isMap(node)) {
    for (const item of node.items) {
      if (isSeq(item.value)) item.value.flow = true;
    }
  }
  return node;
}

/**
 * Write a case, editing the existing file in place when there is one — through
 * yaml's Document API, so comments and key order in a hand-written case survive
 * a round trip through the editor.
 */
export async function saveCase(input: TestCaseInput): Promise<TestCase> {
  const id = input.id.trim();
  if (!id) throw new Error("A case needs an id.");
  if (!input.title.trim()) throw new Error("A case needs a title.");

  const previous = (input.previousId ?? id).trim();
  const clash = await fileForId(id);
  // previousId is what makes this an edit; without it, an existing id is a
  // collision rather than an invitation to overwrite someone else's case.
  if (clash && (!input.previousId || (previous !== id && clash))) {
    throw new Error(`Case id "${id}" is already taken.`);
  }
  const existingPath = previous === id ? clash : await fileForId(previous);

  const doc = existingPath
    ? parseDocument(await readFile(existingPath, "utf8"))
    : new Document({});
  doc.set("id", id);
  doc.set("title", input.title.trim());
  const optional: Record<string, unknown> = {
    altIds: input.altIds?.length ? input.altIds : undefined,
    userStory: input.userStory?.trim() || undefined,
    description: input.description?.trim() || undefined,
    tags: Object.fromEntries(
      Object.entries(input.tags ?? {}).filter(([, values]) => values.length),
    ),
    owner: input.owner?.trim() || undefined,
    state: input.state?.trim() || undefined,
    links: input.links?.length ? input.links : undefined,
    flow: input.flow?.trim() || undefined,
    flows: Object.keys(input.flows ?? {}).length ? input.flows : undefined,
    preconditions: input.preconditions?.length ? input.preconditions : undefined,
    postconditions: input.postconditions?.length ? input.postconditions : undefined,
    steps: input.steps?.length
      ? input.steps.map((step) => ({
          action: step.action,
          ...(step.data ? { data: step.data } : {}),
          ...(step.expected ? { expected: step.expected } : {}),
          ...(step.pom ? { pom: step.pom } : {}),
          ...(step.env && Object.keys(step.env).length ? { env: step.env } : {}),
        }))
      : undefined,
  };
  for (const [key, value] of Object.entries(optional)) {
    if (value === undefined || (key === "tags" && !Object.keys(value as object).length)) {
      if (CLEARABLE.includes(key)) doc.delete(key);
      continue;
    }
    doc.set(key, compact(doc, key, value));
  }

  const root = casesRoot();
  await mkdir(root, { recursive: true });
  const target = path.join(root, fileNameFor(id, input.title));
  await writeFile(existingPath ?? target, doc.toString({ lineWidth: 0 }), "utf8");
  // Keep the filename in step with the id/title it now carries.
  if (existingPath && path.resolve(existingPath) !== path.resolve(target)) {
    await rename(existingPath, target);
  }

  const saved = (await listCases()).find((c) => c.id === id);
  if (!saved) throw new Error("Case was written but could not be read back.");
  return saved;
}

/** A case as editable input — the basis for "change one field, keep the rest". */
export function toInput(c: TestCase): TestCaseInput {
  return {
    id: c.id,
    previousId: c.id,
    altIds: c.altIds,
    title: c.title,
    description: c.description,
    userStory: c.userStory,
    tags: c.tags,
    owner: c.owner,
    state: c.state,
    links: c.links,
    preconditions: c.preconditions,
    postconditions: c.postconditions,
    steps: c.steps,
    flow: c.flow,
    flows: c.flows,
  };
}

export async function deleteCase(id: string): Promise<void> {
  const file = await fileForId(id);
  if (!file) throw new Error(`No case with id "${id}".`);
  await rm(file);
}
