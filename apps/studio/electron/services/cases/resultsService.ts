import { existsSync, mkdirSync } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { RunRecord } from "../../../app/lib/types";
import { broadcastToRenderers } from "../../broadcast";
import { getProjectInfo } from "../file/fileService";
import { caseProjectDir, caseProjects, selectedProjects } from "./projects";
import type { Case, CaseResult, CaseStats, ResultStatus } from "./model";

/**
 * The execution log: every time a case was exercised, by whom, and how it went.
 * Cases say what should be true; this says what actually happened — flow runs,
 * manual walkthroughs and agentic reports alike.
 *
 * Append-only JSONL so two sessions on the same day merge without a conflict.
 */

const LOG = "results.jsonl";
/** How many recent executions decide "flaky". */
const FLAKE_WINDOW = 10;

let counter = 0;
/** runId -> plan run that started it, so plan executions stay attributable. */
const planClaims = new Map<string, string>();

export function claimRunForPlan(runId: string, planRunId: string): void {
  planClaims.set(runId, planRunId);
}

function logPath(projectId: string): string | null {
  if (!getProjectInfo()) return null;
  return path.join(caseProjectDir("cases", projectId), LOG);
}

/**
 * The sub-project a result belongs to, from its ref — `MC-12` is the mobile
 * project's, `TV-4` the tv one's. Falls back to the only project there is.
 */
function projectForRef(ref: string): string | null {
  const projects = caseProjects();
  const code = ref.split("-")[0];
  const match = projects.find((p) => p.datasource.projectCode === code);
  return (match ?? (projects.length === 1 ? projects[0] : undefined))?.id ?? null;
}

async function readLog(projectId: string): Promise<CaseResult[]> {
  const file = logPath(projectId);
  if (!file || !existsSync(file)) return [];
  const lines = (await readFile(file, "utf8")).split("\n").filter((l) => l.trim());
  const results: CaseResult[] = [];
  for (const line of lines) {
    try {
      results.push(JSON.parse(line) as CaseResult);
    } catch {
      // A half-written line (or a bad merge) must not hide the rest of the log.
    }
  }
  return results;
}

/** Executions across whatever the current selection covers. */
export async function listResults(): Promise<CaseResult[]> {
  const logs = await Promise.all(selectedProjects().map((p) => readLog(p.id)));
  return logs.flat().sort((a, b) => b.at - a.at);
}

export async function recordResult(
  input: Omit<CaseResult, "id" | "at"> & { at?: number },
): Promise<CaseResult> {
  // A result files against the sub-project that owns the case, not the one on
  // screen — a run can finish long after the user switched projects.
  const projectId = projectForRef(input.ref);
  const file = projectId ? logPath(projectId) : null;
  if (!file) throw new Error("No project is open.");
  counter += 1;
  const result: CaseResult = {
    ...input,
    id: `res-${Date.now()}-${counter}`,
    at: input.at ?? Date.now(),
  };
  mkdirSync(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(result)}\n`, "utf8");
  broadcastToRenderers("cases:result-recorded", result);
  return result;
}

/**
 * Drop the link from results to a report that was deleted. The execution is
 * history and stays; only the pointer to missing evidence goes.
 */
export async function detachReport(reportId: string): Promise<void> {
  for (const project of caseProjects()) await detachReportFrom(project.id, reportId);
}

async function detachReportFrom(projectId: string, reportId: string): Promise<void> {
  const file = logPath(projectId);
  if (!file || !existsSync(file)) return;
  const results = await readLog(projectId);
  if (!results.some((r) => r.report_id === reportId)) return;
  const kept = results
    .slice()
    .sort((a, b) => a.at - b.at)
    .map(({ ...r }) => {
      if (r.report_id === reportId) {
        delete r.report_id;
        r.comment = [r.comment, "(report deleted)"].filter(Boolean).join(" ");
      }
      return r;
    });
  await writeFile(file, kept.map((r) => `${JSON.stringify(r)}\n`).join(""), "utf8");
  broadcastToRenderers("cases:result-recorded", { detached: reportId });
}

/** Newest execution per case ref, and per `<ref>::<column>` when scoped. */
export function latestByCase(results: CaseResult[]): Record<string, CaseResult> {
  const latest: Record<string, CaseResult> = {};
  for (const r of results) {
    for (const key of [r.ref, r.column ? `${r.ref}::${r.column}` : null]) {
      if (!key) continue;
      if (!latest[key] || latest[key].at < r.at) latest[key] = r;
    }
  }
  return latest;
}

export function statsFor(ref: string, results: CaseResult[]): CaseStats {
  const mine = results.filter((r) => r.ref === ref);
  const decisive = mine.filter((r) => r.status === "passed" || r.status === "failed");
  const passed = decisive.filter((r) => r.status === "passed").length;
  const recent = decisive.slice(0, FLAKE_WINDOW);
  return {
    ref,
    total: mine.length,
    passed,
    failed: decisive.length - passed,
    passRate: decisive.length ? passed / decisive.length : 0,
    flaky: recent.some((r) => r.status === "passed") && recent.some((r) => r.status === "failed"),
    lastAt: mine[0]?.at,
  };
}

/** Attach each case's execution history, newest first. */
export function decorate(cases: Case[], results: CaseResult[]): Case[] {
  const byCase = new Map<string, CaseResult[]>();
  for (const r of results) byCase.set(r.ref, [...(byCase.get(r.ref) ?? []), r]);
  for (const c of cases) {
    const mine = byCase.get(c.ref) ?? [];
    c.results = mine;
    c.lastResult = mine[0];
  }
  return cases;
}

const RUN_STATUS: Record<string, ResultStatus> = {
  passed: "passed",
  failed: "failed",
  error: "failed",
  cancelled: "skipped",
};

/**
 * A finished local run counts as an execution of every case that names the flow
 * — running a flow from anywhere in Studio updates the matrix, not just the ▶
 * button on the Cases screen.
 */
export async function recordRunResult(record: RunRecord, cases: Case[]): Promise<void> {
  const status = RUN_STATUS[record.status];
  if (!status) return;
  for (const c of cases) {
    const columns = Object.entries(c.conductor?.flows ?? {})
      .filter(([, flow]) => flow === record.flowPath)
      .map(([column]) => column);
    if (c.conductor?.flow === record.flowPath) columns.push("");
    for (const column of columns) {
      await recordResult({
        case_id: c.id,
        ref: c.ref,
        column: column || undefined,
        status,
        source: "run",
        run_id: record.runId,
        flow: record.flowPath,
        device_id: record.deviceId,
        time_ms: record.finishedAt - record.startedAt,
        plan_run_id: planClaims.get(record.runId),
        at: record.finishedAt,
      });
    }
  }
  planClaims.delete(record.runId);
}
