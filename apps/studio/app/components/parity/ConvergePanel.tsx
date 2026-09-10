import { Button, Icon, Panel, Spinner, StatusPill, TextField, type StatusTone } from "@conductor/studio-ui";
import { useState } from "react";

import type { ConvergePhase, ConvergeProgress, ConvergeTargetState } from "../../lib/types";
import { acceptConverged, rejectConverged } from "../../stores/parityStore";
import styles from "./ConvergePanel.module.css";

/**
 * The Helix loop, made watchable.
 *
 * Each target shows its rounds and the blocking count they left behind, because
 * that trend is the thing worth watching: falling means the agent is closing on
 * the reference, flat means it is stuck and the loop will stop it, rising means
 * a fix broke something else.
 *
 * A target that reaches parity lands on **awaiting review**, never "done" — the
 * diff opens the gate, a person still walks through it.
 */

const PHASE: Record<ConvergePhase, { label: string; tone: StatusTone }> = {
  idle: { label: "queued", tone: "neutral" },
  preparing: { label: "rebuilding", tone: "running" },
  capturing: { label: "capturing", tone: "running" },
  diffing: { label: "diffing", tone: "running" },
  "agent-working": { label: "agent working", tone: "running" },
  "awaiting-review": { label: "awaiting review", tone: "success" },
  stalled: { label: "stalled", tone: "warning" },
  failed: { label: "failed", tone: "error" },
};

function Trend({ target }: { target: ConvergeTargetState }) {
  if (target.attempts.length === 0) return <span className={styles.muted}>no rounds yet</span>;
  const worst = Math.max(1, ...target.attempts.map((a) => a.blocking));
  return (
    <ol className={styles.trend} aria-label="Blocking findings per round">
      {target.attempts.map((a) => {
        const height = a.passed ? 4 : Math.max(4, Math.round((a.blocking / worst) * 28));
        return (
          <li key={a.index} className={styles.bar} title={`Round ${a.index}: ${a.blocking} blocking, ${a.advisory} advisory`}>
            <span
              className={[styles.barFill, a.passed && styles.barPass].filter(Boolean).join(" ")}
              style={{ height: `${height}px` }}
            />
            <span className={styles.barLabel}>{a.passed ? "✓" : a.blocking}</span>
          </li>
        );
      })}
    </ol>
  );
}

function TargetRow({ target }: { target: ConvergeTargetState }) {
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const latest = target.attempts[target.attempts.length - 1];
  const phase = PHASE[target.phase];
  const working =
    target.phase === "preparing" ||
    target.phase === "capturing" ||
    target.phase === "diffing" ||
    target.phase === "agent-working";
  const failedStep = latest?.steps?.find((st) => !st.ok);
  const spent = target.attempts.reduce(
    (acc, a) => ({
      usd: acc.usd + (a.agent?.costUsd ?? 0),
      ms: acc.ms + (a.agent?.durationMs ?? 0) + (a.steps ?? []).reduce((m, st) => m + st.durationMs, 0),
    }),
    { usd: 0, ms: 0 },
  );

  return (
    <li className={styles.target}>
      <div className={styles.head}>
        <span className={styles.label}>{target.label}</span>
        <span className={styles.platform}>{target.platform}</span>
        {working ? <Spinner size={12} /> : null}
        <StatusPill tone={phase.tone}>{phase.label}</StatusPill>
        <span className={styles.rounds}>
          {target.attempts.length} round{target.attempts.length === 1 ? "" : "s"}
          {spent.ms > 0 ? ` · ${Math.round(spent.ms / 60_000)} min` : ""}
          {spent.usd > 0 ? ` · $${spent.usd.toFixed(2)}` : ""}
        </span>
        {target.phase === "awaiting-review" && !target.accepted ? (
          <>
            <Button size="sm" icon="check" onClick={() => void acceptConverged(target.label)}>
              Accept
            </Button>
            <Button
              size="sm"
              variant="secondary"
              icon="close"
              onClick={() => setRejecting((v) => !v)}
            >
              Not right
            </Button>
          </>
        ) : null}
        {target.accepted ? <StatusPill tone="success">accepted</StatusPill> : null}
      </div>

      {rejecting ? (
        <form
          className={styles.reject}
          onSubmit={(e) => {
            e.preventDefault();
            if (!note.trim()) return;
            void rejectConverged(target.label, note);
            setNote("");
            setRejecting(false);
          }}
        >
          <TextField
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What's wrong? The agent works from this."
            aria-label={`Why ${target.label} is not right`}
          />
          <Button size="sm" type="submit" disabled={!note.trim()}>
            Send back
          </Button>
        </form>
      ) : null}

      <Trend target={target} />

      {failedStep ? (
        <p className={styles.error}>
          <Icon name="alert" size={12} /> {failedStep.step} failed — the agent sees the output
          next round
        </p>
      ) : null}
      {latest?.tests && !latest.tests.passed ? (
        <p className={styles.error}>
          <Icon name="alert" size={12} /> screen matches, but the target's tests fail
        </p>
      ) : null}
      {target.outcome ? <p className={styles.outcome}>{target.outcome}</p> : null}
      {target.error ? (
        <p className={styles.error}>
          <Icon name="alert" size={12} /> {target.error}
        </p>
      ) : null}

      {latest && !latest.passed && latest.findings.length > 0 ? (
        <ul className={styles.findings}>
          {latest.findings.slice(0, 6).map((f, i) => (
            <li
              key={`${f.kind}-${f.identifier ?? f.label ?? i}`}
              className={f.severity === "blocking" ? styles.blocking : undefined}
            >
              <span className={styles.kind}>{f.kind}</span>
              <span>{f.detail}</span>
            </li>
          ))}
          {latest.findings.length > 6 ? (
            <li className={styles.muted}>+{latest.findings.length - 6} more</li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
}

export function ConvergePanel({ converge }: { converge: ConvergeProgress | null }) {
  if (!converge) return null;

  const reviewing = converge.targets.filter((t) => t.phase === "awaiting-review").length;
  const accepted = converge.targets.filter((t) => t.accepted).length;

  return (
    <Panel
      title={`Converging on "${converge.checkpoint}"`}
      actions={
        <span className={styles.summary}>
          {reviewing}/{converge.targets.length} at parity · {accepted} accepted
          {converge.running ? " · running" : ""}
        </span>
      }
    >
      <p className={styles.note}>
        Each target is being worked by its own agent against the frozen{" "}
        <strong>{converge.referenceLabel}</strong> screen. The agent does not decide when it is
        finished — every round captures the screen and diffs it, and only that verdict opens the
        gate. A target that reaches parity waits for you to look at it — and if it is not right,
        say why: the note goes back to the same agent, which still has the codebase in context.
      </p>
      <ul className={styles.targets}>
        {converge.targets.map((t) => (
          <TargetRow key={t.label} target={t} />
        ))}
      </ul>
    </Panel>
  );
}
