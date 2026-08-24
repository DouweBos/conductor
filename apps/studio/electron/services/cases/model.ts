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

/** Qase's result statuses. `invalid` means the case itself was wrong. */
export const RESULT_STATUSES = ["passed", "failed", "blocked", "skipped", "invalid"] as const;
export type ResultStatus = (typeof RESULT_STATUSES)[number];

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

/**
 * One step, in Qase's action/data/expected_result shape. `pom` and `env` are
 * Conductor's: the page object that performs the step, merged in from the
 * `conductor` block on read and split back out on write.
 */
export interface CaseStep {
  /** Qase's stable per-step identity, used to re-attach `pom` across a pull. */
  hash?: string;
  action: string;
  data?: string;
  expected_result?: string;
  /** Page object implementing the step, relative to the flows dir. */
  pom?: string;
  /** Values for that page object's `env:` parameters. */
  env?: Record<string, string>;
}

/** Automation wiring. Qase has an automation *status*, but no flow reference. */
export interface ConductorBlock {
  /** Path (relative to flowsDir) of the flow implementing this case. */
  flow?: string;
  /** Per-column implementations: matrix column -> flow path. */
  flows?: Record<string, string>;
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
  conductor?: ConductorBlock;

  // Local decorations, not part of the file.
  /** Most recent execution of any kind, filled in from the results log. */
  lastResult?: CaseResult;
  /** Executions recorded for this case, newest first. */
  results?: CaseResult[];
  /** Sub-project this case belongs to, so a merged matrix can say which. */
  project?: string;
  filePath: string;
}

/** Fields a case editor may write; everything else in the file is preserved. */
export interface CaseInput {
  id: number;
  title: string;
  description?: string;
  preconditions?: string;
  postconditions?: string;
  severity?: Severity;
  priority?: Priority;
  type?: CaseType;
  behavior?: Behavior;
  status?: CaseStatus;
  is_manual?: boolean;
  suite_id?: number;
  steps?: CaseStep[];
  custom_fields?: Record<string, string[]>;
  tags?: string[];
  conductor?: ConductorBlock;
  /** Set when renumbering an existing case; absent when creating. */
  previousId?: number;
}

/** Fields Qase owns. Editing these locally in `qase` mode is refused. */
export const QASE_OWNED: (keyof CaseInput)[] = [
  "title",
  "description",
  "preconditions",
  "postconditions",
  "severity",
  "priority",
  "type",
  "behavior",
  "status",
  "is_manual",
  "suite_id",
  "steps",
  "custom_fields",
  "tags",
];

// ── Results ─────────────────────────────────────────────────────────────────

/** Per-step outcome inside one execution. */
export interface CaseStepResult {
  index: number;
  status: ResultStatus;
  comment?: string;
}

/** Where a verdict came from — automation, a person, or the agent. */
export type CaseResultSource = "run" | "manual" | "report";

/** One execution of one case, appended to the project's results log. */
export interface CaseResult {
  id: string;
  case_id: number;
  ref: string;
  status: ResultStatus;
  source: CaseResultSource;
  at: number;
  time_ms?: number;
  comment?: string;
  stacktrace?: string;
  steps?: CaseStepResult[];
  /** Column (platform) the execution covered, when the case has several. */
  column?: string;
  /** Local flow run that produced this, for the run history / artifacts. */
  run_id?: string;
  flow?: string;
  device_id?: string;
  /** Agentic report that produced this. */
  report_id?: string;
  /** Plan execution this belonged to. */
  plan_run_id?: string;
  author?: string;
  /** App build under test, read off the device, so a failure pins to one. */
  app_version?: string;
}

/** Rolled-up execution health for one case. */
export interface CaseStats {
  ref: string;
  total: number;
  passed: number;
  failed: number;
  /** Pass rate over the recorded executions, 0–1. */
  passRate: number;
  /** True when the recent runs disagree — passed and failed within the window. */
  flaky: boolean;
  lastAt?: number;
}

export interface CaseMatrix {
  /** Custom field (or "suite") whose values form the columns. */
  field: string;
  columns: string[];
  cases: Case[];
}

// ── Datasource ──────────────────────────────────────────────────────────────

/** Where a project's cases come from. Per project root, in Studio's settings. */
export interface CasesDatasource {
  mode: "local" | "qase";
  /** Prefix for case refs — the Qase project code, or anything in local mode. */
  projectCode: string;
  qase?: {
    /** Restrict the pull to these suites; all of them when empty. */
    suiteIds?: number[];
    /** Custom field whose values form the matrix columns; "suite" as fallback. */
    matrixField?: string;
    lastPulledAt?: number;
  };
  /** True when a token is stored for this project (never the token itself). */
  hasToken?: boolean;
}

export const DEFAULT_DATASOURCE: CasesDatasource = { mode: "local", projectCode: "TC" };

/**
 * A sub-project inside one repo. A monorepo often holds a mobile app and a tv
 * app, each mirroring a different Qase project, with its own cases, plans,
 * results and flows — so everything the Cases screen shows is scoped to one.
 */
export interface CaseProject {
  /** Stable id; also the directory these cases and plans live under. */
  id: string;
  name: string;
  datasource: CasesDatasource;
  /** Maestro tag its flows carry (`tv`, `mobile`) — scaffolds get it too. */
  flowTag?: string;
  /** Device its runs start on, since a tv case has no business on a phone. */
  defaultDeviceId?: string;
}

/** The "every sub-project at once" selection. Read-only: authoring needs a target. */
export const ALL_PROJECTS = "all";

/**
 * The directory a datasource's cases live in, under its sub-project: mirrored
 * cases and hand-written ones are different material and never share a store.
 * Which Qase project it mirrors is the sub-project's business, not the store's.
 */
export function datasourceKey(datasource: CasesDatasource): string {
  return datasource.mode === "qase" ? "qase" : "local";
}

/** What one pull did, surfaced in the UI and to agents rather than swallowed. */
export interface PullSummary {
  pulled: number;
  created: number;
  updated: number;
  deprecated: string[];
  /** Cases Qase returned identical to what was already stored. */
  unchanged: number;
  /** Cases in the store from another Qase project code — left untouched. */
  foreign: number;
  /** Steps whose `pom` could not be re-attached because the step changed. */
  lostPoms: { ref: string; action: string; pom: string }[];
  errors: string[];
}
