import { Button, IconButton, Spinner, StatusPill, type StatusTone } from "@conductor/studio-ui";
import { useEffect, useState } from "react";

import { askAgentToRerun, askAgentToWriteFlow } from "../../lib/agentHandoff";
import { openReport, reportHtml, reportMarkdown, revealReport } from "../../lib/ipc";
import { selectCase } from "../../lib/router";
import type { TestReport, TestVerdict } from "../../lib/types";
import styles from "./ReportsView.module.css";

const TONE: Record<TestVerdict, StatusTone> = {
  PASS: "success",
  FAIL: "error",
  BLOCKED: "warning",
};

/**
 * The report, in Studio. It's already a self-contained document, so it renders
 * as-is in a sandboxed frame — reading a result shouldn't mean leaving the app
 * for Preview.
 */
export function ReportViewer({ report, onClose }: { report: TestReport; onClose: () => void }) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setHtml(null);
    setError(null);
    setCopied(false);
    reportHtml(report.id)
      .then(setHtml)
      .catch((e) => setError(String(e)));
  }, [report.id]);

  const copyMarkdown = async () => {
    try {
      await navigator.clipboard.writeText(await reportMarkdown(report.id));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className={styles.viewer}>
      <header className={styles.viewerHead}>
        <IconButton icon="chevronLeft" label="Back to reports" onClick={onClose} />
        <StatusPill tone={TONE[report.verdict] ?? "neutral"}>{report.verdict}</StatusPill>
        <span className={styles.cardTitle}>{report.title}</span>
        {report.caseId ? (
          <button type="button" className={styles.caseLink} onClick={() => selectCase(report.caseId!)}>
            {report.caseId}
          </button>
        ) : null}
        <span className={styles.spacer} />
        <Button size="sm" variant="secondary" icon="copy" onClick={() => void copyMarkdown()}>
          {copied ? "Copied" : "Copy as Markdown"}
        </Button>
        <Button size="sm" variant="ghost" icon="play" onClick={() => askAgentToRerun(report)}>
          Run again
        </Button>
        <Button size="sm" variant="ghost" icon="flow" onClick={() => askAgentToWriteFlow(report)}>
          Write a flow
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void openReport(report.pdfPath ?? report.htmlPath)}>
          Open {report.pdfPath ? "PDF" : "HTML"}
        </Button>
        <IconButton icon="folder" label="Show files" onClick={() => void revealReport(report.htmlPath)} />
      </header>

      <div className={styles.frameWrap}>
        {error ? (
          <div className={styles.notice}>{error}</div>
        ) : html === null ? (
          <div className={styles.notice}>
            <Spinner label="Opening report…" />
          </div>
        ) : (
          // The report carries no scripts, and sandboxing keeps it that way.
          <iframe className={styles.frame} title={report.title} sandbox="" srcDoc={html} />
        )}
      </div>
    </div>
  );
}
