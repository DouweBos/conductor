import { BrowserWindow } from "electron";
import { existsSync, statSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { TestReport, TestRunLog, TestVerdict } from "../../../app/lib/types";
import { broadcastToRenderers } from "../../broadcast";
import { appState } from "../../state";
import { studioDir } from "../util/studioPaths";
import { renderReportHtml } from "./reportHtml";
import { renderReportMarkdown } from "./reportMarkdown";
import { finishSession, mergeSession } from "./testSession";

/**
 * Visual test reports the agent produces after driving a feature: a run-log it
 * records as it works, rendered to a self-contained HTML + PDF a non-engineer
 * can read. Kept outside the repo like scene graphs — a report is a run
 * artefact, not something to commit.
 */
function projectDir(): string {
  return studioDir("reports");
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "test"
  );
}

/** `2026-08-10-2304-17` — sorts chronologically and is safe as a folder name. */
function stamp(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return [
    at.getFullYear(),
    pad(at.getMonth() + 1),
    pad(at.getDate()),
    `${pad(at.getHours())}${pad(at.getMinutes())}`,
    pad(at.getSeconds()),
  ].join("-");
}

/** When each reserved folder was created, so the report doesn't need the model to remember. */
const startedAt = new Map<string, number>();

/** `2026-08-10 23:04` — how a time reads in the report. */
function clock(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Reserve a folder for a test run. The agent needs it before it starts, so
 * screenshots land next to the report instead of in a temp dir.
 */
export async function createReportDir(title: string): Promise<{ id: string; dir: string }> {
  const id = `${slug(title)}-${stamp(new Date())}`;
  const dir = path.join(projectDir(), id);
  await mkdir(dir, { recursive: true });
  startedAt.set(dir, Date.now());
  return { id, dir };
}

/**
 * Fill in what the process knows better than the model does — when the run
 * started and ended, and which device it drove. A model asked for a timestamp
 * invents one, and an invented timestamp in an evidence document is worse than
 * no timestamp.
 */
function stampFacts(log: TestRunLog, dir: string): TestRunLog {
  const began = startedAt.get(dir) ?? birth(dir);
  startedAt.delete(dir);
  const device = appState.agentDevice;
  return {
    ...log,
    startedAt: began ? clock(began) : log.startedAt,
    finishedAt: clock(Date.now()),
    platform: device?.platform ?? log.platform,
    device: device ? `${device.name} — ${device.id}` : log.device,
  };
}

function birth(dir: string): number | null {
  try {
    const { birthtimeMs, ctimeMs } = statSync(dir);
    return birthtimeMs || ctimeMs || null;
  } catch {
    return null;
  }
}

/**
 * A verdict has to survive its own evidence. An agent that asserts nothing, or
 * that reports PASS over a failed check, would otherwise produce a document
 * that reads as proof while proving nothing.
 */
function reconcile(log: TestRunLog): { verdict: TestVerdict; adjustments: string[] } {
  const verdict = (log.verdict?.toUpperCase() as TestVerdict) || "BLOCKED";
  const expectations = log.expectations ?? [];
  const failed = expectations.filter((e) => e.status === "fail");
  const failedSteps = (log.steps ?? []).filter((s) => s.status === "fail");
  const adjustments: string[] = [];

  if (verdict === "PASS" && failed.length) {
    adjustments.push(
      `Reported PASS, but ${failed.length} expectation(s) failed: ${failed
        .map((e) => e.text)
        .join("; ")}. Recorded as FAIL.`,
    );
    return { verdict: "FAIL", adjustments };
  }
  if (verdict === "PASS" && !expectations.length) {
    adjustments.push(
      "Reported PASS with no expectations recorded — nothing was checked, so this is not a pass. Recorded as BLOCKED.",
    );
    return { verdict: "BLOCKED", adjustments };
  }
  if (verdict === "PASS" && failedSteps.length) {
    adjustments.push(
      `Reported PASS with ${failedSteps.length} failed step(s) in the timeline. Left as PASS — check the timeline.`,
    );
  }
  return { verdict, adjustments };
}

/** Write the run-log and render report.html + report.pdf beside it. */
export async function writeReport(
  log: TestRunLog,
  dir?: string,
  caseId?: string,
): Promise<TestReport> {
  if (!log?.title) throw new Error("A run-log needs a title.");
  const target = dir ?? (await createReportDir(log.title)).dir;
  await mkdir(target, { recursive: true });

  // Everything Studio recorded live — resolved expectations and the screenshots
  // it took at each — is folded in before the verdict is judged.
  const observed = mergeSession(log);
  const { verdict, adjustments } = reconcile(observed);
  const final: TestRunLog = { ...stampFacts(observed, target), verdict, adjustments };

  await writeFile(path.join(target, "run-log.json"), JSON.stringify(final, null, 2), "utf8");
  const htmlPath = path.join(target, "report.html");
  await writeFile(htmlPath, renderReportHtml(final, target, caseId), "utf8");
  const pdfPath = await renderPdf(htmlPath).catch(() => null);

  const report = summarize(final, target, path.basename(target), Date.now(), pdfPath ?? undefined);
  if (caseId) report.caseId = caseId;
  if (adjustments.length) report.adjustments = adjustments;
  await writeFile(path.join(target, "report.json"), JSON.stringify(report, null, 2), "utf8");
  finishSession(report.id, report.verdict);
  broadcastToRenderers("reports:updated", report.id);
  return report;
}

/**
 * PDF via an offscreen window — Electron carries Chromium already, so this
 * needs no external browser the way a standalone script would.
 */
async function renderPdf(htmlPath: string): Promise<string> {
  const win = new BrowserWindow({ show: false, webPreferences: { javascript: false } });
  try {
    await win.loadURL(pathToFileURL(htmlPath).toString());
    const pdf = await win.webContents.printToPDF({ printBackground: true });
    const pdfPath = path.join(path.dirname(htmlPath), "report.pdf");
    await writeFile(pdfPath, pdf);
    return pdfPath;
  } finally {
    win.destroy();
  }
}

function summarize(
  log: TestRunLog,
  dir: string,
  id: string,
  createdAt: number,
  pdfPath?: string,
): TestReport {
  const expectations = log.expectations ?? [];
  return {
    id,
    dir,
    title: log.title,
    verdict: (log.verdict?.toUpperCase() as TestVerdict) || "BLOCKED",
    createdAt,
    summary: log.summary,
    platform: log.platform,
    device: log.device,
    htmlPath: path.join(dir, "report.html"),
    pdfPath,
    passed: expectations.filter((e) => e.status === "pass").length,
    failed: expectations.filter((e) => e.status === "fail").length,
  };
}

/** The rendered HTML of a past report, for the in-app viewer. */
export async function readReportHtml(id: string): Promise<string> {
  return readFile(path.join(projectDir(), path.basename(id), "report.html"), "utf8");
}

/** The report as markdown — what gets pasted into a PR, an issue or a chat. */
export async function readReportMarkdown(id: string): Promise<string> {
  const dir = path.join(projectDir(), path.basename(id));
  const log = JSON.parse(await readFile(path.join(dir, "run-log.json"), "utf8")) as TestRunLog;
  const meta = await readReport(dir);
  return renderReportMarkdown(log, meta?.caseId);
}

/** Reports for the open project, newest first. */
export async function listReports(): Promise<TestReport[]> {
  const dir = projectDir();
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const reports: TestReport[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const report = await readReport(path.join(dir, entry.name));
    if (report) reports.push(report);
  }
  return reports.sort((a, b) => b.createdAt - a.createdAt);
}

async function readReport(dir: string): Promise<TestReport | null> {
  try {
    // report.json is the rendered summary; fall back to the run-log so a report
    // written by hand still lists.
    const meta = JSON.parse(await readFile(path.join(dir, "report.json"), "utf8")) as TestReport;
    return { ...meta, dir, id: path.basename(dir) };
  } catch {
    try {
      const log = JSON.parse(await readFile(path.join(dir, "run-log.json"), "utf8")) as TestRunLog;
      const pdf = path.join(dir, "report.pdf");
      return summarize(log, dir, path.basename(dir), 0, existsSync(pdf) ? pdf : undefined);
    } catch {
      return null;
    }
  }
}

export async function deleteReport(id: string): Promise<void> {
  const dir = path.join(projectDir(), path.basename(id));
  await rm(dir, { recursive: true, force: true });
  broadcastToRenderers("reports:updated", id);
}
