/**
 * The test case model — Qase's, deliberately.
 *
 * Field names, enums and step shape mirror the Qase v1 case entity so a pulled
 * case needs no translation layer. The one addition Qase has no concept of is
 * the `conductor` block: which flow file automates a case.
 */

// ── Qase enums ──────────────────────────────────────────────────────────────
// Qase encodes these as integers. The tables below are ordered to match the
// integer values, and are the same lists its API filter docs enumerate.

export const SEVERITIES = [
  "undefined",
  "blocker",
  "critical",
  "major",
  "normal",
  "minor",
  "trivial",
] as const;
export const PRIORITIES = ["undefined", "high", "medium", "low"] as const;
export const CASE_TYPES = [
  "other",
  "functional",
  "smoke",
  "regression",
  "security",
  "usability",
  "performance",
  "acceptance",
] as const;
export const BEHAVIORS = ["undefined", "positive", "negative", "destructive"] as const;
export const CASE_STATUSES = ["actual", "draft", "deprecated"] as const;

export type Severity = (typeof SEVERITIES)[number];
export type Priority = (typeof PRIORITIES)[number];
export type CaseType = (typeof CASE_TYPES)[number];
export type Behavior = (typeof BEHAVIORS)[number];
export type CaseStatus = (typeof CASE_STATUSES)[number];
export type StepsType = "classic" | "gherkin";

/**
 * Decode a Qase integer to its name. Returns undefined for a value Qase has
 * added since — better an absent field than a confidently wrong one.
 */
export function decodeEnum<T extends string>(
  table: readonly T[],
  value: unknown,
): T | undefined {
  if (typeof value === "number") return table[value];
  if (typeof value === "string" && (table as readonly string[]).includes(value)) return value as T;
  return undefined;
}

export function encodeEnum<T extends string>(table: readonly T[], name: T | undefined): number | undefined {
  if (!name) return undefined;
  const index = (table as readonly string[]).indexOf(name);
  return index >= 0 ? index : undefined;
}

// ── Cases ───────────────────────────────────────────────────────────────────

/** One page object performing part of a step, relative to the flows dir. */
export interface StepPomCall {
  pom: string;
  /** Values for that page object's `env:` parameters. */
  env?: Record<string, string>;
}

/**
 * One step, in Qase's action/data/expected_result shape. `poms` is Conductor's:
 * the page objects that perform the step, merged in on read rather than stored
 * on the case. A step regularly bundles several actions ("go to the page and
 * press play"), so it takes a list, in the order they run.
 */
export interface CaseStep {
  /** Qase's stable per-step identity, used to re-attach `poms` across a pull. */
  hash?: string;
  action: string;
  data?: string;
  expected_result?: string;
  poms?: StepPomCall[];
}

export interface Case {
  /** Qase's numeric case id. */
  id: number;
  /** `DEMO-12` — how Qase refers to a case, and how everything here does too. */
  ref: string;
  title: string;
  description?: string;
  preconditions?: string;
  postconditions?: string;
  severity?: Severity;
  priority?: Priority;
  type?: CaseType;
  behavior?: Behavior;
  status: CaseStatus;
  is_manual: boolean;
  suite_id?: number;
  /** Suite title, resolved on pull so the matrix can band by it. */
  suite?: string;
  /** Its suites root-first — Qase nests them, and the sidebar is that tree. */
  suite_path?: string[];
  milestone_id?: number;
  steps_type?: StepsType;
  steps?: CaseStep[];
  /** Custom field title -> values. Multi-selects keep every value. */
  custom_fields: Record<string, string[]>;
  tags: string[];
  external_issues?: string[];
  author_id?: number;
  created_at?: string;
  updated_at?: string;

  // Local decorations, not part of Qase's entity.
  /** Flows whose `properties.testCaseId` names this case, with their tags. */
  flows?: { path: string; tags: string[] }[];
}

export interface CaseMatrix {
  /** Custom field (or "suite") whose values form the columns. */
  field: string;
  columns: string[];
  cases: Case[];
}

// ── Qase projects ───────────────────────────────────────────────────────────

/**
 * A Qase project Studio reads cases from. Which project a case belongs to is
 * read off its ref (`MC-12` is MC's), so this is only what Studio needs to
 * fetch and display them — there is nothing to configure per repo beyond a
 * token, and nothing to keep in step with the flows.
 */
export interface QaseProject {
  /** Project code, upper case: `MC`. */
  code: string;
  /** Custom field whose values form the matrix columns; "suite" as fallback. */
  matrixField?: string;
  /** True when a token is stored for it (never the token itself). */
  hasToken?: boolean;
  /** When its cases were last fetched. */
  fetchedAt?: number;
}

/** What one refresh fetched, per Qase project. */
/** The Qase project a ref belongs to: `MC-12` is MC's. */
export function codeOf(ref: string): string | null {
  return /^([A-Za-z][A-Za-z0-9_]*)-\d+$/.exec(ref.trim())?.[1]?.toUpperCase() ?? null;
}

export interface RefreshSummary {
  code: string;
  cases: number;
  fetchedAt: number;
}
