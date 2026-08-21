// Shared types across the Electron main process and the React renderer. Kept in
// sync manually (no codegen), mirroring Argus's convention. tsconfig.main.json
// includes this file so the backend can import it too.

export type Platform = "ios" | "android" | "tvos" | "web";

export interface ProjectInfo {
  root: string;
  name: string;
  /** Absolute path to the flows directory (default <root>/.maestro). */
  flowsDir: string;
  /** Every flows directory found in the repo, shallowest first. */
  flowsDirs: string[];
}

export interface FileEntry {
  path: string; // relative to flowsDir
  name: string;
  type: "file" | "dir";
  children?: FileEntry[];
}

export interface DeviceInfo {
  id: string;
  name: string;
  platform: Platform;
  state: "booted" | "shutdown" | "unknown";
  /** Who holds this device in conductor's pool, when someone does. */
  reservedBy?: string;
  /** Android reports TVs and phones alike as `android`; this tells them apart. */
  formFactor?: "tv" | "handset";
}

export interface DeviceStreamInfo {
  deviceId: string;
  platform: Platform;
  /** WebSocket URL of the conductor daemon video feed. */
  url: string;
  streamPort: number;
  codec: string;
}

export interface VideoConfig {
  codec: string;
  width: number;
  height: number;
  rotation: number;
  codecString?: string;
  avcC?: string; // base64
  sps?: string; // base64
  pps?: string; // base64
}

export interface VideoFrame {
  /** H.264 Annex B access unit bytes. */
  data: Uint8Array;
  keyFrame: boolean;
  timestamp: number;
}

export interface CaptureElement {
  ref: string; // e.g. "@e1"
  role?: string;
  text?: string;
  identifier?: string;
  /** Whether a screen reader stops here — i.e. the node had an `@eN` ref. */
  a11y?: boolean;
  /** Set when the element holds focus — the whole story on a TV. */
  focused?: boolean;
  bounds?: { x: number; y: number; width: number; height: number };
  children?: CaptureElement[];
}

export interface CaptureUiResult {
  deviceId: string;
  width: number;
  height: number;
  /** PNG screenshot as a data URL, when available. */
  screenshot?: string;
  root: CaptureElement;
}

export type FlowEngine = "maestro" | "conductor";

export interface MaestroStatus {
  /** Whether the system `maestro` binary is on PATH. */
  maestroAvailable: boolean;
  maestroVersion?: string;
  conductorAvailable: boolean;
  conductorVersion?: string;
  /** Which engine a run would use right now. */
  activeEngine: FlowEngine;
}

export interface RunOptions {
  env?: Record<string, string>;
  includeTags?: string;
  excludeTags?: string;
  /** Split the run across N devices, the way CI shards it. */
  shards?: number;
}

/** A saved set of run options — the env a suite always needs, named. */
export interface EnvProfile {
  name: string;
  env: Record<string, string>;
  includeTags?: string;
  excludeTags?: string;
}

export type FlowStepStatus = "pending" | "running" | "passed" | "failed";

export interface FlowStep {
  id: string;
  label: string;
  status: FlowStepStatus;
}

export type FlowRunStatus = "running" | "passed" | "failed" | "cancelled" | "error";

export interface FlowRun {
  runId: string;
  flowPath: string;
  engine: FlowEngine;
  status: FlowRunStatus;
  startedAt: number;
  finishedAt?: number;
}

/** One executed command from Maestro's debug output. */
export interface RunArtifactStep {
  index: number;
  label: string;
  /** COMPLETED / FAILED / SKIPPED, as maestro records it. */
  status: string;
  durationMs?: number;
  /** Absolute paths to the screen at that step. */
  screenshot?: string;
  hierarchy?: string;
}

export interface RunArtifacts {
  dir: string;
  flowName: string;
  steps: RunArtifactStep[];
  logs: string[];
}

/** A finished run, kept so failures can be compared against what came before. */
export interface RunRecord {
  runId: string;
  flowPath: string;
  engine: FlowEngine;
  status: FlowRunStatus;
  startedAt: number;
  finishedAt: number;
  deviceId?: string;
  /** Maestro's debug output directory for this run, when it wrote one. */
  artifactDir?: string;
  /** Tail of the run's output. */
  output: string[];
  /** Set when the run was one iteration of a repeat. */
  repeatGroup?: string;
}

export type LogTone = "default" | "muted" | "success" | "error" | "warning" | "command";

export interface RunLogLine {
  id: string;
  text: string;
  tone?: LogTone;
}

export interface CommandResult {
  ok: boolean;
  engine: FlowEngine;
  output: string;
}

// ── Test case management (git-tracked) ────────────────────────────────────
export interface TestCase {
  id: string;
  /** Other matrix ids for the same case — e.g. the mobile row of a TV case. */
  altIds?: string[];
  title: string;
  description?: string;
  userStory?: string;
  /** tag dimension -> values, e.g. { platform: ["ios"], vertical: ["fintech"] }. */
  tags: Record<string, string[]>;
  /** Path (relative to flowsDir) of the Maestro flow implementing this case. */
  flow?: string;
  /**
   * Per-platform implementations, when a case is covered by one flow per
   * platform: `platform` tag value -> flow path.
   */
  flows?: Record<string, string>;
  /** Who owns keeping this case true. */
  owner?: string;
  /** Requirement / ticket / spec URLs this case traces back to. */
  links?: string[];
  /** Free-form state the team drives manually, e.g. `draft` / `review` / `ready`. */
  state?: string;
  /** What must be true before the steps make sense. */
  preconditions?: string[];
  /** Cleanup the case is responsible for. */
  postconditions?: string[];
  /** Structured steps; `description` stays as the free-text form. */
  steps?: CaseStep[];
  /** Most recent execution of any kind, filled in by the results log. */
  lastResult?: CaseResult;
  /** Executions recorded for this case, newest first. */
  results?: CaseResult[];
  filePath: string; // relative to project root
}

/**
 * One human-readable step. `pom` is the bridge to automation: the page object
 * that performs this step, so a case can be scaffolded into a flow and a flow
 * can be checked against the case it claims to implement.
 */
export interface CaseStep {
  action: string;
  /** Test data the step uses, in Qase's action/data/expected shape. */
  data?: string;
  expected?: string;
  /** Page object implementing the step, relative to the flows dir. */
  pom?: string;
  /** Values for that page object's `env:` parameters. */
  env?: Record<string, string>;
}

/** Per-step outcome inside one manual execution. */
export interface CaseStepResult {
  index: number;
  status: "passed" | "failed" | "skipped";
  note?: string;
}

/** Which of a case's steps the flow behind it actually performs. */
export interface StepCoverage {
  caseId: string;
  column?: string;
  flow?: string;
  steps: { index: number; action: string; pom?: string; backed: boolean }[];
  /** Page objects the flow calls that no step accounts for. */
  extra: string[];
}

/** Fields a case editor may write; everything else in the file is preserved. */
export interface TestCaseInput {
  id: string;
  altIds?: string[];
  title: string;
  description?: string;
  userStory?: string;
  tags: Record<string, string[]>;
  flow?: string;
  flows?: Record<string, string>;
  owner?: string;
  links?: string[];
  state?: string;
  preconditions?: string[];
  postconditions?: string[];
  steps?: CaseStep[];
  /** Set when renaming an existing case; absent when creating. */
  previousId?: string;
}

export type CaseVerdict = "passed" | "failed" | "blocked" | "skipped";

/** Where a verdict came from — automation, a person, the agent, or CI. */
export type CaseResultSource = "run" | "manual" | "report" | "ci";

/** One execution of one case, appended to the project's results log. */
export interface CaseResult {
  id: string;
  caseId: string;
  /** Column (platform) the execution covered, when the case has several. */
  column?: string;
  verdict: CaseVerdict;
  source: CaseResultSource;
  at: number;
  note?: string;
  /** Local flow run that produced this, for the run history / artifacts. */
  runId?: string;
  flow?: string;
  deviceId?: string;
  /** Agentic report that produced this. */
  reportId?: string;
  /** Plan execution this belonged to. */
  planRunId?: string;
  author?: string;
  /** Per-step outcomes, when the run wizard walked the steps. */
  steps?: CaseStepResult[];
  /** App build / version under test, so a failure can be pinned to one. */
  build?: string;
  /** Environment the execution ran against, e.g. `staging`. */
  environment?: string;
}

/** Rolled-up execution health for one case. */
export interface CaseStats {
  caseId: string;
  total: number;
  passed: number;
  failed: number;
  /** Pass rate over the recorded executions, 0–1. */
  passRate: number;
  /** True when the recent runs disagree — passed and failed within the window. */
  flaky: boolean;
  lastAt?: number;
}

/** A named selection of cases to execute together. */
export interface TestPlan {
  id: string;
  name: string;
  description?: string;
  /** Explicit case ids, in execution order. */
  caseIds?: string[];
  /** Or a tag filter: dimension -> accepted values (AND across dimensions). */
  filter?: Record<string, string[]>;
  /** Only run these columns of each case; all of them when absent. */
  columns?: string[];
  filePath: string;
}

export interface TestPlanInput extends Omit<TestPlan, "filePath"> {
  previousId?: string;
}

export interface PlanRunEntry {
  caseId: string;
  title: string;
  column?: string;
  flow?: string;
  status: "pending" | "running" | "passed" | "failed" | "skipped";
  runId?: string;
}

/** One execution of a plan: every case in it, in order, with its outcome. */
export interface PlanRun {
  id: string;
  planId: string;
  planName: string;
  startedAt: number;
  finishedAt?: number;
  status: "running" | "passed" | "failed" | "cancelled";
  deviceId?: string;
  entries: PlanRunEntry[];
}

/** A parsed CSV, ready to map onto case fields. */
export interface CasePreview {
  headers: string[];
  rows: string[][];
  /** Best-guess header -> case field, which the user can correct. */
  mapping: Record<string, string>;
}

export interface ImportResult {
  created: number;
  updated: number;
  skipped: number;
  ids: string[];
}

export interface CaseMatrix {
  dimension: string; // which tag dimension forms the columns
  columns: string[];
  cases: TestCase[];
}

// ── Agentic writer (scaffolded) ───────────────────────────────────────────
/** A subflow or script a flow can call, and what it expects. */
export interface FlowCatalogEntry {
  /** Path relative to the flows directory. */
  path: string;
  /** `@alias/…` form, when a config.yaml alias covers it. */
  alias?: string;
  /** Keys of the flow's header `env:` block — its parameters. */
  params: string[];
  kind: "flow" | "script";
}

/** One flow naming another, e.g. a `runFlow: "@pages/details/open.yaml"` line. */
export interface FlowReference {
  /** Referring flow, relative to the flows directory. */
  from: string;
  /** Referenced flow, relative to the flows directory. */
  to: string;
  /** 1-based line of the reference in `from`. */
  line: number;
  text: string;
  style: "alias" | "relative";
}

/** Something wrong with a flow that we can see without running it. */
export interface LintProblem {
  /** Flow path relative to the flows directory (or a case file, repo-relative). */
  file: string;
  line: number;
  severity: "error" | "warning" | "info";
  message: string;
  text: string;
}

/** Cap on `searchFlows` results, shared so the UI can say when it truncated. */
export const FLOW_SEARCH_LIMIT = 200;

/** A scaffold for a new flow — see electron/services/flow/templates.ts. */
export interface FlowTemplate {
  id: string;
  label: string;
  /** The template's leading `#` comment. */
  description?: string;
  /** `{{placeholders}}` the caller has to answer; the automatic ones are omitted. */
  vars: string[];
  /** Shipped with Studio rather than living in the project. */
  builtIn: boolean;
}

export interface FlowSearchHit {
  path: string;
  line: number;
  text: string;
}

export interface RenameResult {
  /** Files whose references were rewritten. */
  updated: string[];
}

export interface FlowCatalog {
  entries: FlowCatalogEntry[];
  /** config.yaml `paths:` — alias -> directory, relative to the flows root. */
  aliases: Record<string, string>;
}

export interface PomEntry {
  /** Reusable Maestro subflow name (its file, relative to flowsDir). */
  path: string;
  name: string;
  /** Declared `env`/parameters the subflow accepts. */
  params: string[];
  screen?: string;
}

export interface SceneNode {
  id: string;
  /** Human label for the screen. */
  label: string;
  /** Signature derived from the capture-ui hierarchy for dedup. */
  signature: string;
}

export interface SceneEdge {
  from: string;
  to: string;
  /** The action that caused the transition (e.g. tapOn: "Login"). */
  action: string;
}

/** Identity of the app a scene graph belongs to. */
export interface AppFingerprint {
  /** Bundle id (iOS/tvOS), package name (Android), or origin (web). */
  appId: string;
  /** Display name where the platform reports one, else derived from appId. */
  appName: string;
  platform: Platform;
  /** Filename-safe `platform-appId`, the scene graph's storage key. */
  key: string;
}

export interface SceneGraph {
  version: number;
  /** The app this graph was recorded against; absent on pre-fingerprint files. */
  app?: AppFingerprint;
  nodes: SceneNode[];
  edges: SceneEdge[];
}

export interface SceneGraphSummary {
  key: string;
  app: AppFingerprint;
  screens: number;
  transitions: number;
}

// ── Updater ────────────────────────────────────────────────────────────────
export type UpdaterPhase =
  | "idle"
  | "checking"
  | "available"
  | "not-available"
  | "downloading"
  | "downloaded"
  | "error";

export interface UpdaterState {
  phase: UpdaterPhase;
  version?: string;
  progress?: number;
  error?: string;
}

export type ThemePreference = "light" | "dark" | "system";

// ── Conductor CLI version ──────────────────────────────────────────────────
export type ProvisionState = "idle" | "installing" | "ready" | "error";

export interface ConductorStatus {
  /** Version pinned by the user, or null when using the bundled default. */
  overrideVersion: string | null;
  /** Version resolved for invocations right now (override when ready, else bundled). */
  activeVersion: string | null;
  /** Version baked into this app build. */
  bundledVersion: string | null;
  state: ProvisionState;
  error: string | null;
}

// ── Agentic writer (live) ──────────────────────────────────────────────────
export type AgentStatus = "idle" | "starting" | "running" | "awaiting-input" | "stopped" | "error";

export interface AgentPermissionRequest {
  requestId: string;
  toolUseId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  title?: string;
  description?: string;
}

export interface AgentStartResult {
  agentId: string;
}

/** A rendered item in the agent conversation, derived from stream-json events. */
export type ConversationItem =
  | { kind: "text"; id: string; role: "assistant" | "user"; text: string }
  | { kind: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { kind: "tool_result"; id: string; text: string; isError: boolean }
  | { kind: "result"; id: string; text: string; isError: boolean };

// ── Agentic test reports ───────────────────────────────────────────────────
export type TestVerdict = "PASS" | "FAIL" | "BLOCKED";
export type TestStepStatus = "pass" | "fail" | "info";

/** A box over a screenshot, normalized 0–1, outlining what was checked. */
export interface Highlight {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TestExpectation {
  text: string;
  status: TestStepStatus;
  /** The tool output that decided it — copied verbatim, never paraphrased. */
  evidence?: string;
  /** Evidence Studio captured at the moment it resolved. */
  screenshot?: string;
  highlight?: Highlight;
  at?: number;
}

export interface TestStep {
  n?: number;
  kind?: "action" | "assert";
  title: string;
  status?: TestStepStatus;
  detail?: string;
  evidence?: string;
  /** Absolute path, or relative to the report directory. */
  screenshot?: string;
  highlight?: Highlight;
}

/** What the agent records while testing; the report is rendered from it. */
export interface TestRunLog {
  title: string;
  description?: string;
  platform?: string;
  device?: string;
  verdict: TestVerdict;
  startedAt?: string;
  finishedAt?: string;
  summary?: string;
  plan?: {
    preconditions?: string[];
    actions?: string[];
    expectations?: string[];
  };
  expectations?: TestExpectation[];
  steps?: TestStep[];
  /** Corrections Studio made because the verdict didn't match the evidence. */
  adjustments?: string[];
}

/**
 * A test the agent is running right now: the plan it declared up front and the
 * expectations that have resolved so far. Studio renders it live beside the
 * device, so a run reads as a test rather than as a chat log.
 */
export interface TestSession {
  id: string;
  dir: string;
  title: string;
  description?: string;
  plan?: {
    preconditions?: string[];
    actions?: string[];
    expectations?: string[];
  };
  expectations: TestExpectation[];
  startedAt: number;
  device?: string;
  /** Set once the report is written — the panel then links to it. */
  reportId?: string;
  verdict?: TestVerdict;
}

/** A rendered report on disk, as listed in the Reports view. */
export interface TestReport {
  id: string;
  dir: string;
  title: string;
  verdict: TestVerdict;
  createdAt: number;
  summary?: string;
  platform?: string;
  device?: string;
  htmlPath: string;
  pdfPath?: string;
  /** Test case this report verified, when the agent was pointed at one. */
  caseId?: string;
  /** Corrections Studio made because the verdict didn't match the evidence. */
  adjustments?: string[];
  /** Counts for the pass/fail line in the list. */
  passed: number;
  failed: number;
}
