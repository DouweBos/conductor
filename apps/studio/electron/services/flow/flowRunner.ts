import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { parse as parseYaml } from "yaml";

import type {
  CommandResult,
  DeviceInfo,
  FlowEngine,
  FlowRun,
  FlowStep,
  MaestroStatus,
  RunLogLine,
  RunOptions,
  RunRecord,
} from "../../../app/lib/types";
import { broadcastToRenderers } from "../../broadcast";
import { appState } from "../../state";
import { captureUi, listDevices, runCommandLine } from "../conductor/conductorService";
import { getProjectInfo } from "../file/fileService";
import { detectConductor, detectMaestro, resolveConductor } from "../maestro/maestroService";
import { deviceMatches, wantedPlatforms } from "../../../app/lib/platforms";
import { tagsOf } from "./suite";
import { endReservation, reserveDevice } from "../device/reservations";
import { listCases } from "../cases/casesService";
import { recordRunResult } from "../cases/resultsService";
import { artifactDirFor, recordRun } from "./history";

const processes = new Map<string, ChildProcess>();
/** Callers waiting on a run's outcome — plan execution runs flows in sequence. */
const waiters = new Map<string, ((status: FlowRun["status"]) => void)[]>();
/** Tail of each run's output, kept for the history record. */
const outputTail = new Map<string, string[]>();
const OUTPUT_TAIL = 400;
let runCounterSeed = 0;

function nextRunId(): string {
  runCounterSeed += 1;
  return `run-${Date.now()}-${runCounterSeed}`;
}

export async function getMaestroStatus(): Promise<MaestroStatus> {
  const [maestro, conductor] = await Promise.all([detectMaestro(), detectConductor()]);
  const activeEngine: FlowEngine = maestro.available ? "maestro" : "conductor";
  return {
    maestroAvailable: maestro.available,
    maestroVersion: maestro.version,
    conductorAvailable: conductor.available,
    conductorVersion: conductor.version,
    activeEngine,
  };
}

function flowAbsolutePath(relPath: string): string {
  const project = getProjectInfo();
  if (!project) throw new Error("No project is open.");
  return path.resolve(project.flowsDir, relPath);
}

function optionArgs(engine: FlowEngine, options?: RunOptions): string[] {
  const args: string[] = [];
  if (options?.env) {
    for (const [k, v] of Object.entries(options.env)) {
      args.push("--env", `${k}=${v}`);
    }
  }
  // Tag filtering and sharding are maestro features; conductor ignores them.
  if (engine === "maestro") {
    if (options?.includeTags) args.push("--include-tags", options.includeTags);
    if (options?.excludeTags) args.push("--exclude-tags", options.excludeTags);
    if (options?.shards && options.shards > 1) args.push("--shard-split", String(options.shards));
  }
  return args;
}

/**
 * The flow's top-level steps, hooks included. `onFlowStart` usually does the
 * heavy lifting (launch, sign-in, seeding) and takes most of a run's wall
 * clock, so leaving it out of the checklist meant staring at "step 1/18" for a
 * minute. It also keeps the list aligned with maestro's output, which reports
 * hook steps at the same level as the body's.
 */
function parseStepLabels(source: string): string[] {
  const separator = source.indexOf("\n---");
  const header = separator >= 0 ? source.slice(0, separator) : "";
  const body = separator >= 0 ? source.slice(separator + 4) : source;
  return [
    ...hookLabels(header, "onFlowStart"),
    ...bodyLabels(body),
    ...hookLabels(header, "onFlowComplete"),
  ];
}

function hookLabels(header: string, hook: "onFlowStart" | "onFlowComplete"): string[] {
  try {
    const doc = parseYaml(header) as Record<string, unknown> | null;
    const entries = doc?.[hook];
    if (!Array.isArray(entries)) return [];
    return entries.map((step) => `${hook}: ${labelForStep(step)}`);
  } catch {
    return [];
  }
}

function bodyLabels(body: string): string[] {
  try {
    const doc = parseYaml(body);
    if (Array.isArray(doc)) return doc.map(labelForStep);
  } catch {
    // fall through to line heuristic
  }
  return body
    .split(/\r?\n/)
    .filter((l) => /^\s*-\s+/.test(l))
    .map((l) => l.replace(/^\s*-\s+/, "").trim().slice(0, 60));
}

function labelForStep(step: unknown): string {
  if (typeof step === "string") return step;
  if (!step || typeof step !== "object") return "step";
  const key = Object.keys(step as Record<string, unknown>)[0];
  const val = (step as Record<string, unknown>)[key];
  if (typeof val === "string") return `${key}: ${val}`;
  // `tapOn: { id: foo }` reads as "tapOn" on its own — carry the selector.
  if (val && typeof val === "object") {
    const detail = Object.entries(val as Record<string, unknown>)
      .filter(([, v]) => typeof v === "string" || typeof v === "number")
      .slice(0, 2)
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");
    return detail ? `${key}: ${detail}` : (key ?? "step");
  }
  return key ?? "step";
}

// ── Public entry points ─────────────────────────────────────────────────────

export async function runFlow(
  relPath: string,
  deviceId?: string,
  options?: RunOptions,
  /** Which platform this flow is for, when the caller knows (a case column). */
  platform?: string,
): Promise<{ runId: string; deviceId?: string }> {
  const status = await getMaestroStatus();
  const absPath = flowAbsolutePath(relPath);
  const engine = status.activeEngine;
  // Pick the device here rather than letting the runner choose one silently:
  // the caller has to know which screen to watch, the device has to be reserved
  // under the id it runs on, and a tv flow on a phone simulator fails in ways
  // that look like the flow's fault.
  const source = safeRead(absPath);
  // The flow's tags are what the suite configs select on, so they decide the
  // device; the caller's column only breaks ties for `common` flows.
  const target = await resolveDevice(deviceId, platformFromTags(source) ?? platform ?? "");
  const args = buildFlowArgs(engine, absPath, target, options);
  const steps = parseStepLabels(source).map(toStep);
  const { runId } = await launch({ engine, ...args, flowPath: relPath, deviceId: target, steps });
  if (target && deviceId && target !== deviceId) {
    emitLine(runId, {
      id: `${runId}-device`,
      tone: "warning",
      text: `Running on ${target}: the selected device is the wrong platform for this flow.`,
    });
  }
  return { runId, deviceId: target };
}

/**
 * Device platforms a flow is asking for. The hint is either a case's platform
 * column or the flow's own path — both encode the same thing here
 * (`.tv.yaml` / `.responsive.yaml`), so neither needs configuring.
 */
/**
 * Which platform a flow is for, from its own `tags:` — the same thing the suite
 * configs select on (`includeTags: [common, tv]`), so a flow that runs in the
 * tv suite is a flow that wants a tv device. Draft variants count: `tv-draft`
 * is still a tv flow, it just isn't in the suite yet.
 *
 * `common` flows say nothing about platform, so the caller's hint decides.
 */
function platformFromTags(source: string): string | null {
  for (const tag of tagsOf(source)) {
    const base = tag.replace(/-draft$/, "").toLowerCase();
    if (wantedPlatforms(base)) return base;
  }
  return null;
}

/**
 * The device a run lands on. A device the caller named wins — unless it's the
 * wrong platform for the flow, which is never what anyone meant.
 */
async function resolveDevice(
  deviceId: string | undefined,
  hint: string,
): Promise<string | undefined> {
  let devices: DeviceInfo[] = [];
  try {
    devices = await listDevices();
  } catch {
    // No conductor, no device list — trust the caller, or let the runner pick.
    return deviceId;
  }
  const named = devices.find((d) => d.id === deviceId);
  if (named && deviceMatches(named, hint)) return deviceId;

  const booted = devices.filter((d) => d.state === "booted");
  const matching = booted.filter((d) => deviceMatches(d, hint));
  return (
    matching.find((d) => !d.reservedBy)?.id ??
    matching[0]?.id ??
    deviceId ??
    booted.find((d) => !d.reservedBy)?.id ??
    booted[0]?.id
  );
}

/** Run all flows in a directory (default: the flows root). */
export async function runFolder(
  relDir: string | undefined,
  deviceId?: string,
  options?: RunOptions,
): Promise<{ runId: string }> {
  const project = getProjectInfo();
  if (!project) throw new Error("No project is open.");
  const absDir = relDir ? path.resolve(project.flowsDir, relDir) : project.flowsDir;
  const status = await getMaestroStatus();
  const engine = status.activeEngine;
  // maestro runs a whole directory; conductor only takes one flow file, so we
  // expand the folder and run the flows in sequence under a single run.
  // conductor has its own parallel runner; maestro shards in-process.
  if (engine === "conductor" && options?.shards && options.shards > 1) {
    const resolved = await resolveConductor();
    if (!resolved) throw new Error("Conductor CLI is not available.");
    return launch({
      engine,
      bin: "__conductor__",
      args: ["run-parallel", "--flows-dir", absDir],
      flowPath: relDir ?? ".",
      deviceId,
      steps: [],
    });
  }
  const targets = engine === "maestro" ? [absDir] : flowFilesIn(absDir);
  if (!targets.length) throw new Error(`No flows found in ${absDir}`);
  const first = buildFlowArgs(engine, targets[0], deviceId, options);
  return launch({
    engine,
    bin: first.bin,
    args: first.args,
    queue: targets.map((t) => buildFlowArgs(engine, t, deviceId, options).args),
    flowPath: relDir ?? ".",
    deviceId,
    steps: [],
  });
}

/**
 * Run one flow N times to see whether it's actually stable. Each iteration is
 * its own run record, grouped so the history can show a pass rate.
 */
export async function runRepeat(
  relPath: string,
  times: number,
  deviceId?: string,
  options?: RunOptions,
): Promise<{ runIds: string[] }> {
  const group = `repeat-${Date.now()}`;
  const runIds: string[] = [];
  for (let i = 0; i < Math.max(1, times); i++) {
    const status = await getMaestroStatus();
    const absPath = flowAbsolutePath(relPath);
    const args = buildFlowArgs(status.activeEngine, absPath, deviceId, options);
    const { runId } = await launch({
      engine: status.activeEngine,
      ...args,
      flowPath: relPath,
      deviceId,
      steps: safeReadSteps(absPath),
      repeatGroup: group,
    });
    runIds.push(runId);
    await settled(runId);
  }
  return { runIds };
}

/** Resolve once a run leaves the running state. */
function settled(runId: string): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      const record = appState.flowRuns.get(runId);
      if (!record || record.status !== "running") resolve();
      else setTimeout(check, 250);
    };
    check();
  });
}

/** Run an inline snippet (REPL multi-step / editor selection). */
export async function runFlowInline(
  snippet: string,
  deviceId?: string,
  appId?: string,
  options?: RunOptions,
): Promise<{ runId: string }> {
  const status = await getMaestroStatus();
  const engine = status.activeEngine;
  const dir = mkdtempSync(path.join(tmpdir(), "conductor-studio-"));
  const file = path.join(dir, "snippet.yaml");
  const header = appId ? `appId: ${appId}\n---\n` : "";
  const body = header + snippet.trim() + "\n";
  writeFileSync(file, body, "utf8");
  const args = buildFlowArgs(engine, file, deviceId, options);
  const steps = parseStepLabels(body).map(toStep);
  return launch({
    engine,
    ...args,
    flowPath: "(inline)",
    deviceId,
    steps,
    cleanupDir: dir,
  });
}

function buildFlowArgs(
  engine: FlowEngine,
  target: string,
  deviceId?: string,
  options?: RunOptions,
): { bin: string; args: string[] } {
  const device = deviceId ? ["--device", deviceId] : [];
  if (engine === "maestro") {
    return { bin: "maestro", args: ["test", target, ...device, ...optionArgs(engine, options)] };
  }
  // conductor is resolved lazily in launch(); placeholder replaced there.
  return { bin: "__conductor__", args: ["run-flow", target, ...device, ...optionArgs(engine, options)] };
}

/** Flow files under a directory, recursively, in stable order. */
function flowFilesIn(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith(".")) continue; // .templates and friends are not runnable
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...flowFilesIn(full));
    else if (/\.(ya?ml|js)$/.test(name)) out.push(full);
  }
  return out;
}

function safeRead(absPath: string): string {
  try {
    return readFileSync(absPath, "utf8");
  } catch {
    return "";
  }
}

function safeReadSteps(absPath: string): FlowStep[] {
  return parseStepLabels(safeRead(absPath)).map(toStep);
}

function toStep(label: string, i: number): FlowStep {
  return { id: `s${i}`, label, status: "pending" };
}

// ── Core launcher ────────────────────────────────────────────────────────────

interface LaunchArgs {
  engine: FlowEngine;
  bin: string;
  args: string[];
  /** Arg sets to run in sequence under one run id (folder runs on conductor). */
  queue?: string[][];
  flowPath: string;
  deviceId?: string;
  steps: FlowStep[];
  cleanupDir?: string;
  /** Set when this run is one iteration of a repeat, so history can group them. */
  repeatGroup?: string;
}

async function launch(spec: LaunchArgs): Promise<{ runId: string }> {
  // Claim the device before anything spawns: a run sharing a device with another
  // agent tests whatever that agent happened to leave on screen. Every entry
  // point funnels through here, so this covers Run, Run all and per-step runs.
  if (spec.deviceId) await reserveDevice(spec.deviceId, `running ${spec.flowPath}`);

  let bin = spec.bin;
  let prefix: string[] = [];
  let env = process.env;
  if (bin === "__conductor__") {
    const resolved = await resolveConductor();
    if (!resolved) {
      // Nothing will spawn, so hand the device straight back.
      if (spec.deviceId) await endReservation(spec.deviceId);
      throw new Error("Neither maestro nor conductor is available to run flows.");
    }
    bin = resolved.bin;
    prefix = resolved.prefixArgs;
    env = resolved.env;
  }

  const runId = nextRunId();
  const steps = spec.steps.map((s) => ({ ...s }));
  const record: FlowRun = {
    runId,
    flowPath: spec.flowPath,
    engine: spec.engine,
    status: "running",
    startedAt: Date.now(),
  };
  appState.flowRuns.set(runId, record);

  broadcastToRenderers(`flow_run_status:${runId}`, record);
  broadcastToRenderers(`flow_run_steps:${runId}`, steps);

  let lineSeq = 0;
  const tracker = new StepTracker(steps, () =>
    broadcastToRenderers(`flow_run_steps:${runId}`, steps.map((s) => ({ ...s }))),
  );
  if (steps.length) {
    steps[0].status = "running";
    broadcastToRenderers(`flow_run_steps:${runId}`, steps.map((s) => ({ ...s })));
  }

  const pump = (chunk: Buffer, fallback: RunLogLine["tone"]) => {
    // A killed process group can still flush buffered output; a cancelled run
    // must stop growing its log.
    if (appState.flowRuns.get(runId)?.status === "cancelled") return;
    for (const raw of chunk.toString().split(/\r?\n/)) {
      if (!raw.length) continue;
      lineSeq += 1;
      const tone = toneForLine(raw, fallback);
      emitLine(runId, { id: `${runId}-${lineSeq}`, text: raw, tone });
      tracker.consume(raw);
    }
  };

  const queue = spec.queue?.length ? spec.queue : [spec.args];
  const runNext = (index: number, failedSoFar: boolean): void => {
    const argSet = queue[index];
    emitLine(runId, {
      id: `${runId}-cmd-${index}`,
      tone: "command",
      text: `$ ${spec.engine} ${argSet.join(" ")}`,
    });
    // Own process group: maestro is a shell wrapper around java, so signalling
    // only the direct child leaves the real runner alive and still logging.
    const child = spawn(bin, [...prefix, ...argSet], { env, detached: true });
    processes.set(runId, child);
    child.stdout?.on("data", (c: Buffer) => pump(c, "default"));
    child.stderr?.on("data", (c: Buffer) => pump(c, "muted"));

    child.on("error", (err) => {
      processes.delete(runId);
      if (appState.flowRuns.get(runId)?.status === "cancelled") {
        settle(runId, "cancelled");
        cleanup(spec);
        return;
      }
      emitLine(runId, { id: `${runId}-err-${index}`, tone: "error", text: err.message });
      finish(runId, "error", spec);
    });
    child.on("close", (code) => {
      processes.delete(runId);
      tracker.end(code === 0);
      if (appState.flowRuns.get(runId)?.status === "cancelled") {
        settle(runId, "cancelled");
        cleanup(spec);
        return;
      }
      const failed = failedSoFar || code !== 0;
      if (index + 1 < queue.length) runNext(index + 1, failed);
      else finish(runId, failed ? "failed" : "passed", spec);
    });
  };
  runNext(0, false);

  return { runId };
}

/** Resolves when a run ends, so a plan can run its cases one after another. */
export function awaitRun(runId: string): Promise<FlowRun["status"]> {
  const record = appState.flowRuns.get(runId);
  if (record && record.status !== "running") return Promise.resolve(record.status);
  return new Promise((resolve) => {
    waiters.set(runId, [...(waiters.get(runId) ?? []), resolve]);
  });
}

function settle(runId: string, status: FlowRun["status"]): void {
  for (const resolve of waiters.get(runId) ?? []) resolve(status);
  waiters.delete(runId);
}

function finish(runId: string, status: FlowRun["status"], spec: LaunchArgs): void {
  const record = appState.flowRuns.get(runId);
  if (record) {
    record.status = status;
    record.finishedAt = Date.now();
    broadcastToRenderers(`flow_run_status:${runId}`, record);
    // Maestro writes its debug output as it goes, so it exists by now.
    const finished: RunRecord = {
      runId,
      flowPath: record.flowPath,
      engine: record.engine,
      status,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      deviceId: spec.deviceId,
      artifactDir: record.engine === "maestro" ? artifactDirFor(record.startedAt) : undefined,
      output: outputTail.get(runId) ?? [],
      repeatGroup: spec.repeatGroup,
    };
    recordRun(finished);
    // Any flow run counts as an execution of the cases that claim that flow,
    // wherever in Studio it was started from.
    void listCases()
      .then((cases) => recordRunResult(finished, cases))
      .catch(() => {});
    broadcastToRenderers("runs:updated", runId);
  }
  settle(runId, status);
  outputTail.delete(runId);
  // Capture a screenshot of the current screen when a run fails, for triage.
  if ((status === "failed" || status === "error") && spec.deviceId) {
    captureUi(spec.deviceId)
      .then((cap) => {
        if (cap.screenshot) broadcastToRenderers(`flow_run_screenshot:${runId}`, cap.screenshot);
      })
      .catch(() => {});
  }
  cleanup(spec);
}

function cleanup(spec: LaunchArgs): void {
  if (spec.deviceId) void endReservation(spec.deviceId);
  if (spec.cleanupDir) {
    try {
      rmSync(spec.cleanupDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

/**
 * Turns maestro's output into per-step results.
 *
 * Indentation is what makes this possible: maestro announces a top-level step
 * at column 0 (`Tap on id: foo...`) and everything a subflow does underneath it
 * is indented. Counting every `... COMPLETED` — which is what this used to do —
 * marked the whole checklist done inside the first subflow, because one
 * `runFlow` can emit dozens of them.
 *
 * A leaf step's status arrives on the *next* line (a bare ` COMPLETED`), while
 * a subflow step is repeated at column 0 with its status appended. So a step is
 * resolved either by its own repeat or by the next top-level announcement,
 * using the last status seen since it started.
 */
const STATUS = /(COMPLETED|FAILED|SKIPPED|WARNED|ERROR)/;

class StepTracker {
  private cursor = 0;
  /** Most recent status seen since the current step started. */
  private pending: "passed" | "failed" | null = null;

  constructor(
    private readonly steps: FlowStep[],
    private readonly publish: () => void,
  ) {}

  consume(line: string): void {
    const topLevel = /^\S/.test(line);
    const status = STATUS.exec(line);
    const verdict = status ? (status[1] === "FAILED" || status[1] === "ERROR" ? "failed" : "passed") : null;

    if (topLevel) {
      // `Run x.yaml... COMPLETED` — the running step's own result.
      if (verdict && /\.\.\.\s*\w+\s*$/.test(line)) {
        this.resolve(verdict);
        return;
      }
      // `Tap on id: foo...` — a new top-level step; the previous one is over.
      if (/\.\.\.\s*$/.test(line)) {
        this.resolve(this.pending ?? "passed");
        this.start();
        return;
      }
      return;
    }
    // Nested: only worth remembering as the outcome of whatever is running.
    if (verdict) this.pending = verdict;
  }

  /** The process is done; nothing more will report, so close the open step. */
  end(ok: boolean): void {
    if (this.cursor < this.steps.length && this.steps[this.cursor].status === "running") {
      this.resolve(ok ? (this.pending ?? "passed") : "failed");
    }
    this.publish();
  }

  private start(): void {
    if (this.cursor >= this.steps.length) return;
    this.steps[this.cursor].status = "running";
    this.pending = null;
    this.publish();
  }

  private resolve(verdict: "passed" | "failed"): void {
    const step = this.steps[this.cursor];
    if (!step || step.status !== "running") return;
    step.status = verdict;
    this.cursor += 1;
    this.pending = null;
    this.publish();
  }
}

function toneForLine(line: string, fallback: RunLogLine["tone"]): RunLogLine["tone"] {
  if (/(✓|✅|\bpassed\b|\bsuccess\b|\bcompleted\b|COMPLETED)/.test(line)) return "success";
  if (/(✗|✘|❌|\bfailed\b|\berror\b|\bexception\b|timed out|FAILED)/i.test(line)) return "error";
  if (/\bwarn/i.test(line)) return "warning";
  return fallback;
}

function emitLine(runId: string, line: RunLogLine): void {
  const tail = outputTail.get(runId) ?? [];
  tail.push(line.text);
  if (tail.length > OUTPUT_TAIL) tail.shift();
  outputTail.set(runId, tail);
  broadcastToRenderers(`flow_run_output:${runId}`, line);
}

export function cancelRun(runId: string): void {
  const child = processes.get(runId);
  const record = appState.flowRuns.get(runId);
  if (record) {
    record.status = "cancelled";
    record.finishedAt = Date.now();
    broadcastToRenderers(`flow_run_status:${runId}`, record);
  }
  if (child) {
    signalGroup(child, "SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) signalGroup(child, "SIGKILL");
    }, 2000);
    child.stdout?.destroy();
    child.stderr?.destroy();
    processes.delete(runId);
  }
}

/** Quitting must not orphan detached runner process groups. */
export function stopAllRuns(): void {
  for (const runId of [...processes.keys()]) cancelRun(runId);
}

/** Signal the child's whole process group, falling back to the child alone. */
function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

/** REPL: run a raw conductor CLI command against the device. */
export async function runCommand(command: string, deviceId: string): Promise<CommandResult> {
  return runCommandLine(command, deviceId);
}
