import { Button, EmptyState, Spinner, StatusPill, type StatusTone } from "@conductor/studio-ui";
import { useEffect, useState } from "react";

import { useIpcEvent } from "../../hooks/useIpcEvent";
import { askAgentToFix } from "../../lib/agentHandoff";
import { clearRunHistory, runArtifacts, runHistory } from "../../lib/ipc";
import { selectFlow } from "../../lib/router";
import type { FlowRunStatus, RunArtifacts, RunRecord } from "../../lib/types";
import styles from "./RunHistory.module.css";

const TONE: Record<FlowRunStatus, StatusTone> = {
  running: "running",
  passed: "success",
  failed: "error",
  cancelled: "warning",
  error: "error",
};

const duration = (record: RunRecord) =>
  `${Math.max(1, Math.round((record.finishedAt - record.startedAt) / 1000))}s`;

const when = (at: number) => new Date(at).toLocaleTimeString();

/**
 * Past runs, and — for maestro runs — the debug output it wrote: every executed
 * command with its screenshot and the screen hierarchy at that moment. That's
 * what answers "why did this fail", which a console scroll never did.
 */
export function RunHistory() {
  const [records, setRecords] = useState<RunRecord[]>([]);
  const [selected, setSelected] = useState<RunRecord | null>(null);
  const [artifacts, setArtifacts] = useState<RunArtifacts | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = () => void runHistory().then(setRecords).catch(() => setRecords([]));
  useEffect(refresh, []);
  useIpcEvent<string>("runs:updated", refresh);

  const open = (record: RunRecord) => {
    setSelected(record);
    setArtifacts(null);
    if (!record.artifactDir) return;
    setLoading(true);
    runArtifacts(record.runId)
      .then(setArtifacts)
      .catch(() => setArtifacts(null))
      .finally(() => setLoading(false));
  };

  // A repeat group's pass rate is the point of running it more than once.
  const rate = (group: string) => {
    const runs = records.filter((r) => r.repeatGroup === group);
    return `${runs.filter((r) => r.status === "passed").length}/${runs.length}`;
  };

  if (records.length === 0) {
    return (
      <EmptyState
        icon="flow"
        title="No runs yet"
        description="Runs are kept here with maestro's screenshots and screen hierarchy, so a failure can be picked apart after the fact."
      />
    );
  }

  if (selected) {
    return (
      <div className={styles.detail}>
        <header className={styles.detailHead}>
          <Button size="sm" variant="ghost" icon="chevronLeft" onClick={() => setSelected(null)}>
            Back
          </Button>
          <StatusPill tone={TONE[selected.status]}>{selected.status}</StatusPill>
          <button type="button" className={styles.flowLink} onClick={() => selectFlow(selected.flowPath)}>
            {selected.flowPath}
          </button>
          <span className={styles.meta}>
            {when(selected.startedAt)} · {duration(selected)} · {selected.engine}
          </span>
          {selected.status === "failed" || selected.status === "error" ? (
            <Button size="sm" variant="secondary" icon="agent" onClick={() => void askAgentToFix(selected)}>
              Ask the agent to fix it
            </Button>
          ) : null}
        </header>
        {loading ? (
          <div className={styles.center}>
            <Spinner label="Reading artifacts…" />
          </div>
        ) : artifacts ? (
          <ul className={styles.steps}>
            {artifacts.steps.map((step) => (
              <li key={step.index} className={styles.step}>
                <div className={styles.stepHead}>
                  <StatusPill tone={step.status === "FAILED" ? "error" : step.status === "COMPLETED" ? "success" : "neutral"}>
                    {step.status.toLowerCase()}
                  </StatusPill>
                  <span className={styles.stepLabel}>{step.label}</span>
                  {step.durationMs ? <span className={styles.meta}>{step.durationMs}ms</span> : null}
                </div>
                {step.screenshot ? (
                  <img
                    className={styles.shot}
                    src={`file://${step.screenshot}`}
                    alt={`Screen at ${step.label}`}
                  />
                ) : null}
                {step.hierarchy ? (
                  <span className={styles.meta}>hierarchy: {step.hierarchy.split("/").pop()}</span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <div className={styles.output}>
            {selected.output.map((line, index) => (
              <div key={index}>{line}</div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <span className={styles.count}>{records.length} runs</span>
        <Button size="sm" variant="ghost" icon="refresh" onClick={refresh}>
          Refresh
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon="close"
          onClick={() => void clearRunHistory().then(refresh)}
        >
          Clear
        </Button>
      </div>
      <ul className={styles.list}>
        {records.map((record) => (
          <li key={record.runId}>
            <button type="button" className={styles.item} onClick={() => open(record)}>
              <StatusPill tone={TONE[record.status]}>{record.status}</StatusPill>
              <span className={styles.flow}>{record.flowPath}</span>
              {record.repeatGroup ? (
                <StatusPill tone="info">{rate(record.repeatGroup)} passed</StatusPill>
              ) : null}
              <span className={styles.meta}>
                {when(record.startedAt)} · {duration(record)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
