import { dialog, ipcMain, shell } from "electron";

import { broadcastToRenderers } from "./broadcast";
import { appState } from "./state";

import type {
  AgentStartResult,
  CaseMatrix,
  CaseProject,
  CasePreview,
  CaseResult,
  CaseStats,
  ImportResult,
  PlanRun,
  PlanRunEntry,
  StepCoverage,
  CaseInput,
  CasesDatasource,
  PullSummary,
  TestPlan,
  TestPlanInput,
  CaptureUiResult,
  CommandResult,
  DeviceInfo,
  DeviceStreamInfo,
  EnvProfile,
  FileEntry,
  FlowCatalog,
  FlowCatalogEntry,
  FlowReference,
  FlowSearchHit,
  FlowTemplate,
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
  Case,
  TestReport,
  TestSession,
  ThemePreference,
  UpdaterState,
  ConductorStatus,
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
import {
  buildMatrix,
  datasource,
  deleteCase,
  listCases,
  matrixFields,
  pull,
  saveCase,
  saveDatasource,
} from "./services/cases/casesService";
import { listProjects, verifyProject, type QaseProject } from "./services/cases/qaseClient";
import { exportCsv, importCsv, previewCsv, type ImportOptions } from "./services/cases/importService";
import {
  cancelPlanRun,
  deletePlan,
  listPlanRuns,
  listPlans,
  planEntries,
  savePlan,
  startPlanRun,
} from "./services/cases/plansService";
import { listResults, recordResult, statsFor } from "./services/cases/resultsService";
import { automationBrief } from "./services/cases/automationBrief";
import {
  listStepPoms,
  readFlowText,
  scaffoldFlow,
  stepCoverage,
  type ScaffoldOptions,
} from "./services/cases/pomBridge";
import {
  deleteReport,
  listReports,
  readReportHtml,
  readReportMarkdown,
} from "./services/report/reportService";
import { clearTestSession, getTestSession } from "./services/report/testSession";
import {
  appFingerprint,
  captureUi,
  inputText,
  pressKey,
  installApp,
  listDevices,
  startDevice,
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
  runRepeat,
} from "./services/flow/flowRunner";
import { loadFlowCatalog } from "./services/flow/catalog";
import { createFromTemplate, listTemplates } from "./services/flow/templates";
import { lintOne, lintProject } from "./services/flow/lint";
import { findUsages, indexReferences, searchFlows } from "./services/flow/references";
import { listEnvNames } from "./services/flow/envNames";
import { clearHistory, historyArtifacts, listHistory } from "./services/flow/history";
import { changedFlows, listTags } from "./services/flow/suite";
import { startLogs, stopLogs } from "./services/logs/logsService";
import { listPoms } from "./services/pom/pomService";
import {
  findAppByKey,
  listSceneGraphs,
  loadSceneGraph,
} from "./services/scenegraph/sceneGraphService";
import {
  deleteCaseProject,
  deleteEnvProfile,
  getActiveCaseProject,
  getCaseProjects,
  getEnvProfiles,
  getQaseToken,
  getTheme,
  saveCaseProject,
  saveEnvProfile,
  setActiveCaseProject,
  setQaseToken,
  setTheme,
} from "./services/settings/settingsService";
import {
  checkForUpdates,
  downloadUpdate,
  getUpdaterState,
  quitAndInstallUpdate,
} from "./services/updater/updaterService";
import {
  getConductorStatus,
  readBundledVersion,
  setConductorOverrideVersion,
} from "./services/conductor/override";
import { listConductorVersions } from "./services/conductor/registry";

function requireRoot(): string {
  const project = getProjectInfo();
  if (!project) throw new Error("No project is open.");
  return project.root;
}

/** Stored token for a named sub-project, or the selected one. */
function storedToken(projectId?: string): string | undefined {
  const root = getProjectInfo()?.root;
  if (!root) return undefined;
  return getQaseToken(root, projectId ?? getActiveCaseProject(root));
}

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
  handle<void, FlowReference[]>("flows_references", () => indexReferences());
  handle<{ path: string }, FlowReference[]>("flows_usages", (a) => findUsages(a.path));
  handle<{ query: string }, FlowSearchHit[]>("flows_search", (a) => searchFlows(a.query));
  handle<void, LintProblem[]>("flows_lint", () => lintProject());
  handle<{ path: string; content: string }, LintProblem[]>("flows_lint_one", (a) =>
    lintOne(a.path, a.content),
  );
  handle<{ path: string }, string>("flow_read", (a) => readFlow(a.path));
  handle<{ path: string; content: string }, void>("flow_write", (a) =>
    writeFlow(a.path, a.content),
  );
  handle<{ path: string; content?: string }, void>("flow_create", (a) =>
    createFlow(a.path, a.content),
  );
  handle<void, FlowTemplate[]>("flow_templates", () => listTemplates());
  handle<{ templateId: string; path: string; vars: Record<string, string> }, void>(
    "flow_create_from_template",
    (a) => createFromTemplate(a.templateId, a.path, a.vars),
  );
  handle<{ path: string }, void>("flow_delete", (a) => deleteFlow(a.path));
  handle<{ from: string; to: string }, RenameResult>("flow_rename", (a) => renameFlow(a.from, a.to));
  handle<{ from: string; to: string }, void>("flow_duplicate", (a) => duplicateFlow(a.from, a.to));
  handle<{ path: string }, void>("flow_mkdir", (a) => createFolder(a.path));
  handle<{ path: string }, void>("path_reveal", (a) => shell.showItemInFolder(a.path));

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
  handle<{ platform: Platform; deviceId?: string }, string>("device_start", (a) =>
    startDevice(a.platform, a.deviceId),
  );
  handle<{ deviceId: string; appPath: string }, string>("device_install_app", (a) =>
    installApp(a.deviceId, a.appPath),
  );
  handle<{ deviceId: string; text: string }, void>("device_input_text", (a) =>
    inputText(a.deviceId, a.text),
  );
  handle<{ deviceId: string; key: string }, void>("device_press_key", (a) =>
    pressKey(a.deviceId, a.key),
  );
  handle<{ deviceId: string }, CaptureUiResult>("capture_ui", (a) => captureUi(a.deviceId));

  // ── Flow running ──
  handle<void, MaestroStatus>("maestro_status", () => getMaestroStatus());
  handle<
    { path: string; deviceId?: string; options?: RunOptions; platform?: string },
    { runId: string; deviceId?: string }
  >(
    "flow_run",
    (a) => runFlow(a.path, a.deviceId, a.options, a.platform),
  );
  handle<{ dir?: string; deviceId?: string; options?: RunOptions }, { runId: string }>(
    "flow_run_folder",
    (a) => runFolder(a.dir, a.deviceId, a.options),
  );
  handle<
    { snippet: string; deviceId?: string; appId?: string; options?: RunOptions },
    { runId: string }
  >("flow_run_inline", (a) => runFlowInline(a.snippet, a.deviceId, a.appId, a.options));
  handle<
    { path: string; times: number; deviceId?: string; options?: RunOptions },
    { runIds: string[] }
  >("flow_run_repeat", (a) => runRepeat(a.path, a.times, a.deviceId, a.options));
  handle<{ runId: string }, void>("flow_run_cancel", (a) => cancelRun(a.runId));
  handle<void, { tag: string; count: number }[]>("flows_tags", () => listTags());
  handle<{ base?: string }, string[]>("flows_changed", (a) => changedFlows(a?.base));
  handle<void, EnvProfile[]>("env_profiles", () => getEnvProfiles(appState.projectRoot ?? ""));
  handle<{ profile: EnvProfile }, EnvProfile[]>("env_profile_save", (a) =>
    saveEnvProfile(appState.projectRoot ?? "", a.profile),
  );
  handle<{ name: string }, EnvProfile[]>("env_profile_delete", (a) =>
    deleteEnvProfile(appState.projectRoot ?? "", a.name),
  );
  handle<void, RunRecord[]>("runs_history", () => listHistory());
  handle<void, void>("runs_clear", () => clearHistory());
  handle<{ runId: string }, RunArtifacts | null>("runs_artifacts", (a) => historyArtifacts(a.runId));
  handle<{ command: string; deviceId: string }, CommandResult>("flow_run_command", (a) =>
    runCommand(a.command, a.deviceId),
  );

  // ── Device logs ──
  handle<{ deviceId: string }, void>("logs_start", (a) => startLogs(a.deviceId));
  handle<{ deviceId: string }, void>("logs_stop", (a) => stopLogs(a.deviceId));

  // ── Test case management ──
  handle<void, Case[]>("cases_list", () => listCases());
  handle<{ field?: string }, CaseMatrix>("cases_matrix", (a) => buildMatrix(a?.field));
  handle<void, string[]>("cases_matrix_fields", () => matrixFields());
  handle<{ input: CaseInput }, Case>("case_save", (a) => saveCase(a.input));
  handle<{ id: number }, void>("case_delete", (a) => deleteCase(a.id));
  handle<void, CaseResult[]>("cases_results", () => listResults());
  handle<{ ref: string }, CaseStats>("case_stats", async (a) =>
    statsFor(a.ref, await listResults()),
  );

  // ── Case sub-projects (a monorepo's mobile app and tv app) ──
  handle<void, { projects: CaseProject[]; active: string }>("case_projects_get", () => ({
    projects: getCaseProjects(requireRoot()),
    active: getActiveCaseProject(requireRoot()),
  }));
  handle<{ project: CaseProject; token?: string | null }, CaseProject[]>(
    "case_project_save",
    (a) => {
      const root = requireRoot();
      if (a.token !== undefined) setQaseToken(root, a.project.id, a.token);
      saveCaseProject(root, a.project);
      return getCaseProjects(root);
    },
  );
  handle<{ id: string }, CaseProject[]>("case_project_delete", (a) =>
    deleteCaseProject(requireRoot(), a.id),
  );
  handle<{ id: string }, void>("case_project_activate", (a) => {
    setActiveCaseProject(requireRoot(), a.id);
    // Everything on the Cases screen is scoped to the selection, so it all reloads.
    broadcastToRenderers("cases:project-changed", a.id);
  });

  // ── Case datasource (local, or mirrored from Qase) ──
  handle<void, CasesDatasource>("cases_datasource_get", () => datasource());
  handle<{ datasource: CasesDatasource; token?: string | null }, CasesDatasource>(
    "cases_datasource_set",
    (a) => {
      const root = requireRoot();
      if (a.token !== undefined) setQaseToken(root, getActiveCaseProject(root), a.token);
      return saveDatasource(a.datasource);
    },
  );
  handle<void, PullSummary>("cases_pull", async () => {
    const summary = await pull();
    broadcastToRenderers("cases:pulled", summary);
    return summary;
  });
  // The picker runs before Save, so an unsaved token has to come in by argument.
  handle<
    { token?: string | null; projectId?: string },
    { ok: boolean; projects?: QaseProject[]; error?: string }
  >("cases_qase_projects", async (a) => {
    const token = a.token?.trim() || storedToken(a.projectId);
    if (!token) return { ok: false, error: "No Qase API token is set for this project." };
    try {
      return { ok: true, projects: await listProjects(token) };
    } catch (e) {
      return { ok: false, error: String(e instanceof Error ? e.message : e) };
    }
  });
  // Like the project list, this runs before Save — so it tests what's on screen,
  // falling back to what's stored.
  handle<
    { token?: string | null; projectCode?: string; projectId?: string },
    { ok: boolean; project?: string; error?: string }
  >("cases_datasource_test", async (a) => {
    const token = a?.token?.trim() || storedToken(a?.projectId);
    const code = a?.projectCode?.trim();
    if (!token) return { ok: false, error: "No Qase API token is set for this project." };
    if (!code) return { ok: false, error: "No Qase project is selected." };
    try {
      return { ok: true, project: await verifyProject(code, token) };
    } catch (e) {
      return { ok: false, error: String(e instanceof Error ? e.message : e) };
    }
  });
  handle<{ result: Omit<CaseResult, "id" | "at"> }, CaseResult>("case_record_result", (a) =>
    recordResult(a.result),
  );
  handle<void, string | null>("cases_pick_csv", async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: "Import test cases",
      message: "Choose a CSV exported from your test management tool",
      filters: [{ name: "CSV", extensions: ["csv"] }],
      properties: ["openFile"],
    });
    return canceled ? null : (filePaths[0] ?? null);
  });
  handle<void, string | null>("cases_pick_export", async () => {
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: "Export test cases",
      defaultPath: "cases.csv",
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    return canceled ? null : (filePath ?? null);
  });
  handle<{ file: string }, CasePreview>("cases_import_preview", (a) => previewCsv(a.file));
  handle<{ options: ImportOptions }, ImportResult>("cases_import", (a) => importCsv(a.options));
  handle<{ file: string }, number>("cases_export", (a) => exportCsv(a.file));

  // ── Test plans ──
  handle<void, TestPlan[]>("plans_list", () => listPlans());
  handle<{ plan: TestPlanInput }, TestPlan[]>("plan_save", (a) => savePlan(a.plan));
  handle<{ id: string }, TestPlan[]>("plan_delete", (a) => deletePlan(a.id));
  handle<{ id: string }, PlanRunEntry[]>("plan_preview", async (a) => {
    const plan = (await listPlans()).find((p) => p.id === a.id);
    return plan ? planEntries(plan, await listCases()) : [];
  });
  handle<{ id: string; deviceId?: string }, PlanRun>("plan_run", (a) =>
    startPlanRun(a.id, a.deviceId),
  );
  handle<{ id: string }, void>("plan_run_cancel", (a) => cancelPlanRun(a.id));
  handle<void, PlanRun[]>("plan_runs", () => listPlanRuns());

  // ── Case ↔ flow (POM) bridge ──
  handle<{ options: ScaffoldOptions }, { flow: string; todos: number }>("case_scaffold_flow", (a) =>
    scaffoldFlow(a.options),
  );
  handle<{ ref: string; column?: string }, StepCoverage>("case_step_coverage", (a) =>
    stepCoverage(a.ref, a.column),
  );
  handle<void, FlowCatalogEntry[]>("case_step_poms", () => listStepPoms());
  handle<{ ref: string; column?: string }, string>("case_automation_brief", (a) =>
    automationBrief(a.ref, a.column),
  );
  handle<{ flow: string }, string>("case_flow_text", (a) => readFlowText(a.flow));


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

  // ── Agentic test reports ──
  handle<void, TestReport[]>("reports_list", () => listReports());
  handle<{ id: string }, void>("report_delete", (a) => deleteReport(a.id));
  handle<{ path: string }, void>("report_open", async (a) => {
    const error = await shell.openPath(a.path);
    if (error) throw new Error(error);
  });
  handle<{ path: string }, void>("report_reveal", (a) => shell.showItemInFolder(a.path));
  handle<{ id: string }, string>("report_html", (a) => readReportHtml(a.id));
  handle<{ id: string }, string>("report_markdown", (a) => readReportMarkdown(a.id));
  handle<void, TestSession | null>("test_session", () => getTestSession());
  handle<void, void>("test_session_clear", () => clearTestSession());

  // ── Settings / theme ──
  handle<void, ThemePreference>("theme_get", () => getTheme());
  handle<{ theme: ThemePreference }, void>("theme_set", (a) => setTheme(a.theme));

  // ── Updater ──
  handle<void, UpdaterState>("updater_state", () => getUpdaterState());
  handle<void, void>("updater_check", () => checkForUpdates());
  handle<void, void>("updater_download", () => downloadUpdate());
  handle<void, void>("updater_install", () => quitAndInstallUpdate());

  // ── Conductor CLI version ──
  handle<void, ConductorStatus>("conductor_status", () => getConductorStatus());
  handle<void, string[]>("conductor_versions", () =>
    listConductorVersions(readBundledVersion()),
  );
  handle<{ version: string | null }, ConductorStatus>("conductor_set_version", (a) =>
    setConductorOverrideVersion(a.version),
  );
}
