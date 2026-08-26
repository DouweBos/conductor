import { getProjectInfo } from "../file/fileService";
import {
  getQaseProjects,
  getQaseToken,
  saveQaseProject,
} from "../settings/settingsService";
import { cached, codeOf, forget, refresh } from "./caseCache";
import { linksByCase } from "./coverage";
import type { Case, CaseMatrix, QaseProject, RefreshSummary } from "./model";
import { decorate, listResults } from "./resultsService";
import { stepPoms } from "./stepPoms";

/**
 * The cases a repo's flows are written against.
 *
 * Qase owns them; Studio reads them into a cache and never writes back. What a
 * case is automated by is not stored here either — a flow declares the case it
 * covers in its own `properties.testCaseId`, so coverage is answered by
 * reading the repo.
 */

/** Fallback matrix dimension when the project names no custom field. */
const SUITE_COLUMN = "suite";

function repoRoot(): string {
  const info = getProjectInfo();
  if (!info) throw new Error("No project is open.");
  return info.root;
}

export function projects(): QaseProject[] {
  return getQaseProjects(repoRoot());
}

export function saveProject(project: QaseProject): QaseProject[] {
  return saveQaseProject(repoRoot(), project);
}

/**
 * Every case Studio knows about, with the flows that cover it and the results
 * recorded against it. Reads the cache — `refreshCases` is what talks to Qase.
 */
export async function listCases(): Promise<Case[]> {
  const byCase = await linksByCase();
  const poms = await stepPoms();
  const cases: Case[] = [];

  for (const project of projects()) {
    const store = await cached(project.code);
    for (const testCase of store?.cases ?? []) {
      const assigned = poms[testCase.ref];
      cases.push({
        ...testCase,
        // A step's page object is Studio's, not Qase's, so it is merged in
        // rather than stored on the case.
        steps: testCase.steps?.map((step, index) => ({
          ...step,
          ...(assigned?.[step.hash ?? String(index)] ?? {}),
        })),
        flows: (byCase.get(testCase.ref) ?? []).map(({ path, tags }) => ({ path, tags })),
      });
    }
  }

  decorate(cases, await listResults());
  return cases.sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }));
}

/**
 * Columns come from a Qase custom field — which one is the project's choice,
 * since no two Qase projects model platform the same way. Suite is the fallback.
 */
export async function buildMatrix(field?: string): Promise<CaseMatrix> {
  const cases = await listCases();
  const chosen = field ?? projects().find((p) => p.matrixField)?.matrixField ?? SUITE_COLUMN;
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

/**
 * The flow that covers a case for one matrix column: the declaring flow whose
 * tags include the column. A case covered by a single flow needs no tag — one
 * flow, one implementation, whatever the column.
 */
export function flowFor(testCase: Case, column?: string): string | undefined {
  const flows = testCase.flows ?? [];
  if (!column) return flows[0]?.path;
  const tagged = flows.find((f) => f.tags.some((t) => t.replace(/-draft$/, "") === column));
  return tagged?.path ?? (flows.length === 1 ? flows[0].path : undefined);
}

// ── Fetching ────────────────────────────────────────────────────────────────

/** Pull one project's cases from Qase into the cache, or every project's. */
export async function refreshCases(code?: string): Promise<RefreshSummary[]> {
  const root = repoRoot();
  const targets = code
    ? projects().filter((p) => p.code === code.toUpperCase())
    : projects();
  if (!targets.length) throw new Error("No Qase project is configured for this repo.");

  const summaries: RefreshSummary[] = [];
  for (const project of targets) {
    const token = getQaseToken(root, project.code);
    if (!token) throw new Error(`No Qase API token is set for ${project.code}.`);
    const store = await refresh(project.code, token);
    saveQaseProject(root, { ...project, fetchedAt: store.fetchedAt });
    summaries.push({ code: store.code, cases: store.cases.length, fetchedAt: store.fetchedAt });
  }
  return summaries;
}

/** Drop a project and the cases cached for it. */
export async function forgetProject(code: string): Promise<QaseProject[]> {
  await forget(code);
  const { deleteQaseProject } = await import("../settings/settingsService");
  return deleteQaseProject(repoRoot(), code);
}

/** Codes the repo's flows reference, so a project can be offered rather than typed. */
export async function referencedCodes(): Promise<string[]> {
  const codes = new Set<string>();
  for (const refs of (await linksByCase()).keys()) {
    const code = codeOf(refs);
    if (code) codes.add(code);
  }
  return [...codes].sort();
}
