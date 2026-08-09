// Typed IPC wrappers — the ONLY place the renderer calls window.conductorStudio.
// Components import these named functions; they never touch the bridge directly.
import type {
  AgentStartResult,
  CaseMatrix,
  CaptureUiResult,
  CommandResult,
  DeviceInfo,
  DeviceStreamInfo,
  FileEntry,
  FlowCatalog,
  FlowReference,
  FlowSearchHit,
  LintProblem,
  RenameResult,
  MaestroStatus,
  Platform,
  PomEntry,
  ProjectInfo,
  RunArtifacts,
  RunOptions,
  RunRecord,
  SceneGraph,
  SceneGraphSummary,
  TestCase,
  ThemePreference,
  UpdaterState,
  VideoConfig,
} from "./types";

function invoke<T>(channel: string, args?: unknown): Promise<T> {
  return window.conductorStudio.invoke<T>(channel, args);
}

// ── Project / files ──
export const openProject = (root?: string) => invoke<ProjectInfo>("project_open", { root });
export const getProjectInfo = () => invoke<ProjectInfo | null>("project_info");
export const pickProject = () => invoke<ProjectInfo | null>("project_pick");
export const recentProjects = () => invoke<ProjectInfo[]>("project_recents");
export const listFlows = () => invoke<FileEntry[]>("flows_list");
export const setFlowsDir = (dir: string) => invoke<ProjectInfo>("flows_set_dir", { dir });
export const listEnvNames = () => invoke<string[]>("flows_env_names");
export const loadFlowCatalog = () => invoke<FlowCatalog>("flows_catalog");
export const readFlow = (path: string) => invoke<string>("flow_read", { path });
export const writeFlow = (path: string, content: string) =>
  invoke<void>("flow_write", { path, content });
export const createFlow = (path: string, content?: string) =>
  invoke<void>("flow_create", { path, content });
export const deleteFlow = (path: string) => invoke<void>("flow_delete", { path });
export const renameFlow = (from: string, to: string) =>
  invoke<RenameResult>("flow_rename", { from, to });
export const listReferences = () => invoke<FlowReference[]>("flows_references");
export const findUsages = (path: string) => invoke<FlowReference[]>("flows_usages", { path });
export const searchFlows = (query: string) => invoke<FlowSearchHit[]>("flows_search", { query });
export const lintProject = () => invoke<LintProblem[]>("flows_lint");
export const lintFlowContent = (path: string, content: string) =>
  invoke<LintProblem[]>("flows_lint_one", { path, content });
export const duplicateFlow = (from: string, to: string) =>
  invoke<void>("flow_duplicate", { from, to });
export const createFolder = (path: string) => invoke<void>("flow_mkdir", { path });

// ── Devices ──
export const listDevices = () => invoke<DeviceInfo[]>("devices_list");
export const startDeviceStream = (deviceId: string, platform: Platform) =>
  invoke<DeviceStreamInfo>("device_stream_start", { deviceId, platform });
export const getDeviceStreamConfig = (deviceId: string) =>
  invoke<VideoConfig | null>("device_stream_config", { deviceId });
export const stopDeviceStream = (deviceId: string) =>
  invoke<void>("device_stream_stop", { deviceId });
export const deviceTap = (deviceId: string, x: number, y: number) =>
  invoke<void>("device_tap", { deviceId, x, y });
export const deviceSwipe = (
  deviceId: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
) => invoke<void>("device_swipe", { deviceId, x1, y1, x2, y2 });
export const deviceInputText = (deviceId: string, text: string) =>
  invoke<void>("device_input_text", { deviceId, text });
export const captureUi = (deviceId: string) => invoke<CaptureUiResult>("capture_ui", { deviceId });

// ── Flow running ──
export const getMaestroStatus = () => invoke<MaestroStatus>("maestro_status");
export const runFlow = (path: string, deviceId?: string, options?: RunOptions) =>
  invoke<{ runId: string }>("flow_run", { path, deviceId, options });
export const runFolder = (dir?: string, deviceId?: string, options?: RunOptions) =>
  invoke<{ runId: string }>("flow_run_folder", { dir, deviceId, options });
export const runFlowInline = (
  snippet: string,
  deviceId?: string,
  appId?: string,
  options?: RunOptions,
) => invoke<{ runId: string }>("flow_run_inline", { snippet, deviceId, appId, options });
export const runRepeat = (path: string, times: number, deviceId?: string, options?: RunOptions) =>
  invoke<{ runIds: string[] }>("flow_run_repeat", { path, times, deviceId, options });
export const cancelRun = (runId: string) => invoke<void>("flow_run_cancel", { runId });
export const runHistory = () => invoke<RunRecord[]>("runs_history");
export const clearRunHistory = () => invoke<void>("runs_clear");
export const runArtifacts = (runId: string) => invoke<RunArtifacts | null>("runs_artifacts", { runId });
export const runCommand = (command: string, deviceId: string) =>
  invoke<CommandResult>("flow_run_command", { command, deviceId });
export const startLogs = (deviceId: string) => invoke<void>("logs_start", { deviceId });
export const stopLogs = (deviceId: string) => invoke<void>("logs_stop", { deviceId });

// ── Test case management ──
export const listCases = () => invoke<TestCase[]>("cases_list");
export const casesMatrix = (dimension?: string) =>
  invoke<CaseMatrix>("cases_matrix", { dimension });
export const syncCasesCi = (dimension?: string) =>
  invoke<CaseMatrix>("cases_sync_ci", { dimension });

// ── Agentic writer ──
export const agentStatus = () => invoke<{ available: boolean }>("agent_status");
export const listPoms = () => invoke<PomEntry[]>("pom_list");
export const loadSceneGraph = (deviceId?: string) =>
  invoke<SceneGraph>("scenegraph_load", { deviceId });
export const listSceneGraphs = () => invoke<SceneGraphSummary[]>("scenegraph_list");
export const startAgent = (deviceId?: string, autoApprove?: boolean) =>
  invoke<AgentStartResult>("agent_start", { deviceId, autoApprove });
export const sendAgentMessage = (agentId: string, text: string) =>
  invoke<void>("agent_send", { agentId, text });
export const stopAgent = (agentId: string) => invoke<void>("agent_stop", { agentId });
export const interruptAgent = (agentId: string) => invoke<void>("agent_interrupt", { agentId });
export const respondAgentPermission = (
  agentId: string,
  toolUseId: string,
  decision: "allow" | "deny",
  toolName?: string,
  allowAll?: boolean,
) => invoke<void>("agent_permission_respond", { agentId, toolUseId, decision, toolName, allowAll });

// ── Theme ──
export const getTheme = () => invoke<ThemePreference>("theme_get");
export const setTheme = (theme: ThemePreference) => invoke<void>("theme_set", { theme });

// ── Updater ──
export const getUpdaterState = () => invoke<UpdaterState>("updater_state");
export const updaterCheck = () => invoke<void>("updater_check");
export const updaterDownload = () => invoke<void>("updater_download");
export const updaterInstall = () => invoke<void>("updater_install");
