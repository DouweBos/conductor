import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { parse as parseYaml } from "yaml";

import type {
  CommandResult,
  FlowEngine,
  FlowRun,
  FlowStep,
  MaestroStatus,
  RunLogLine,
  RunOptions,
} from "../../../app/lib/types";
import { broadcastToRenderers } from "../../broadcast";
import { appState } from "../../state";
import { captureUi, runCommandLine } from "../conductor/conductorService";
import { getProjectInfo } from "../file/fileService";
import { detectConductor, detectMaestro, resolveConductor } from "../maestro/maestroService";
import { artifactDirFor, recordRun } from "./history";

const processes = new Map<string, ChildProcess>();
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

/** Parse the top-level Maestro steps out of a flow body into human labels. */
function parseStepLabels(source: string): string[] {
  const body = source.includes("---") ? source.slice(source.indexOf("---") + 3) : source;
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
  if (step && typeof step === "object") {
    const key = Object.keys(step as Record<string, unknown>)[0];
    const val = (step as Record<string, unknown>)[key];
    if (typeof val === "string") return `${key}: ${val}`;
    return key ?? "step";
  }
  return "step";
}

// ── Public entry points ─────────────────────────────────────────────────────

export async function runFlow(
  relPath: string,
  deviceId?: string,
  options?: RunOptions,
): Promise<{ runId: string }> {
  const status = await getMaestroStatus();
  const absPath = flowAbsolutePath(relPath);
  const engine = status.activeEngine;
  const args = buildFlowArgs(engine, absPath, deviceId, options);
  const steps = safeReadSteps(absPath);
  return launch({ engine, ...args, flowPath: relPath, deviceId, steps });
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
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...flowFilesIn(full));
    else if (/\.(ya?ml|js)$/.test(name)) out.push(full);
  }
  return out;
}

function safeReadSteps(absPath: string): FlowStep[] {
  try {
    return parseStepLabels(readFileSync(absPath, "utf8")).map(toStep);
  } catch {
    return [];
  }
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
  let bin = spec.bin;
  let prefix: string[] = [];
  let env = process.env;
  if (bin === "__conductor__") {
    const resolved = await resolveConductor();
    if (!resolved) throw new Error("Neither maestro nor conductor is available to run flows.");
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

  let cursor = 0;
  let lineSeq = 0;
  const advance = (passed: boolean) => {
    if (cursor >= steps.length) return;
    steps[cursor].status = passed ? "passed" : "failed";
    cursor += 1;
    if (passed && cursor < steps.length) steps[cursor].status = "running";
    broadcastToRenderers(`flow_run_steps:${runId}`, steps.map((s) => ({ ...s })));
  };
  if (steps.length) {
    steps[0].status = "running";
    broadcastToRenderers(`flow_run_steps:${runId}`, steps.map((s) => ({ ...s })));
  }

  const pump = (chunk: Buffer, fallback: RunLogLine["tone"]) => {
    for (const raw of chunk.toString().split(/\r?\n/)) {
      if (!raw.length) continue;
      lineSeq += 1;
      const tone = toneForLine(raw, fallback);
      emitLine(runId, { id: `${runId}-${lineSeq}`, text: raw, tone });
      const outcome = stepOutcome(raw);
      if (outcome) advance(outcome === "passed");
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
    const child = spawn(bin, [...prefix, ...argSet], { env });
    processes.set(runId, child);
    child.stdout?.on("data", (c: Buffer) => pump(c, "default"));
    child.stderr?.on("data", (c: Buffer) => pump(c, "muted"));

    child.on("error", (err) => {
      emitLine(runId, { id: `${runId}-err-${index}`, tone: "error", text: err.message });
      processes.delete(runId);
      finish(runId, "error", spec);
    });
    child.on("close", (code) => {
      processes.delete(runId);
      if (appState.flowRuns.get(runId)?.status === "cancelled") {
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

function finish(runId: string, status: FlowRun["status"], spec: LaunchArgs): void {
  const record = appState.flowRuns.get(runId);
  if (record) {
    record.status = status;
    record.finishedAt = Date.now();
    broadcastToRenderers(`flow_run_status:${runId}`, record);
    // Maestro writes its debug output as it goes, so it exists by now.
    recordRun({
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
    });
    broadcastToRenderers("runs:updated", runId);
  }
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
  if (spec.cleanupDir) {
    try {
      rmSync(spec.cleanupDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

/**
 * Per-step result lines, which drive the step checklist. maestro prints
 * `<description>... COMPLETED|FAILED`; conductor prints `  → <step> ... ok|FAILED`.
 * Run summaries ("✓ run-flow … done") deliberately don't match.
 */
function stepOutcome(line: string): "passed" | "failed" | null {
  const maestro = /\.\.\.\s*(COMPLETED|FAILED|SKIPPED|WARNED)\s*$/.exec(line);
  if (maestro) return maestro[1] === "FAILED" ? "failed" : "passed";
  const conductor = /^\s*→\s.*\.\.\.\s*(ok|FAILED|skipped)\s*$/.exec(line);
  if (conductor) return conductor[1] === "FAILED" ? "failed" : "passed";
  return null;
}

function toneForLine(line: string, fallback: RunLogLine["tone"]): RunLogLine["tone"] {
  const outcome = stepOutcome(line);
  if (outcome) return outcome === "passed" ? "success" : "error";
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
    child.kill("SIGTERM");
    setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
    }, 2000);
    processes.delete(runId);
  }
}

/** REPL: run a raw conductor CLI command against the device. */
export async function runCommand(command: string, deviceId: string): Promise<CommandResult> {
  return runCommandLine(command, deviceId);
}
