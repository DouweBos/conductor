// Typed IPC wrappers — the ONLY place the renderer calls window.conductorStudio.
// Components import these named functions; they never touch the bridge directly.
import type {
  CasePreview,
  CaseResult,
  CaseStats,
  ImportResult,
  PlanRun,
  PlanRunEntry,
  StepCoverage,
  CaseInput,
  CaseProject,
  CasesDatasource,
  PullSummary,
  TestPlan,
  TestPlanInput,
  AgentStartResult,
  CaseMatrix,
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
export const listFlowTemplates = () => invoke<FlowTemplate[]>("flow_templates");
export const createFlowFromTemplate = (
  templateId: string,
  path: string,
  vars: Record<string, string>,
) => invoke<void>("flow_create_from_template", { templateId, path, vars });
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
/** Show an absolute path in Finder/Explorer. */
export const revealPath = (path: string) => invoke<void>("path_reveal", { path });

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
export const startDevice = (platform: Platform, deviceId?: string) =>
  invoke<string>("device_start", { platform, deviceId });
export const installApp = (deviceId: string, appPath: string) =>
  invoke<string>("device_install_app", { deviceId, appPath });
export const deviceInputText = (deviceId: string, text: string) =>
  invoke<void>("device_input_text", { deviceId, text });
export const devicePressKey = (deviceId: string, key: string) =>
  invoke<void>("device_press_key", { deviceId, key });
export const captureUi = (deviceId: string) => invoke<CaptureUiResult>("capture_ui", { deviceId });

// ── Flow running ──
export const getMaestroStatus = () => invoke<MaestroStatus>("maestro_status");
/**
 * Resolves with the device the run actually landed on. `platform` is the case's
 * column (`tv`, `mobile`), which decides what kind of device is right for it.
 */
export const runFlow = (path: string, deviceId?: string, options?: RunOptions, platform?: string) =>
  invoke<{ runId: string; deviceId?: string }>("flow_run", { path, deviceId, options, platform });
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
export const listTags = () => invoke<{ tag: string; count: number }[]>("flows_tags");
export const changedFlows = (base?: string) => invoke<string[]>("flows_changed", { base });
export const envProfiles = () => invoke<EnvProfile[]>("env_profiles");
export const saveEnvProfile = (profile: EnvProfile) =>
  invoke<EnvProfile[]>("env_profile_save", { profile });
export const deleteEnvProfile = (name: string) =>
  invoke<EnvProfile[]>("env_profile_delete", { name });
export const runHistory = () => invoke<RunRecord[]>("runs_history");
export const clearRunHistory = () => invoke<void>("runs_clear");
export const runArtifacts = (runId: string) => invoke<RunArtifacts | null>("runs_artifacts", { runId });
export const runCommand = (command: string, deviceId: string) =>
  invoke<CommandResult>("flow_run_command", { command, deviceId });
export const startLogs = (deviceId: string) => invoke<void>("logs_start", { deviceId });
export const stopLogs = (deviceId: string) => invoke<void>("logs_stop", { deviceId });

// ── Test case management ──
export const listCases = () => invoke<Case[]>("cases_list");
export const casesMatrix = (field?: string) => invoke<CaseMatrix>("cases_matrix", { field });
export const casesMatrixFields = () => invoke<string[]>("cases_matrix_fields");
export const saveCase = (input: CaseInput) => invoke<Case>("case_save", { input });
export const deleteCase = (id: number) => invoke<void>("case_delete", { id });
export const listCaseResults = () => invoke<CaseResult[]>("cases_results");
export const caseStats = (ref: string) => invoke<CaseStats>("case_stats", { ref });

// ── Case sub-projects (a monorepo's mobile app and tv app) ──
export const caseProjects = () =>
  invoke<{ projects: CaseProject[]; active: string }>("case_projects_get");
export const saveCaseProject = (project: CaseProject, token?: string | null) =>
  invoke<CaseProject[]>("case_project_save", { project, token });
export const deleteCaseProject = (id: string) =>
  invoke<CaseProject[]>("case_project_delete", { id });
export const activateCaseProject = (id: string) =>
  invoke<void>("case_project_activate", { id });

// ── Case datasource (local, or mirrored from Qase) ──
export const casesDatasource = () => invoke<CasesDatasource>("cases_datasource_get");
export const saveCasesDatasource = (datasource: CasesDatasource, token?: string | null) =>
  invoke<CasesDatasource>("cases_datasource_set", { datasource, token });
export const pullCases = () => invoke<PullSummary>("cases_pull");
/** Projects the token can see. Pass a just-typed token to preview it before saving. */
export const listQaseProjects = (token?: string | null, projectId?: string) =>
  invoke<{ ok: boolean; projects?: { code: string; title: string }[]; error?: string }>(
    "cases_qase_projects",
    { token, projectId },
  );

/** Pass the on-screen token/code to test them before they're saved. */
export const testCasesDatasource = (
  token?: string | null,
  projectCode?: string,
  projectId?: string,
) =>
  invoke<{ ok: boolean; project?: string; error?: string }>("cases_datasource_test", {
    token,
    projectCode,
    projectId,
  });
export const recordCaseResult = (result: Omit<CaseResult, "id" | "at">) =>
  invoke<CaseResult>("case_record_result", { result });
export const pickCaseCsv = () => invoke<string | null>("cases_pick_csv");
export const pickCaseExportPath = () => invoke<string | null>("cases_pick_export");
export const previewCaseImport = (file: string) =>
  invoke<CasePreview>("cases_import_preview", { file });
export const importCases = (options: {
  file: string;
  mapping: Record<string, string>;
  stamp?: Record<string, string>;
  overwrite?: boolean;
}) => invoke<ImportResult>("cases_import", { options });
export const exportCases = (file: string) => invoke<number>("cases_export", { file });

export const listPlans = () => invoke<TestPlan[]>("plans_list");
export const savePlan = (plan: TestPlanInput) => invoke<TestPlan[]>("plan_save", { plan });
export const deletePlan = (id: string) => invoke<TestPlan[]>("plan_delete", { id });
export const previewPlan = (id: string) => invoke<PlanRunEntry[]>("plan_preview", { id });
export const runPlan = (id: string, deviceId?: string) =>
  invoke<PlanRun>("plan_run", { id, deviceId });
export const cancelPlanRun = (id: string) => invoke<void>("plan_run_cancel", { id });
export const planRuns = () => invoke<PlanRun[]>("plan_runs");

export const scaffoldFlowFromCase = (options: {
  ref: string;
  column?: string;
  target?: string;
  tags?: string[];
}) => invoke<{ flow: string; todos: number }>("case_scaffold_flow", { options });
export const caseStepCoverage = (ref: string, column?: string) =>
  invoke<StepCoverage>("case_step_coverage", { ref, column });
export const listStepPoms = () => invoke<FlowCatalogEntry[]>("case_step_poms");
export const caseAutomationBrief = (ref: string, column?: string) =>
  invoke<string>("case_automation_brief", { ref, column });
export const readCaseFlow = (flow: string) => invoke<string>("case_flow_text", { flow });


// ── Agentic test reports ──
export const listReports = () => invoke<TestReport[]>("reports_list");
export const deleteReport = (id: string) => invoke<void>("report_delete", { id });
export const openReport = (path: string) => invoke<void>("report_open", { path });
export const revealReport = (path: string) => invoke<void>("report_reveal", { path });
export const reportHtml = (id: string) => invoke<string>("report_html", { id });
export const reportMarkdown = (id: string) => invoke<string>("report_markdown", { id });
export const currentTestSession = () => invoke<TestSession | null>("test_session");
export const clearTestSession = () => invoke<void>("test_session_clear");

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

// Conductor version override — renderer reads status and pins a version; main
// provisions it into <userData>/conductor/<version>/.
export const getConductorStatus = () => invoke<ConductorStatus>("conductor_status");
/** Published conductor versions >= the bundled one, newest first. */
export const listConductorVersions = () => invoke<string[]>("conductor_versions");
export const setConductorVersion = (version: string | null) =>
  invoke<ConductorStatus>("conductor_set_version", { version });
