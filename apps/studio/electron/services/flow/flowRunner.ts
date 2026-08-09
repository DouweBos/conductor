import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const processes = new Map<string, ChildProcess>();
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
  // Tag filtering is a maestro feature; conductor ignores it.
  if (engine === "maestro") {
    if (options?.includeTags) args.push("--include-tags", options.includeTags);
    if (options?.excludeTags) args.push("--exclude-tags", options.excludeTags);
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
  const args = buildFlowArgs(engine, absDir, deviceId, options);
  return launch({ engine, ...args, flowPath: relDir ?? ".", deviceId, steps: [] });
}

/** Run an inline snippet (REPL multi-step / editor selection). */
export async function runFlowInline(
  snippet: string,
  deviceId?: string,
  appId?: string,
): Promise<{ runId: string }> {
  const status = await getMaestroStatus();
  const engine = status.activeEngine;
  const dir = mkdtempSync(path.join(tmpdir(), "conductor-studio-"));
  const file = path.join(dir, "snippet.yaml");
  const header = appId ? `appId: ${appId}\n---\n` : "";
  const body = header + snippet.trim() + "\n";
  writeFileSync(file, body, "utf8");
  const args = buildFlowArgs(engine, file, deviceId);
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
  flowPath: string;
  deviceId?: string;
  steps: FlowStep[];
  cleanupDir?: string;
}

async function launch(spec: LaunchArgs): Promise<{ runId: string }> {
  let bin = spec.bin;
  let args = spec.args;
  if (bin === "__conductor__") {
    const resolved = await resolveConductor();
    if (!resolved) throw new Error("Neither maestro nor conductor is available to run flows.");
    bin = resolved.bin;
    args = [...resolved.prefixArgs, ...spec.args];
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

  emitLine(runId, { id: `${runId}-cmd`, tone: "command", text: `$ ${spec.engine} ${spec.args.join(" ")}` });
  broadcastToRenderers(`flow_run_status:${runId}`, record);
  broadcastToRenderers(`flow_run_steps:${runId}`, steps);

  const child = spawn(bin, args, { env: process.env });
  processes.set(runId, child);

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
      if (tone === "success") advance(true);
      else if (tone === "error") advance(false);
    }
  };
  child.stdout?.on("data", (c: Buffer) => pump(c, "default"));
  child.stderr?.on("data", (c: Buffer) => pump(c, "muted"));

  child.on("error", (err) => {
    emitLine(runId, { id: `${runId}-err`, tone: "error", text: err.message });
    finish(runId, "error", spec);
  });
  child.on("close", (code) => {
    processes.delete(runId);
    const rec = appState.flowRuns.get(runId);
    if (rec?.status === "cancelled") {
      cleanup(spec);
      return;
    }
    finish(runId, code === 0 ? "passed" : "failed", spec);
  });

  return { runId };
}

function finish(runId: string, status: FlowRun["status"], spec: LaunchArgs): void {
  const record = appState.flowRuns.get(runId);
  if (record) {
    record.status = status;
    record.finishedAt = Date.now();
    broadcastToRenderers(`flow_run_status:${runId}`, record);
  }
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

function toneForLine(line: string, fallback: RunLogLine["tone"]): RunLogLine["tone"] {
  if (/(✓|✅|\bpassed\b|\bsuccess\b|\bcompleted\b|COMPLETED)/.test(line)) return "success";
  if (/(✗|✘|❌|\bfailed\b|\berror\b|\bexception\b|timed out|FAILED)/i.test(line)) return "error";
  if (/\bwarn/i.test(line)) return "warning";
  return fallback;
}

function emitLine(runId: string, line: RunLogLine): void {
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
