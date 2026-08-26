import { Button, IconButton, StatusPill, TextField, type StatusTone } from "@conductor/studio-ui";
import { useEffect, useMemo, useState } from "react";

import { recordCaseResult, runFlow } from "../../lib/ipc";
import type { Case, CaseStep, CaseStepResult, ResultStatus } from "../../lib/types";
import { useSelectedDeviceId } from "../../stores/deviceStore";
import { beginRun } from "../../stores/runStore";
import styles from "./CasesView.module.css";

const STEP_TONE: Record<ResultStatus, StatusTone> = {
  passed: "success",
  failed: "error",
  blocked: "warning",
  skipped: "neutral",
  invalid: "warning",
};

interface RunWizardProps {
  /** The cases to walk, in order — usually the current filter. */
  cases: Case[];
  onClose: () => void;
  onRecorded: () => void;
  /** Hand-off to the flow: bring the device rail up beside the wizard. */
  onRunStarted: () => void;
}

/**
 * The manual execution session: walk a selection case by case, mark each step,
 * file a verdict, move on. This is how the cases with no flow — most of them,
 * in most projects — ever get a result.
 */
export function RunWizard({ cases, onClose, onRecorded, onRunStarted }: RunWizardProps) {
  const [index, setIndex] = useState(0);
  const [steps, setSteps] = useState<Record<number, CaseStepResult>>({});
  const [note, setNote] = useState("");
  const [appVersion, setAppVersion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Record<string, ResultStatus>>({});
  const deviceId = useSelectedDeviceId();

  const current = cases[index];
  useEffect(() => {
    setSteps({});
    setNote("");
  }, [current?.ref]);

  // A case with structured steps walks step by step; a legacy free-text case
  // still walks, one line at a time.
  const caseSteps: CaseStep[] = useMemo(
    () =>
      current?.steps?.length
        ? current.steps
        : (current?.description ?? "")
            .split("\n")
            .filter((line) => line.trim())
            .map((action) => ({ action: action.trim() })),
    [current],
  );

  if (!current) {
    return (
      <aside className={styles.detail}>
        <header className={styles.detailHeader}>
          <h2 className={styles.detailTitle}>Nothing to run</h2>
          <IconButton icon="close" label="Close wizard" onClick={onClose} />
        </header>
        <div className={styles.detailBody}>
          <p className={styles.muted}>Filter the matrix to the cases you want to walk through.</p>
        </div>
      </aside>
    );
  }

  const markStep = (i: number, status: CaseStepResult["status"]) =>
    setSteps((s) => ({ ...s, [i]: { index: i, status } }));

  const finish = async (status: ResultStatus) => {
    setBusy(true);
    try {
      await recordCaseResult({
        case_id: current.id,
        ref: current.ref,
        status,
        source: "manual",
        comment: note.trim() || undefined,
        app_version: appVersion.trim() || undefined,
        steps: Object.values(steps),
      });
      setDone((d) => ({ ...d, [current.ref]: status }));
      setNote("");
      setSteps({});
      setIndex((i) => i + 1);
      onRecorded();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  // Every step passed and nothing failed — the "fast pass" the tester expects.
  const allPassed =
    caseSteps.length > 0 && caseSteps.every((_, i) => steps[i]?.status === "passed");
  const anyFailed = caseSteps.some((_, i) => steps[i]?.status === "failed");

  // Run the flow for the platform we're walking, not just the first one.
  const declaring = current.flows?.[0];
  const column = declaring?.tags[0];
  const flow = declaring?.path;

  return (
    <aside className={styles.detail}>
      <header className={styles.detailHeader}>
        <div>
          <div className={styles.detailIds}>
            {index + 1} of {cases.length} · {current.ref}
          </div>
          <h2 className={styles.detailTitle}>{current.title}</h2>
        </div>
        <IconButton icon="close" label="Close wizard" onClick={onClose} />
      </header>

      <div className={styles.detailBody}>
        {error ? <StatusPill tone="error">{error}</StatusPill> : null}

        {current.preconditions ? (
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Before you start</h3>
            <p className={styles.prose}>{current.preconditions}</p>
          </section>
        ) : null}

        {current.description ? <p className={styles.prose}>{current.description}</p> : null}

        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>Steps</h3>
          {caseSteps.map((step, i) => (
            <div key={i} className={styles.wizardStep}>
              <div className={styles.wizardStepText}>
                <span className={styles.wizardStepAction}>
                  {i + 1}. {step.action}
                </span>
                {step.data ? <span className={styles.muted}>data: {step.data}</span> : null}
                {step.expected_result ? (
                  <span className={styles.wizardExpected}>→ {step.expected_result}</span>
                ) : null}
                {step.pom ? <span className={styles.muted}>{step.pom}</span> : null}
              </div>
              <div className={styles.flowActions}>
                {steps[i] ? <StatusPill tone={STEP_TONE[steps[i].status]}>{steps[i].status}</StatusPill> : null}
                <IconButton icon="check" size={13} label="Step passed" onClick={() => markStep(i, "passed")} />
                <IconButton icon="close" size={13} label="Step failed" onClick={() => markStep(i, "failed")} />
                <IconButton icon="dot" size={13} label="Step skipped" onClick={() => markStep(i, "skipped")} />
              </div>
            </div>
          ))}
          {caseSteps.length === 0 ? (
            <p className={styles.muted}>This case has no steps written down yet.</p>
          ) : null}
        </section>

        {current.postconditions ? (
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Afterwards</h3>
            <p className={styles.prose}>{current.postconditions}</p>
          </section>
        ) : null}

        <section className={styles.section}>
          <TextField placeholder="Notes (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
          <TextField
            placeholder="App version under test, e.g. 2026.17.0"
            value={appVersion}
            onChange={(e) => setAppVersion(e.target.value)}
          />
          <div className={styles.verdictRow}>
            <Button size="sm" disabled={busy || anyFailed} onClick={() => void finish("passed")}>
              {allPassed ? "Pass · next" : "Pass"}
            </Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void finish("failed")}>
              Fail
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void finish("blocked")}>
              Blocked
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void finish("skipped")}>
              Skip
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void finish("invalid")}>
              Invalid
            </Button>
          </div>
          {flow ? (
            <Button
              size="sm"
              variant="ghost"
              icon="play"
              onClick={async () => {
                const { runId, deviceId: ranOn } = await runFlow(
                  flow,
                  deviceId ?? undefined,
                  undefined,
                  column,
                );
                beginRun(runId, flow, ranOn);
                onRunStarted();
              }}
            >
              Let the flow do it instead
            </Button>
          ) : null}
        </section>

        <div className={styles.verdictRow}>
          <Button size="sm" variant="ghost" disabled={index === 0} onClick={() => setIndex((i) => i - 1)}>
            Previous
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={index >= cases.length - 1}
            onClick={() => setIndex((i) => i + 1)}
          >
            Next
          </Button>
          <span className={styles.muted}>{Object.keys(done).length} recorded this session</span>
        </div>
      </div>
    </aside>
  );
}
