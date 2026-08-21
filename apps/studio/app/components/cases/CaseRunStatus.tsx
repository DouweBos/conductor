import { Button, StatusPill, StepList, type StatusTone } from "@conductor/studio-ui";
import { useEffect, useRef, useState } from "react";

import { cancelRun } from "../../lib/ipc";
import type { FlowRunStatus } from "../../lib/types";
import {
  useRunFlowPath,
  useRunId,
  useRunLines,
  useRunStatus,
  useRunSteps,
} from "../../stores/runStore";
import styles from "./CasesView.module.css";

const TONE: Record<FlowRunStatus, StatusTone> = {
  running: "running",
  passed: "success",
  failed: "error",
  cancelled: "warning",
  error: "error",
};

const TAIL = 40;

/**
 * What the run started from this screen is doing, beside the device showing it.
 * The workbench's console owns the full log; here it's the shape of a glance —
 * which flow, which step, and the last few lines — so running a case never
 * means leaving the matrix.
 */
export function CaseRunStatus() {
  const runId = useRunId();
  const status = useRunStatus();
  const steps = useRunSteps();
  const lines = useRunLines();
  const flowPath = useRunFlowPath();

  const listRef = useRef<HTMLDivElement | null>(null);
  const [showOutput, setShowOutput] = useState(false);

  const done = steps.filter((s) => s.status === "passed" || s.status === "failed").length;
  const current = steps.findIndex((s) => s.status === "running");
  const failed = steps.filter((s) => s.status === "failed").length;

  // Keep the step being executed in view without stealing the scroll when the
  // user has gone looking further up.
  useEffect(() => {
    const el = listRef.current;
    if (!el || current < 0) return;
    const child = el.querySelectorAll("li")[current] as HTMLElement | undefined;
    child?.scrollIntoView({ block: "nearest" });
  }, [current]);

  if (!runId || !flowPath) return null;

  return (
    <section className={styles.runStatus}>
      <div className={styles.statRow}>
        <StatusPill tone={status ? TONE[status] : "neutral"} pulse={status === "running"}>
          {status ?? "starting"}
        </StatusPill>
        <span className={styles.runProgress}>
          {steps.length ? `${Math.min(done + (current >= 0 ? 1 : 0), steps.length)}/${steps.length}` : ""}
          {failed ? ` · ${failed} failed` : ""}
        </span>
        {status === "running" ? (
          <Button size="sm" variant="ghost" icon="stop" onClick={() => void cancelRun(runId)}>
            Stop
          </Button>
        ) : null}
      </div>
      <div className={styles.runFlowPath}>{flowPath}</div>

      {steps.length ? (
        <div className={styles.runSteps} ref={listRef}>
          <StepList steps={steps.map((s) => ({ id: s.id, label: s.label, status: s.status }))} />
        </div>
      ) : (
        <p className={styles.muted}>Waiting for the first step…</p>
      )}

      {lines.length ? (
        <>
          <button
            type="button"
            className={styles.outputToggle}
            onClick={() => setShowOutput((v) => !v)}
          >
            {showOutput ? "Hide" : "Show"} raw output
          </button>
          {showOutput ? (
            <pre className={styles.runTail}>{lines.slice(-TAIL).map((l) => l.text).join("\n")}</pre>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
