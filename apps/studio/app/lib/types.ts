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
  title: string;
  description?: string;
  userStory?: string;
  /** tag dimension -> values, e.g. { platform: ["ios"], vertical: ["fintech"] }. */
  tags: Record<string, string[]>;
  /** Path (relative to flowsDir) of the Maestro flow implementing this case. */
  flow?: string;
  /** Latest CI status, when synced. */
  ciStatus?: FlowRunStatus;
  filePath: string; // relative to project root
}

/** Result of a GitHub Actions CI sync for the test cases. */
export interface CiSync {
  repo?: string;
  runUrl?: string;
  runName?: string;
  branch?: string;
  syncedAt: number;
  /** How many cases got a status, out of how many exist. */
  matched: number;
  total: number;
  /** True when the run had no job detail, so every case shows the run's result. */
  fallbackToRunStatus: boolean;
  statuses: Record<string, FlowRunStatus>;
}

export interface CaseMatrix {
  dimension: string; // which tag dimension forms the columns
  columns: string[];
  cases: TestCase[];
  /** The most recent CI sync, if one has run this session. */
  ci?: CiSync;
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
