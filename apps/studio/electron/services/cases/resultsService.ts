import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CaseResult, CaseStats, CaseVerdict, RunRecord, TestCase } from "../../../app/lib/types";
import { broadcastToRenderers } from "../../broadcast";
import { getProjectInfo } from "../file/fileService";
import { studioDir } from "../util/studioPaths";

/**
 * The execution log: every time a case was exercised, by whom, and how it went.
 * Cases say what should be true; this says what actually happened — automation
 * runs, manual verdicts, agentic reports and CI alike.
 *
 * Append-only JSONL inside the project so a team can commit it (or ignore it)
 * and two people recording results on the same day merge without a conflict.
 */

const LOG = "results.jsonl";
/** Legacy location: the log used to be written into the repo under test. */
const IN_REPO = path.join(".conductor-studio", "case-results.jsonl");
/** How many recent executions decide "flaky". */
const FLAKE_WINDOW = 10;

let counter = 0;
/** runId -> plan run that started it, so plan executions stay attributable. */
const planClaims = new Map<string, string>();

export function claimRunForPlan(runId: string, planRunId: string): void {
  planClaims.set(runId, planRunId);
}

function logPath(): string | null {
  const project = getProjectInfo();
  if (!project) return null;
  const file = path.join(studioDir("cases", project.root), LOG);
  // Pick up a log an earlier version wrote into the repo, once.
  const legacy = path.join(project.root, IN_REPO);
  if (!existsSync(file) && existsSync(legacy)) {
    mkdirSync(path.dirname(file), { recursive: true });
    copyFileSync(legacy, file);
  }
  return file;
}

export async function listResults(): Promise<CaseResult[]> {
  const file = logPath();
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
  return results.sort((a, b) => b.at - a.at);
}

export async function recordResult(
  input: Omit<CaseResult, "id" | "at"> & { at?: number },
): Promise<CaseResult> {
  const file = logPath();
  if (!file) throw new Error("No project is open.");
  counter += 1;
  const result: CaseResult = { ...input, id: `res-${Date.now()}-${counter}`, at: input.at ?? Date.now() };
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
  const file = logPath();
  if (!file || !existsSync(file)) return;
  const results = await listResults();
  if (!results.some((r) => r.reportId === reportId)) return;
  const kept = results
    .slice()
    .sort((a, b) => a.at - b.at)
    .map(({ ...r }) => {
      if (r.reportId === reportId) {
        delete r.reportId;
        r.note = [r.note, "(report deleted)"].filter(Boolean).join(" ");
      }
      return r;
    });
  await writeFile(file, kept.map((r) => `${JSON.stringify(r)}\n`).join(""), "utf8");
  broadcastToRenderers("cases:result-recorded", { detached: reportId });
}

/** Newest execution per case, and per `<caseId>::<column>` when scoped. */
export function latestByCase(results: CaseResult[]): Record<string, CaseResult> {
  const latest: Record<string, CaseResult> = {};
  for (const r of results) {
    for (const key of [r.caseId, r.column ? `${r.caseId}::${r.column}` : null]) {
      if (!key) continue;
      if (!latest[key] || latest[key].at < r.at) latest[key] = r;
    }
  }
  return latest;
}

export function statsFor(caseId: string, results: CaseResult[]): CaseStats {
  const mine = results.filter((r) => r.caseId === caseId);
  const decisive = mine.filter((r) => r.verdict === "passed" || r.verdict === "failed");
  const passed = decisive.filter((r) => r.verdict === "passed").length;
  const recent = decisive.slice(0, FLAKE_WINDOW);
  return {
    caseId,
    total: mine.length,
    passed,
    failed: decisive.length - passed,
    passRate: decisive.length ? passed / decisive.length : 0,
    flaky: recent.some((r) => r.verdict === "passed") && recent.some((r) => r.verdict === "failed"),
    lastAt: mine[0]?.at,
  };
}

/** Attach each case's execution history, newest first. */
export function decorate(cases: TestCase[], results: CaseResult[]): TestCase[] {
  const byCase = new Map<string, CaseResult[]>();
  for (const r of results) byCase.set(r.caseId, [...(byCase.get(r.caseId) ?? []), r]);
  for (const c of cases) {
    const mine = byCase.get(c.id) ?? [];
    c.results = mine;
    c.lastResult = mine[0];
  }
  return cases;
}

const RUN_VERDICT: Record<string, CaseVerdict> = {
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
export async function recordRunResult(record: RunRecord, cases: TestCase[]): Promise<void> {
  const verdict = RUN_VERDICT[record.status];
  if (!verdict) return;
  for (const c of cases) {
    const columns = Object.entries(c.flows ?? {})
      .filter(([, flow]) => flow === record.flowPath)
      .map(([column]) => column);
    if (c.flow === record.flowPath) columns.push("");
    for (const column of columns) {
      await recordResult({
        caseId: c.id,
        column: column || undefined,
        verdict,
        source: "run",
        runId: record.runId,
        flow: record.flowPath,
        deviceId: record.deviceId,
        planRunId: planClaims.get(record.runId),
        at: record.finishedAt,
      });
    }
  }
  planClaims.delete(record.runId);
}
