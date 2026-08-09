import { ipcMain } from "electron";

import type {
  AgentStartResult,
  CaseMatrix,
  CaptureUiResult,
  CommandResult,
  DeviceInfo,
  DeviceStreamInfo,
  FileEntry,
  FlowCatalog,
  MaestroStatus,
  PomEntry,
  ProjectInfo,
  RunOptions,
  SceneGraph,
  SceneGraphSummary,
  TestCase,
  ThemePreference,
  UpdaterState,
  VideoConfig,
} from "../app/lib/types";
import {
  getAgentStatus,
  interruptAgent,
  respondToAgentPermission,
  sendAgentMessage,
  startAgent,
  stopAgent,
} from "./services/agent/agentService";
import { buildMatrix, listCases, syncCases } from "./services/cases/casesService";
import {
  appFingerprint,
  captureUi,
  inputText,
  listDevices,
  swipe,
  tap,
} from "./services/conductor/conductorService";
import {
  getDeviceStreamConfig,
  startDeviceStream,
  stopDeviceStream,
} from "./services/device/deviceService";
import {
  createFlow,
  createFolder,
  deleteFlow,
  duplicateFlow,
  getProjectInfo,
  listFlows,
  listRecentProjects,
  openProject,
  pickProject,
  readFlow,
  renameFlow,
  setFlowsDir,
  writeFlow,
} from "./services/file/fileService";
import {
  cancelRun,
  getMaestroStatus,
  runCommand,
  runFlow,
  runFlowInline,
  runFolder,
} from "./services/flow/flowRunner";
import { loadFlowCatalog } from "./services/flow/catalog";
import { listEnvNames } from "./services/flow/envNames";
import { startLogs, stopLogs } from "./services/logs/logsService";
import { listPoms } from "./services/pom/pomService";
import {
  findAppByKey,
  listSceneGraphs,
  loadSceneGraph,
} from "./services/scenegraph/sceneGraphService";
import { getTheme, setTheme } from "./services/settings/settingsService";
import {
  checkForUpdates,
  downloadUpdate,
  getUpdaterState,
  quitAndInstallUpdate,
} from "./services/updater/updaterService";

// Wrap ipcMain.handle: unwrap the single args object and re-throw as a plain
// string so the renderer promise rejects with a readable message.
function handle<A, R>(channel: string, fn: (args: A) => Promise<R> | R): void {
  ipcMain.handle(channel, async (_event, args: A) => {
    try {
      return await fn(args);
    } catch (err) {
      throw err instanceof Error ? err.message : String(err);
    }
  });
}

export function registerIpcHandlers(): void {
  // ── Project / files ──
  handle<{ root?: string }, ProjectInfo>("project_open", (a) => openProject(a?.root));
  handle<void, ProjectInfo | null>("project_info", () => getProjectInfo());
  handle<void, ProjectInfo | null>("project_pick", () => pickProject());
  handle<void, ProjectInfo[]>("project_recents", () => listRecentProjects());
  handle<void, FileEntry[]>("flows_list", () => listFlows());
  handle<{ dir: string }, ProjectInfo>("flows_set_dir", (a) => setFlowsDir(a.dir));
  handle<void, string[]>("flows_env_names", () => listEnvNames());
  handle<void, FlowCatalog>("flows_catalog", () => loadFlowCatalog());
  handle<{ path: string }, string>("flow_read", (a) => readFlow(a.path));
  handle<{ path: string; content: string }, void>("flow_write", (a) =>
    writeFlow(a.path, a.content),
  );
  handle<{ path: string; content?: string }, void>("flow_create", (a) =>
    createFlow(a.path, a.content),
  );
  handle<{ path: string }, void>("flow_delete", (a) => deleteFlow(a.path));
  handle<{ from: string; to: string }, void>("flow_rename", (a) => renameFlow(a.from, a.to));
  handle<{ from: string; to: string }, void>("flow_duplicate", (a) => duplicateFlow(a.from, a.to));
  handle<{ path: string }, void>("flow_mkdir", (a) => createFolder(a.path));

  // ── Devices ──
  handle<void, DeviceInfo[]>("devices_list", () => listDevices());
  handle<{ deviceId: string; platform: string }, DeviceStreamInfo>(
    "device_stream_start",
    (a) => startDeviceStream(a.deviceId, a.platform as DeviceStreamInfo["platform"]),
  );
  handle<{ deviceId: string }, VideoConfig | null>("device_stream_config", (a) =>
    getDeviceStreamConfig(a.deviceId),
  );
  handle<{ deviceId: string }, void>("device_stream_stop", (a) => stopDeviceStream(a.deviceId));
  handle<{ deviceId: string; x: number; y: number }, void>("device_tap", (a) =>
    tap(a.deviceId, a.x, a.y),
  );
  handle<
    { deviceId: string; x1: number; y1: number; x2: number; y2: number },
    void
  >("device_swipe", (a) => swipe(a.deviceId, a.x1, a.y1, a.x2, a.y2));
  handle<{ deviceId: string; text: string }, void>("device_input_text", (a) =>
    inputText(a.deviceId, a.text),
  );
  handle<{ deviceId: string }, CaptureUiResult>("capture_ui", (a) => captureUi(a.deviceId));

  // ── Flow running ──
  handle<void, MaestroStatus>("maestro_status", () => getMaestroStatus());
  handle<{ path: string; deviceId?: string; options?: RunOptions }, { runId: string }>(
    "flow_run",
    (a) => runFlow(a.path, a.deviceId, a.options),
  );
  handle<{ dir?: string; deviceId?: string; options?: RunOptions }, { runId: string }>(
    "flow_run_folder",
    (a) => runFolder(a.dir, a.deviceId, a.options),
  );
  handle<
    { snippet: string; deviceId?: string; appId?: string; options?: RunOptions },
    { runId: string }
  >("flow_run_inline", (a) => runFlowInline(a.snippet, a.deviceId, a.appId, a.options));
  handle<{ runId: string }, void>("flow_run_cancel", (a) => cancelRun(a.runId));
  handle<{ command: string; deviceId: string }, CommandResult>("flow_run_command", (a) =>
    runCommand(a.command, a.deviceId),
  );

  // ── Device logs ──
  handle<{ deviceId: string }, void>("logs_start", (a) => startLogs(a.deviceId));
  handle<{ deviceId: string }, void>("logs_stop", (a) => stopLogs(a.deviceId));

  // ── Test case management ──
  handle<void, TestCase[]>("cases_list", () => listCases());
  handle<{ dimension?: string }, CaseMatrix>("cases_matrix", (a) => buildMatrix(a?.dimension));
  handle<{ dimension?: string }, CaseMatrix>("cases_sync_ci", (a) => syncCases(a?.dimension));

  // ── Agentic writer ──
  handle<void, { available: boolean }>("agent_status", () => getAgentStatus());
  handle<void, PomEntry[]>("pom_list", () => listPoms());
  handle<{ deviceId?: string; key?: string }, SceneGraph>("scenegraph_load", async (a) => {
    if (a?.key) return loadSceneGraph(await findAppByKey(a.key));
    // A device id means "whatever app is in the foreground there" — the graph
    // is keyed by app, not by device.
    if (a?.deviceId) return loadSceneGraph(await appFingerprint(a.deviceId).catch(() => null));
    return loadSceneGraph();
  });
  handle<void, SceneGraphSummary[]>("scenegraph_list", () => listSceneGraphs());
  handle<{ deviceId?: string; autoApprove?: boolean }, AgentStartResult>("agent_start", (a) =>
    startAgent(a?.deviceId, a?.autoApprove),
  );
  handle<{ agentId: string; text: string }, void>("agent_send", (a) =>
    sendAgentMessage(a.agentId, a.text),
  );
  handle<{ agentId: string }, void>("agent_stop", (a) => stopAgent(a.agentId));
  handle<{ agentId: string }, void>("agent_interrupt", (a) => interruptAgent(a.agentId));
  handle<
    { agentId: string; toolUseId: string; decision: "allow" | "deny"; toolName?: string; allowAll?: boolean },
    void
  >("agent_permission_respond", (a) =>
    respondToAgentPermission(a.agentId, a.toolUseId, a.decision, a.toolName, a.allowAll),
  );

  // ── Settings / theme ──
  handle<void, ThemePreference>("theme_get", () => getTheme());
  handle<{ theme: ThemePreference }, void>("theme_set", (a) => setTheme(a.theme));

  // ── Updater ──
  handle<void, UpdaterState>("updater_state", () => getUpdaterState());
  handle<void, void>("updater_check", () => checkForUpdates());
  handle<void, void>("updater_download", () => downloadUpdate());
  handle<void, void>("updater_install", () => quitAndInstallUpdate());
}
