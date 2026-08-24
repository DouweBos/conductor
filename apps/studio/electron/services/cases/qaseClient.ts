/**
 * Qase API v1 client. Deliberately free of Electron imports so it stays
 * testable as plain Node.
 */

const BASE = "https://api.qase.io/v1";
const PAGE = 100;
const TIMEOUT_MS = 15_000;

export interface QaseStep {
  hash?: string;
  action?: string;
  data?: string | null;
  expected_result?: string | null;
}

export interface QaseCase {
  id: number;
  title: string;
  description?: string | null;
  preconditions?: string | null;
  postconditions?: string | null;
  severity?: number;
  priority?: number;
  type?: number;
  behavior?: number;
  status?: number;
  is_manual?: boolean;
  isManual?: boolean;
  suite_id?: number | null;
  milestone_id?: number | null;
  steps_type?: string | null;
  steps?: QaseStep[];
  custom_fields?: { id: number; value: string }[];
  tags?: { title: string }[];
  external_issues?: { link?: string; id?: string }[];
  author_id?: number;
  created_at?: string;
  updated_at?: string;
}

export interface QaseSuite {
  id: number;
  title: string;
}

export interface QaseCustomField {
  id: number;
  title: string;
}

interface Envelope<T> {
  status: boolean;
  result?: { total?: number; entities?: T[] } & Record<string, unknown>;
  errorMessage?: string;
}

/** Qase returns 429 under load and the odd 5xx; one retry covers both. */
async function request<T>(path: string, token: string): Promise<Envelope<T>> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(`${BASE}${path}`, {
        headers: { Token: token, Accept: "application/json" },
        signal: controller.signal,
      });
      if ((response.status === 429 || response.status >= 500) && attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        throw new Error("Qase rejected the API token.");
      }
      if (!response.ok) {
        throw new Error(`Qase responded ${response.status} for ${path}`);
      }
      return (await response.json()) as Envelope<T>;
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      if (attempt === 0 && aborted) continue;
      throw aborted ? new Error(`Qase request timed out: ${path}`) : error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`Qase request failed: ${path}`);
}

async function paged<T>(path: string, token: string): Promise<T[]> {
  const all: T[] = [];
  let offset = 0;
  for (;;) {
    const join = path.includes("?") ? "&" : "?";
    const page = await request<T>(`${path}${join}limit=${PAGE}&offset=${offset}`, token);
    const entities = page.result?.entities ?? [];
    all.push(...entities);
    offset += PAGE;
    const total = page.result?.total ?? all.length;
    if (entities.length === 0 || offset >= total) break;
  }
  return all;
}

export interface QaseProject {
  code: string;
  title: string;
}

/** Every project the token can see — powers the project picker. */
export async function listProjects(token: string): Promise<QaseProject[]> {
  return paged<QaseProject>("/project", token);
}

/** Validates the token and that the project code exists. */
export async function verifyProject(code: string, token: string): Promise<string> {
  const response = await request<never>(`/project/${encodeURIComponent(code)}`, token);
  const title = (response.result as { title?: string } | undefined)?.title;
  if (!title) throw new Error(`Qase has no project "${code}".`);
  return title;
}

export async function listCases(
  code: string,
  token: string,
  suiteIds?: number[],
): Promise<QaseCase[]> {
  const project = encodeURIComponent(code);
  // The API filters by one suite at a time, so several suites means several passes.
  if (suiteIds?.length) {
    const seen = new Map<number, QaseCase>();
    for (const suiteId of suiteIds) {
      for (const c of await paged<QaseCase>(
        `/case/${project}?include=external_issues&suite_id=${suiteId}`,
        token,
      )) {
        seen.set(c.id, c);
      }
    }
    return [...seen.values()];
  }
  return paged<QaseCase>(`/case/${project}?include=external_issues`, token);
}

export async function listSuites(code: string, token: string): Promise<QaseSuite[]> {
  return paged<QaseSuite>(`/suite/${encodeURIComponent(code)}`, token);
}

export async function listCustomFields(code: string, token: string): Promise<QaseCustomField[]> {
  // Custom fields are workspace-wide, not per project, but the entity carries
  // only field ids — without these the values have no titles to key on.
  void code;
  return paged<QaseCustomField>(`/custom_field`, token);
}
