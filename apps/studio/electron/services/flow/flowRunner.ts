import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";

import type {
  CommandResult,
  FlowEngine,
  FlowRun,
  MaestroStatus,
  RunLogLine,
} from "../../../app/lib/types";
import { broadcastToRenderers } from "../../broadcast";
import { appState } from "../../state";
import { runCommandLine } from "../conductor/conductorService";
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

/** Prefer system maestro; fall back to conductor run-flow when absent. */
export async function runFlow(
  relPath: string,
  deviceId?: string,
): Promise<{ runId: string }> {
  const status = await getMaestroStatus();
  const absPath = flowAbsolutePath(relPath);
  const runId = nextRunId();

  let bin: string;
  let args: string[];
  const engine = status.activeEngine;

  if (engine === "maestro") {
    bin = "maestro";
    args = ["test", absPath, ...(deviceId ? ["--device", deviceId] : [])];
  } else {
    const resolved = await resolveConductor();
    if (!resolved) throw new Error("Neither maestro nor conductor is available to run flows.");
    bin = resolved.bin;
    args = [...resolved.prefixArgs, "run-flow", absPath, ...(deviceId ? ["--device", deviceId] : [])];
  }

  const runRecord: FlowRun = {
    runId,
    flowPath: relPath,
    engine,
    status: "running",
    startedAt: Date.now(),
  };
  appState.flowRuns.set(runId, runRecord);

  emitLine(runId, {
    id: `${runId}-cmd`,
    tone: "command",
    text: `$ ${engine} ${args.join(" ")}`,
  });
  broadcastToRenderers(`flow_run_status:${runId}`, runRecord);

  const child = spawn(bin, args, { env: process.env });
  processes.set(runId, child);

  let lineSeq = 0;
  const pump = (chunk: Buffer, tone: RunLogLine["tone"]) => {
    for (const raw of chunk.toString().split(/\r?\n/)) {
      if (raw.length === 0) continue;
      lineSeq += 1;
      emitLine(runId, { id: `${runId}-${lineSeq}`, text: raw, tone: toneForLine(raw, tone) });
    }
  };
  child.stdout?.on("data", (c: Buffer) => pump(c, "default"));
  child.stderr?.on("data", (c: Buffer) => pump(c, "muted"));

  child.on("error", (err) => {
    finish(runId, "error");
    emitLine(runId, { id: `${runId}-err`, tone: "error", text: err.message });
  });
  child.on("close", (code) => {
    processes.delete(runId);
    const record = appState.flowRuns.get(runId);
    if (record?.status === "cancelled") return;
    finish(runId, code === 0 ? "passed" : "failed");
  });

  return { runId };
}

function toneForLine(line: string, fallback: RunLogLine["tone"]): RunLogLine["tone"] {
  const l = line.toLowerCase();
  if (/(✓|passed|success|completed)/.test(line) || l.includes("pass")) return "success";
  if (/(✗|✘|failed|error|exception|timed out)/.test(line) || l.includes("fail")) return "error";
  if (l.includes("warn")) return "warning";
  return fallback;
}

function emitLine(runId: string, line: RunLogLine): void {
  broadcastToRenderers(`flow_run_output:${runId}`, line);
}

function finish(runId: string, status: FlowRun["status"]): void {
  const record = appState.flowRuns.get(runId);
  if (!record) return;
  record.status = status;
  record.finishedAt = Date.now();
  broadcastToRenderers(`flow_run_status:${runId}`, record);
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

/**
 * The REPL always drives the device through conductor (the live control layer),
 * regardless of which engine runs full flows.
 */
export async function runCommand(command: string, deviceId: string): Promise<CommandResult> {
  return runCommandLine(command, deviceId);
}
