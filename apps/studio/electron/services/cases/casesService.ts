import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { Document, parseDocument, parse as parseYaml } from "yaml";

import { getProjectInfo } from "../file/fileService";
import {
  getCasesDatasource,
  getQaseToken,
  setCasesDatasource,
} from "../settings/settingsService";
import { studioDir } from "../util/studioPaths";
import { fileNameFor, parseCase, writeCase } from "./caseFile";
import { QASE_OWNED, type Case, type CaseInput, type CaseMatrix, type CasesDatasource, type PullSummary } from "./model";
import { pullCases } from "./qaseSync";
import { decorate, listResults } from "./resultsService";

/** Fallback matrix dimension when the datasource names no custom field. */
const SUITE_COLUMN = "suite";

function project(): { root: string } {
  const info = getProjectInfo();
  if (!info) throw new Error("No project is open.");
  return info;
}

function casesRoot(): string {
  return studioDir("cases", project().root);
}

export function datasource(): CasesDatasource {
  return getCasesDatasource(project().root);
}

export function saveDatasource(next: CasesDatasource): CasesDatasource {
  return setCasesDatasource(project().root, next);
}

export async function listCases(): Promise<Case[]> {
  const root = casesRoot();
  if (!existsSync(root)) return [];
  const { projectCode } = datasource();
  const files = (await readdir(root)).filter((f) => /\.ya?ml$/i.test(f));
  const cases: Case[] = [];
  for (const file of files) {
    const abs = path.join(root, file);
    try {
      const raw = parseYaml(await readFile(abs, "utf8")) as Record<string, unknown>;
      const parsed = parseCase(raw, abs, projectCode);
      if (parsed) cases.push(parsed);
    } catch {
      // skip malformed case files
    }
  }
  decorate(cases, await listResults());
  return cases.sort((a, b) => a.id - b.id);
}

/**
 * Columns come from a Qase custom field — which one is the project's choice,
 * since no two Qase projects model platform the same way. Suite is the fallback.
 */
export async function buildMatrix(field?: string): Promise<CaseMatrix> {
  const cases = await listCases();
  const chosen = field ?? datasource().qase?.matrixField ?? SUITE_COLUMN;
  const valuesOf = (c: Case): string[] =>
    chosen === SUITE_COLUMN ? (c.suite ? [c.suite] : []) : (c.custom_fields[chosen] ?? []);
  const columns = [...new Set(cases.flatMap(valuesOf))].sort();
  return { field: chosen, columns, cases };
}

/** Every custom field any case carries — the options for the column picker. */
export async function matrixFields(): Promise<string[]> {
  const cases = await listCases();
  return [SUITE_COLUMN, ...new Set(cases.flatMap((c) => Object.keys(c.custom_fields)))].sort();
}

// ── Authoring ───────────────────────────────────────────────────────────────

async function fileForId(id: number): Promise<string | null> {
  const root = casesRoot();
  if (!existsSync(root)) return null;
  for (const file of await readdir(root)) {
    if (!/\.ya?ml$/i.test(file)) continue;
    try {
      const raw = parseYaml(await readFile(path.join(root, file), "utf8")) as Record<string, unknown>;
      if (Number(raw?.id) === id) return path.join(root, file);
    } catch {
      // malformed files can't own an id
    }
  }
  return null;
}

/** Next free id in local mode, so a hand-authored case doesn't need one picked. */
export async function nextLocalId(): Promise<number> {
  const cases = await listCases();
  return cases.reduce((max, c) => Math.max(max, c.id), 0) + 1;
}

/**
 * Write a case, editing the existing file in place when there is one — through
 * yaml's Document API, so comments and key order in a hand-written case survive
 * a round trip through the editor.
 *
 * In `qase` mode the Qase-owned fields are refused rather than written: Qase is
 * the source of truth, and the next pull would revert the edit anyway.
 */
export async function saveCase(input: CaseInput): Promise<Case> {
  const config = datasource();
  if (!input.title?.trim()) throw new Error("A case needs a title.");
  if (!Number.isFinite(input.id)) throw new Error("A case needs a numeric id.");

  const previous = input.previousId ?? input.id;
  const existingPath = await fileForId(previous);

  if (config.mode === "qase" && existingPath) {
    const current = parseCase(
      parseYaml(await readFile(existingPath, "utf8")) as Record<string, unknown>,
      existingPath,
      config.projectCode,
    );
    const changed = QASE_OWNED.filter(
      (key) =>
        input[key] !== undefined &&
        JSON.stringify(input[key]) !== JSON.stringify(current?.[key as keyof Case]),
    );
    if (changed.length) {
      throw new Error(
        `${changed.join(", ")} ${changed.length > 1 ? "are" : "is"} owned by Qase — edit the case in Qase, then sync.`,
      );
    }
  }

  const clash = await fileForId(input.id);
  if (clash && previous !== input.id) throw new Error(`Case id ${input.id} is already taken.`);

  const doc = existingPath ? parseDocument(await readFile(existingPath, "utf8")) : new Document({});
  const base = existingPath
    ? parseCase(
        parseYaml(await readFile(existingPath, "utf8")) as Record<string, unknown>,
        existingPath,
        config.projectCode,
      )
    : null;

  const ref = `${config.projectCode}-${input.id}`;
  const merged: Case = {
    ...(base ?? {
      status: "actual",
      is_manual: true,
      custom_fields: {},
      tags: [],
      steps_type: "classic",
    }),
    id: input.id,
    ref,
    title: input.title.trim(),
    description: input.description?.trim() || undefined,
    preconditions: input.preconditions?.trim() || undefined,
    postconditions: input.postconditions?.trim() || undefined,
    severity: input.severity ?? base?.severity,
    priority: input.priority ?? base?.priority,
    type: input.type ?? base?.type,
    behavior: input.behavior ?? base?.behavior,
    status: input.status ?? base?.status ?? "actual",
    is_manual: input.is_manual ?? base?.is_manual ?? true,
    suite_id: input.suite_id ?? base?.suite_id,
    steps: input.steps ?? base?.steps,
    custom_fields: input.custom_fields ?? base?.custom_fields ?? {},
    tags: input.tags ?? base?.tags ?? [],
    conductor: input.conductor ?? base?.conductor,
    filePath: existingPath ?? "",
  };

  writeCase(doc, merged);

  const root = casesRoot();
  await mkdir(root, { recursive: true });
  const target = path.join(root, fileNameFor(ref, merged.title));
  await writeFile(existingPath ?? target, doc.toString({ lineWidth: 0 }), "utf8");
  if (existingPath && path.resolve(existingPath) !== path.resolve(target)) {
    await rename(existingPath, target);
  }

  const saved = (await listCases()).find((c) => c.id === input.id);
  if (!saved) throw new Error("Case was written but could not be read back.");
  return saved;
}

/** A case as editable input — the basis for "change one field, keep the rest". */
export function toInput(c: Case): CaseInput {
  return {
    id: c.id,
    previousId: c.id,
    title: c.title,
    description: c.description,
    preconditions: c.preconditions,
    postconditions: c.postconditions,
    severity: c.severity,
    priority: c.priority,
    type: c.type,
    behavior: c.behavior,
    status: c.status,
    is_manual: c.is_manual,
    suite_id: c.suite_id,
    steps: c.steps,
    custom_fields: c.custom_fields,
    tags: c.tags,
    conductor: c.conductor,
  };
}

export async function deleteCase(id: number): Promise<void> {
  const file = await fileForId(id);
  if (!file) throw new Error(`No case with id ${id}.`);
  await rm(file);
}

// ── Sync ────────────────────────────────────────────────────────────────────

export async function pull(): Promise<PullSummary> {
  const root = project().root;
  const config = getCasesDatasource(root);
  if (config.mode !== "qase") throw new Error("This project's cases are local — nothing to pull.");
  const token = getQaseToken(root);
  if (!token) throw new Error("No Qase API token is set for this project.");

  const summary = await pullCases({
    casesDir: casesRoot(),
    projectCode: config.projectCode,
    token,
    suiteIds: config.qase?.suiteIds,
  });
  setCasesDatasource(root, {
    ...config,
    qase: { ...config.qase, lastPulledAt: Date.now() },
  });
  return summary;
}
