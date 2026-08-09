// Shared types across the Electron main process and the React renderer. Kept in
// sync manually (no codegen), mirroring Argus's convention. tsconfig.main.json
// includes this file so the backend can import it too.

export type Platform = "ios" | "android" | "tvos" | "web";

export interface ProjectInfo {
  root: string;
  name: string;
  /** Absolute path to the flows directory (default <root>/.maestro). */
  flowsDir: string;
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

export interface CaseMatrix {
  dimension: string; // which tag dimension forms the columns
  columns: string[];
  cases: TestCase[];
}

// ── Agentic writer (scaffolded) ───────────────────────────────────────────
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

export interface SceneGraph {
  version: number;
  nodes: SceneNode[];
  edges: SceneEdge[];
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
