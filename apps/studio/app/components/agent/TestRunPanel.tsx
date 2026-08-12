import { Button, Icon, Spinner, StatusPill, type StatusTone } from "@conductor/studio-ui";
import { useEffect } from "react";

import { useIpcEvent } from "../../hooks/useIpcEvent";
import { setView } from "../../lib/router";
import type { TestExpectation, TestSession, TestVerdict } from "../../lib/types";
import {
  dismissTestSession,
  refreshTestSession,
  setTestSession,
  useTestSession,
} from "../../stores/testSessionStore";
import styles from "./TestRunPanel.module.css";

const VERDICT_TONE: Record<TestVerdict, StatusTone> = {
  PASS: "success",
  FAIL: "error",
  BLOCKED: "warning",
};

/**
 * The plan, ticking over as the agent works: what it said it would check,
 * what has resolved, and the evidence behind each. This is the test as a test —
 * the conversation below it is the transcript, not the result.
 */
export function TestRunPanel() {
  const session = useTestSession();
  useEffect(refreshTestSession, []);
  useIpcEvent<TestSession | null>("test_session:updated", setTestSession);

  if (!session) return null;

  const planned = session.plan?.expectations ?? [];
  const running = !session.reportId;
  const rows = merge(planned, session.expectations, running);
  const done = session.expectations.length;
  const failed = session.expectations.filter((e) => e.status === "fail").length;

  return (
    <section className={styles.panel}>
      <header className={styles.head}>
        {running ? <Spinner size={13} /> : null}
        <span className={styles.title}>{session.title}</span>
        {session.verdict ? (
          <StatusPill tone={VERDICT_TONE[session.verdict]}>{session.verdict}</StatusPill>
        ) : (
          <span className={styles.count}>
            {done}/{Math.max(planned.length, done)} checked
            {failed ? ` · ${failed} failed` : ""}
          </span>
        )}
      </header>

      <ol className={styles.checks}>
        {rows.map((row, i) => (
          <li key={`${row.text}-${i}`} className={[styles.check, styles[row.state]].join(" ")}>
            <span className={styles.marker}>
              {row.state === "checking" ? (
                <Spinner size={12} />
              ) : (
                <Icon name={row.state === "pass" ? "check" : row.state === "fail" ? "close" : "dot"} size={13} />
              )}
            </span>
            <span className={styles.text}>
              {row.text}
              {row.evidence ? <code className={styles.evidence}>{row.evidence}</code> : null}
            </span>
          </li>
        ))}
        {rows.length === 0 ? (
          <li className={styles.empty}>No expectations declared yet — the agent is still planning.</li>
        ) : null}
      </ol>

      {session.reportId ? (
        <footer className={styles.foot}>
          <Button size="sm" variant="secondary" icon="check" onClick={() => setView("reports")}>
            Open the report
          </Button>
          <Button size="sm" variant="ghost" onClick={dismissTestSession}>
            Dismiss
          </Button>
        </footer>
      ) : null}
    </section>
  );
}

type Row = { text: string; state: "pending" | "checking" | "pass" | "fail" | "info"; evidence?: string };

/**
 * The declared plan is the skeleton; recorded results fill it in. A check the
 * agent recorded but never planned still shows — it did the work, and hiding it
 * would make the panel disagree with the report.
 */
function merge(planned: string[], recorded: TestExpectation[], running = true): Row[] {
  const left = [...recorded];
  const rows: Row[] = planned.map((text) => {
    const i = left.findIndex((r) => r.text.trim().toLowerCase() === text.trim().toLowerCase());
    if (i < 0) return { text, state: "pending" };
    const [hit] = left.splice(i, 1);
    return { text, state: hit.status, evidence: hit.evidence };
  });
  rows.push(...left.map((r): Row => ({ text: r.text, state: r.status, evidence: r.evidence })));

  // Whatever is next in the plan is what the agent is working on right now.
  const next = rows.findIndex((r) => r.state === "pending");
  if (running && next >= 0) rows[next] = { ...rows[next], state: "checking" };
  return rows;
}
