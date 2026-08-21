import { Button, IconButton, StatusPill, TextField, type StatusTone } from "@conductor/studio-ui";
import { useEffect, useState } from "react";

import { useIpcEvent } from "../../hooks/useIpcEvent";
import { cancelPlanRun, deletePlan, listPlans, planRuns, runPlan, savePlan } from "../../lib/ipc";
import type { PlanRun, PlanRunEntry, TestPlan } from "../../lib/types";
import { useSelectedDeviceId } from "../../stores/deviceStore";
import styles from "./CasesView.module.css";

const ENTRY_TONE: Record<PlanRunEntry["status"], StatusTone> = {
  pending: "neutral",
  running: "running",
  passed: "success",
  failed: "error",
  skipped: "warning",
};

interface PlansPanelProps {
  /** The filter the matrix is showing, so a plan can be saved from it. */
  currentFilter: Record<string, string[]>;
  onClose: () => void;
}

/**
 * Test plans — the named selections a team actually runs ("release smoke"),
 * plus what happened the last time each one ran.
 */
export function PlansPanel({ currentFilter, onClose }: PlansPanelProps) {
  const [plans, setPlans] = useState<TestPlan[]>([]);
  const [runs, setRuns] = useState<PlanRun[]>([]);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const deviceId = useSelectedDeviceId();

  const refresh = () => {
    listPlans().then(setPlans).catch((e) => setError(String(e)));
    planRuns().then(setRuns).catch(() => {});
  };
  useEffect(refresh, []);
  useIpcEvent<PlanRun>("plans:run-updated", (run) =>
    setRuns((prev) => [run, ...prev.filter((r) => r.id !== run.id)]),
  );

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      const id = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      setPlans(await savePlan({ id, name: trimmed, filter: currentFilter }));
      setName("");
    } catch (e) {
      setError(String(e));
    }
  };

  const start = async (plan: TestPlan) => {
    try {
      const run = await runPlan(plan.id, deviceId ?? undefined);
      setRuns((prev) => [run, ...prev]);
    } catch (e) {
      setError(String(e));
    }
  };

  const filterSummary = Object.entries(currentFilter)
    .map(([dim, values]) => `${dim}: ${values.join("/")}`)
    .join(" · ");

  return (
    <aside className={styles.detail}>
      <header className={styles.detailHeader}>
        <h2 className={styles.detailTitle}>Test plans</h2>
        <IconButton icon="close" label="Close plans" onClick={onClose} />
      </header>
      <div className={styles.detailBody}>
        {error ? <StatusPill tone="error">{error}</StatusPill> : null}

        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>Save the current selection</h3>
          <TextField
            placeholder="Plan name, e.g. Release smoke"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void create()}
          />
          <p className={styles.muted}>{filterSummary || "No filter — the plan would take every case."}</p>
          <Button size="sm" variant="secondary" icon="plus" onClick={() => void create()}>
            Create plan
          </Button>
        </section>

        {plans.map((plan) => {
          const last = runs.find((r) => r.planId === plan.id);
          return (
            <section key={plan.id} className={styles.section}>
              <div className={styles.planHeader}>
                <h3 className={styles.sectionTitle}>{plan.name}</h3>
                <div className={styles.flowActions}>
                  {last?.status === "running" ? (
                    <Button size="sm" variant="ghost" icon="stop" onClick={() => void cancelPlanRun(last.id)}>
                      Stop
                    </Button>
                  ) : (
                    <Button size="sm" variant="secondary" icon="play" onClick={() => void start(plan)}>
                      Run
                    </Button>
                  )}
                  <IconButton
                    icon="trash"
                    label={`Delete ${plan.name}`}
                    onClick={() => void deletePlan(plan.id).then(setPlans)}
                  />
                </div>
              </div>
              <p className={styles.muted}>
                {plan.refs?.length
                  ? `${plan.refs.length} cases`
                  : Object.entries(plan.filter ?? {})
                      .map(([field, values]) => `${field}: ${values.join("/")}`)
                      .join(" · ") || "every case"}
              </p>
              {last ? (
                <>
                  <div className={styles.statRow}>
                    <StatusPill tone={last.status === "passed" ? "success" : last.status === "failed" ? "error" : "running"}>
                      {last.status}
                    </StatusPill>
                    <span className={styles.muted}>
                      {last.entries.filter((e) => e.status === "passed").length}/{last.entries.length} passed
                      {" · "}
                      {new Date(last.startedAt).toLocaleString()}
                    </span>
                  </div>
                  {last.entries.map((entry, i) => (
                    <div key={`${entry.ref}-${entry.column ?? i}`} className={styles.historyRow}>
                      <StatusPill tone={ENTRY_TONE[entry.status]}>{entry.status}</StatusPill>
                      <span className={styles.historyMeta}>
                        {entry.ref}
                        {entry.column ? ` · ${entry.column}` : ""} — {entry.title}
                      </span>
                    </div>
                  ))}
                </>
              ) : null}
            </section>
          );
        })}
        {plans.length === 0 ? (
          <p className={styles.muted}>
            No plans yet. Filter the matrix to the cases you care about, then save it as a plan.
          </p>
        ) : null}
      </div>
    </aside>
  );
}
