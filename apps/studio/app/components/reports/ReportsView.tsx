import { Button, EmptyState, IconButton, StatusPill, type StatusTone } from "@conductor/studio-ui";
import { useEffect, useState } from "react";

import { useIpcEvent } from "../../hooks/useIpcEvent";
import { askAgentToRerun, askAgentToWriteFlow } from "../../lib/agentHandoff";
import { ReportViewer } from "./ReportViewer";
import { deleteReport, listReports, revealReport } from "../../lib/ipc";
import { selectCase, setView } from "../../lib/router";
import { useProject } from "../../stores/projectStore";
import type { TestReport, TestVerdict } from "../../lib/types";
import styles from "./ReportsView.module.css";

const TONE: Record<TestVerdict, StatusTone> = {
  PASS: "success",
  FAIL: "error",
  BLOCKED: "warning",
};

const when = (at: number) => (at ? new Date(at).toLocaleString() : "");

/**
 * The agent's test reports: one per agentic test run, rendered to a PDF a
 * non-engineer can read. Studio only lists them — the run-log, HTML and PDF
 * live together in the report folder.
 */
export function ReportsView() {
  const [reports, setReports] = useState<TestReport[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const projectRoot = useProject()?.root ?? null;

  const refresh = () =>
    void listReports()
      .then((r) => {
        setReports(r);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  useEffect(refresh, [projectRoot]);
  useIpcEvent<string>("reports:updated", refresh);

  const open = reports.find((r) => r.id === openId);
  if (open) return <ReportViewer report={open} onClose={() => setOpenId(null)} />;

  return (
    <div className={styles.view}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Test reports</h1>
          <p className={styles.subtitle}>
            What the agent found when it tested a described behaviour on a device: the plan it
            ran, every expectation with the evidence that decided it, and screenshots of each
            decisive moment.
          </p>
        </div>
        <div className={styles.headerActions}>
          <Button size="sm" variant="secondary" icon="agent" onClick={() => setView("agent")}>
            Test a behaviour
          </Button>
          <IconButton icon="refresh" label="Refresh" onClick={refresh} />
        </div>
      </header>


      <div className={styles.list}>
        {error ? (
          <EmptyState icon="alert" title="Couldn't load reports" description={error} />
        ) : reports.length === 0 ? (
          <EmptyState
            icon="agent"
            title="No reports yet"
            description="Ask the agent to verify a behaviour — “check that adding a movie to the watchlist shows it on the Watchlist screen” — and it files a report here. A test case can be handed straight to it from the Cases screen."
          />
        ) : (
          reports.map((report) => (
            <article key={report.id} className={styles.card}>
              <button
                type="button"
                className={styles.cardOpen}
                onClick={() => setOpenId(report.id)}
                aria-label={`Open ${report.title}`}
              />
              <div className={styles.cardHead}>
                <StatusPill tone={TONE[report.verdict] ?? "neutral"}>{report.verdict}</StatusPill>
                <span className={styles.cardTitle}>{report.title}</span>
                {report.caseId ? (
                  <button
                    type="button"
                    className={styles.caseLink}
                    onClick={() => selectCase(report.caseId!)}
                  >
                    {report.caseId}
                  </button>
                ) : null}
                <span className={styles.meta}>
                  {[when(report.createdAt), report.platform, report.device]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </div>
              {report.adjustments?.length ? (
                <p className={styles.adjusted}>
                  Verdict corrected by Studio: {report.adjustments.join(" ")}
                </p>
              ) : null}
              {report.summary ? <p className={styles.summary}>{report.summary}</p> : null}
              <div className={styles.actions}>
                <span className={styles.counts}>
                  {report.passed} passed{report.failed ? ` · ${report.failed} failed` : ""}
                </span>
                <Button size="sm" variant="secondary" icon="file" onClick={() => setOpenId(report.id)}>
                  Open report
                </Button>
                <Button size="sm" variant="ghost" icon="play" onClick={() => askAgentToRerun(report)}>
                  Run again
                </Button>
                <Button size="sm" variant="ghost" icon="flow" onClick={() => askAgentToWriteFlow(report)}>
                  Write a flow
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void revealReport(report.htmlPath)}>
                  Show files
                </Button>
                <IconButton
                  icon="trash"
                  label="Delete report"
                  onClick={() => void deleteReport(report.id).then(refresh)}
                />
              </div>
            </article>
          ))
        )}
      </div>
    </div>
  );
}
