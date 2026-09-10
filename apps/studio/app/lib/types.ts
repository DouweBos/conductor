// Shared types across the Electron main process and the React renderer. Kept in
// sync manually (no codegen), mirroring Argus's convention. tsconfig.main.json
// includes this file so the backend can import it too.

/**
 * Device families Studio can drive. Mirrors the conductor CLI's driver set —
 * `vega` is an Amazon Fire TV (Vega) virtual device and `roku` a Roku, both of
 * which the CLI has driven for some time; Studio only gained names for them
 * when parity started comparing a reference build against them.
 */
export type Platform = "ios" | "android" | "tvos" | "web" | "vega" | "roku";

/** Platforms driven by a remote's D-pad rather than a touch screen. */
export const TV_PLATFORMS: readonly Platform[] = ["tvos", "vega", "roku"];

export function isTvPlatform(platform: Platform | undefined): boolean {
  return platform !== undefined && TV_PLATFORMS.includes(platform);
}

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

// ── Test cases ────────────────────────────────────────────────────────────
/**
 * The case model is Qase's — see electron/services/cases/model.ts. Re-exported
 * here so the renderer keeps one import site for types.
 */
export type {
  Behavior,
  Case,
  CaseMatrix,
  QaseProject,
  CaseStatus,
  CaseStep,
  StepPomCall,
  CaseType,
  Priority,
  RefreshSummary,
  Severity,
  StepsType,
} from "../../electron/services/cases/model";
export type { FlowLink } from "../../electron/services/cases/coverage";
export {
  BEHAVIORS,
  CASE_STATUSES,
  CASE_TYPES,
  PRIORITIES,
  SEVERITIES,
} from "../../electron/services/cases/model";

/** Which of a case's steps the flow behind it actually performs. */
export interface StepCoverage {
  ref: string;
  column?: string;
  flow?: string;
  steps: { index: number; action: string; poms: string[]; backed: boolean }[];
  /** Page objects the flow calls that no step accounts for. */
  extra: string[];
}

/** A named selection of cases to execute together. */
export interface TestPlan {
  id: string;
  name: string;
  description?: string;
  /** Explicit case refs, in execution order. */
  refs?: string[];
  /** Or a custom-field filter: field -> accepted values (AND across fields). */
  filter?: Record<string, string[]>;
  /** Only run these columns of each case; all of them when absent. */
  columns?: string[];
  filePath: string;
}

export interface TestPlanInput extends Omit<TestPlan, "filePath"> {
  previousId?: string;
}

export interface PlanRunEntry {
  ref: string;
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
  refs: string[];
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

// ── Parity ───────────────────────────────────────────────────────────────────
//
// Studio's mirror of the conductor CLI's parity model (`parity matrix --json`).
// One reference build is walked once; every target build walks the same journey
// and is diffed against it, producing a checkpoint × target grid.

export type ParityFindingKind =
  | "missing"
  | "added"
  | "text"
  | "value"
  | "state"
  | "focus"
  | "moved"
  | "resized"
  | "reordered"
  | "pixel"
  | "geometry"
  | "checkpoint-missing";

export type ParitySeverity = "blocking" | "advisory";

/** A build to hold the reference to, bound to the device that runs it. */
export interface ParityTarget {
  /** Column name in the grid: "tvOS", "Android TV", "VegaOS", "Lightning". */
  label: string;
  deviceId: string;
  platform: Platform;
}

export interface ParityFinding {
  kind: ParityFindingKind;
  severity: ParitySeverity;
  detail: string;
  role?: string;
  label?: string;
  identifier?: string;
}

export interface ParityCheckpointDiff {
  name: string;
  passed: boolean;
  scaled: boolean;
  rolesRelaxed: boolean;
  counts: Record<string, number>;
  findings: ParityFinding[];
  pixel?: { diffPixels: number; ratio: number; diffPath?: string; skipped?: string };
}

export interface ParityMatrixCell {
  target: string;
  status: "pass" | "fail" | "absent";
  blocking: number;
  advisory: number;
}

export interface ParityMatrixRow {
  checkpoint: string;
  cells: ParityMatrixCell[];
  passed: boolean;
}

/**
 * A finding seen across one or more targets. `universal` — every target reports
 * it — is the signal that the *reference* is the outlier rather than the
 * targets, since independent rebuilds rarely diverge the same way.
 */
export interface ParitySharedFinding {
  signature: string;
  checkpoint: string;
  kind: ParityFindingKind;
  severity: ParitySeverity;
  subject: string;
  role?: string;
  identifier?: string;
  targets: string[];
  universal: boolean;
  detail: string;
}

export interface ParityTargetResult {
  label: string;
  dir: string;
  platform: string;
  passed: boolean;
  report: {
    summary: {
      checkpoints: number;
      passed: number;
      failed: number;
      blocking: number;
      advisory: number;
    };
    checkpoints: ParityCheckpointDiff[];
  };
}

export interface ParityMatrix {
  version: 1;
  passed: boolean;
  comparedAt: string;
  reference: { dir: string; label: string };
  targets: ParityTargetResult[];
  rows: ParityMatrixRow[];
  shared: ParitySharedFinding[];
  summary: {
    targets: number;
    targetsPassed: number;
    checkpoints: number;
    blocking: number;
    advisory: number;
    universal: number;
  };
}

/** Where one target is in its walk. Drives the per-tile status in the grid. */
export type ParityTargetPhase = "idle" | "walking" | "recorded" | "failed";

export interface ParityTargetProgress {
  label: string;
  deviceId: string;
  phase: ParityTargetPhase;
  /** Checkpoints captured so far. */
  checkpoints: number;
  /** Most recent checkpoint name, for the tile caption. */
  lastCheckpoint?: string;
  error?: string;
}

export type ParityRunPhase =
  | "idle"
  | "recording-reference"
  | "walking-targets"
  | "diffing"
  | "done"
  | "failed";

/** One broadcast tick of a parity run, per `parity_progress`. */
export interface ParityProgress {
  runId: string;
  phase: ParityRunPhase;
  reference: ParityTargetProgress;
  targets: ParityTargetProgress[];
  matrix?: ParityMatrix;
  error?: string;
}

export interface ParityRunRequest {
  flowPath: string;
  /** Device that runs the build being ported *from*. */
  referenceDeviceId: string;
  referenceLabel: string;
  targets: ParityTarget[];
  /** Reuse an existing reference run instead of re-recording it. */
  reuseReferenceDir?: string;
}

export interface ParityRunStarted {
  runId: string;
  outDir: string;
  referenceDir: string;
}

/** How a parity comparison gets its screens. */
export type ParityMode = "flow" | "live";

/**
 * Capture what every device is showing right now.
 *
 * The flow path assumes a journey worth scripting; often there isn't one and
 * the reference is simply already on the screen you care about. Snaps append to
 * one session, so moving through the app and capturing as you go builds the
 * grid a screen at a time with no flow file anywhere.
 */
export interface ParitySnapRequest {
  /** What to call this screen in the grid. */
  name: string;
  referenceDeviceId: string;
  referenceLabel: string;
  targets: ParityTarget[];
  /** Start a fresh session rather than appending to the current one. */
  reset?: boolean;
}

export interface ParitySnapResult {
  /** The name it was actually filed under — a repeat gets numbered. */
  name: string;
  matrix: ParityMatrix;
}

// ── Convergence ──────────────────────────────────────────────────────────────
//
// The Helix loop: freeze a reference screen, then let an agent work each target
// build until it matches. The agent never decides it is finished — the parity
// diff does, which is the whole point: an imperfect attempt cannot move forward
// until it becomes a good one.

export type ConvergePhase =
  | "idle"
  | "preparing" // rebuilding, relaunching, replaying the route
  | "capturing" // taking this attempt's screenshot of the target
  | "diffing"
  | "agent-working" // findings handed over; waiting for the turn to end
  | "awaiting-review" // at parity, waiting for a human's nod
  | "stalled" // out of attempts, or no longer improving
  | "failed";

/** One round: capture, diff, hand the findings over. */
export interface ConvergeAttempt {
  index: number;
  startedAt: number;
  finishedAt?: number;
  blocking: number;
  advisory: number;
  passed: boolean;
  /** Findings this round, most severe first. */
  findings: ParityFinding[];
  /** Run directory this attempt captured into. */
  dir: string;
  error?: string;
  /** What the loop ran to get here: rebuild, relaunch, route, tests. */
  steps?: RecipeStepResult[];
  /** The target's own tests, when the recipe has them. Part of the gate. */
  tests?: { passed: boolean; output: string };
  /** What the agent's turn for this round cost, when the CLI reports it. */
  agent?: { durationMs?: number; costUsd?: number; turns?: number };
}

export interface ConvergeTargetState {
  label: string;
  deviceId: string;
  platform: Platform;
  phase: ConvergePhase;
  /** Agent working this target, when one has been started. */
  agentId?: string;
  attempts: ConvergeAttempt[];
  /** Why the loop stopped, when it has. */
  outcome?: string;
  error?: string;
  /** A human looked at the matching screen and said yes. */
  accepted?: boolean;
}

export interface ConvergeProgress {
  goalId: string;
  /** The screen every target is being held to. */
  checkpoint: string;
  referenceLabel: string;
  referenceDir: string;
  running: boolean;
  targets: ConvergeTargetState[];
  startedAt: number;
  finishedAt?: number;
}

export interface ConvergeRequest {
  /** Name of the reference screen already captured for this goal. */
  checkpoint: string;
  referenceDir: string;
  referenceLabel: string;
  targets: ParityTarget[];
  /** Rounds a target gets before the loop gives up. */
  maxAttempts?: number;
  /**
   * Consecutive rounds without fewer blocking findings before the loop calls it
   * stalled. Without this an agent that cannot fix something burns every
   * attempt rediscovering that.
   */
  patience?: number;
  /**
   * Run the agents without pausing for tool permission prompts. Defaults to
   * true: the Parity view has nowhere to answer a prompt, so an agent that
   * stops to ask would wait forever and the loop with it.
   */
  autoApprove?: boolean;
  /** How the reference reached the screen; replayed on every target after a rebuild. */
  route?: Route;
  /** Use a target's `reload` recipe instead of `build` when it has one. */
  preferReload?: boolean;
  /**
   * Keep a target's agent alive while it awaits review, so a rejection goes
   * back to the same context. Off in a campaign, where holding four devices
   * per finished goal would starve the next one; a rejection there restarts
   * an agent, which reads the memory file to catch up.
   */
  holdAgentForReview?: boolean;
  /**
   * Hold targets to layout as well as structure — every finding kind blocks,
   * including moved/resized/pixel. Off, a target passes as soon as the same
   * elements exist with the same text and focus; on, it also has to put them
   * in the same place.
   */
  strict?: boolean;
}

// ── Routes, recipes, memory ──────────────────────────────────────────────────
//
// What the convergence loop needs to own instead of hoping the agent does:
// how to rebuild each target, how to get it back to the screen, and what was
// learned last time.

/** One input as replayed on a device. Coordinates are normalised 0–1. */
export type RouteStep =
  | { kind: "tap"; x: number; y: number }
  | { kind: "swipe"; x1: number; y1: number; x2: number; y2: number }
  | { kind: "key"; key: string }
  | { kind: "text"; text: string };

/**
 * How a screen was reached from a fresh launch. Recorded while you drive the
 * reference in live mode, replayed on every target after each rebuild — so
 * re-navigation is mechanical, not the agent's job. A deep link, where the app
 * has one, replaces the steps entirely.
 */
export interface Route {
  /** Launched app, so replay starts from a known state. */
  appId?: string;
  deepLink?: string;
  steps: RouteStep[];
  /** Milliseconds to wait after launch before the first step. */
  settleMs?: number;
}

export interface RecipeCommand {
  /** Run through the shell, so `cd ios && xcodebuild …` works. */
  command: string;
  /** Relative to the project root. Also the scope committed on accept. */
  cwd?: string;
  timeoutMs?: number;
}

/**
 * How to turn a target's source into a running app. Without this every round
 * re-derives `xcodebuild -scheme … -destination …` in a fresh agent context,
 * and gets it wrong in novel ways — it is the least reliable step and the one
 * that sets the round time everything else multiplies.
 */
export interface TargetRecipe {
  label: string;
  platform: Platform;
  /** Bundle / package id, so the loop can `launch-app` it. */
  appId?: string;
  /** Full rebuild from source. */
  build?: RecipeCommand;
  /** Cheaper than a build where the stack has it — RN / Lightning hot reload. */
  reload?: RecipeCommand;
  /** Install onto the device after a build, when `launch-app` alone won't. */
  install?: RecipeCommand;
  /** The target's own test suite, run as part of the gate. */
  test?: RecipeCommand;
  /** Where this target's source lives; what gets committed on accept. */
  sourceDir?: string;
}

export interface ParityProjectConfig {
  version: 1;
  recipes: Record<string, TargetRecipe>;
}

/** One thing a target's agent (or a reviewer) learned, kept across goals. */
export interface MemoryEntry {
  at: number;
  /** Who wrote it: the agent, a human rejection, or the loop itself. */
  source: "agent" | "reviewer" | "loop";
  text: string;
}

export interface TargetMemory {
  label: string;
  entries: MemoryEntry[];
}

/** What a recipe step produced, kept on the attempt so the trend is honest. */
export interface RecipeStepResult {
  step: "reload" | "build" | "install" | "launch" | "route" | "test";
  ok: boolean;
  durationMs: number;
  /** Tail of the output, for the brief and the panel. */
  output: string;
}

// ── Campaign ─────────────────────────────────────────────────────────────────
//
// One screen is not an app. A campaign is the queue of reference screens a
// rebuild is being held to, each with its frozen reference, the route that
// reached it, and where every target stands — the "sequence of checkpoints"
// Helix starts from, with a burn-down.

export type GoalTargetStatus =
  | "pending"
  | "converging"
  | "review" // at parity, waiting for a human
  | "accepted"
  | "recheck" // was accepted; the reference has since moved
  | "stalled"
  | "failed";

export interface ParityGoal {
  id: string;
  checkpoint: string;
  referenceDir: string;
  referenceLabel: string;
  /** Device the reference build runs on — needed to refresh the reference. */
  referenceDeviceId: string;
  referenceCapturedAt: number;
  route?: Route;
  targets: ParityTarget[];
  status: Record<string, GoalTargetStatus>;
  createdAt: number;
  updatedAt: number;
  /** Set when a refresh found the reference screen had changed. */
  drift?: { at: number; blocking: number; summary: string };
}

export interface ParityCampaign {
  version: 1;
  goals: ParityGoal[];
}

export interface CampaignProgress {
  campaign: ParityCampaign;
  running: boolean;
  /** Goal being converged right now, when running. */
  currentGoalId?: string;
  error?: string;
}

export interface CampaignBurndown {
  goals: number;
  /** Per target label: how many goals it has been accepted on. */
  acceptedByTarget: Record<string, number>;
  accepted: number;
  review: number;
  recheck: number;
  stalled: number;
  pending: number;
}
