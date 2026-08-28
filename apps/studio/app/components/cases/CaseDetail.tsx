import { Button, IconButton, Select, StatusPill, Tag, TextField } from "@conductor/studio-ui";
import { useEffect, useState } from "react";

import {
  caseStepCoverage,
  linkCaseFlow,
  listStepPoms,
  qaseProjects,
  scaffoldFlowFromCase,
  setCaseStepPoms,
  loadFlowCatalog,
} from "../../lib/ipc";
import { askAgentToVerifyCase } from "../../lib/agentHandoff";
import { askAgentToAutomateCase } from "../../lib/agentHandoff";
import { selectFlow } from "../../lib/router";
import type { Case, FlowCatalogEntry, StepPomCall, StepCoverage } from "../../lib/types";
import styles from "./CasesView.module.css";

export const ids = (c: Case) => c.ref;

/** Two env blocks, compared by content rather than key order. */
function sameEnv(a: Record<string, string>, b: Record<string, string> = {}): boolean {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  return keys.every((key) => a[key] === b[key]);
}

/** The flows that declare this case, labelled by the tag each carries. */
export function allFlows(c: Case): { column?: string; flow: string }[] {
  return (c.flows ?? []).map((f) => ({ column: f.tags[0], flow: f.path }));
}

interface CaseDetailProps {
  testCase: Case;
  onClose: () => void;
  onRun: (flow: string, platform?: string, projectId?: string) => void;
  onChanged: () => void;
}

export function CaseDetail({ testCase: c, onClose, onRun, onChanged }: CaseDetailProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [coverage, setCoverage] = useState<StepCoverage | null>(null);
  const [matrixField, setMatrixField] = useState<string | undefined>();
  const [poms, setPoms] = useState<FlowCatalogEntry[]>([]);
  const [flowChoices, setFlowChoices] = useState<string[]>([]);
  // Env typed for a step's page object but not yet written — saved on blur, so
  // a keystroke doesn't rewrite step-poms.json.
  const [envDrafts, setEnvDrafts] = useState<Record<string, Record<string, string>>>({});

  useEffect(() => {
    setError(null);
    setNotice(null);
    setCoverage(null);
    setEnvDrafts({});
    // Which steps the flow behind this case actually performs, via their POMs.
    caseStepCoverage(c.ref).then(setCoverage).catch(() => setCoverage(null));
  }, [c.ref]);

  useEffect(() => {
    listStepPoms().then(setPoms).catch(() => setPoms([]));
    loadFlowCatalog()
      .then(({ entries }) =>
        setFlowChoices(
          entries.filter((e) => e.kind === "flow" && !/^(pages|commands)\//.test(e.path)).map((e) => e.path),
        ),
      )
      .catch(() => setFlowChoices([]));
    qaseProjects()
      .then(({ projects }) => setMatrixField(projects.find((p) => p.matrixField)?.matrixField))
      .catch(() => setMatrixField(undefined));
  }, []);

  const flows = allFlows(c);
  // Columns the case claims but no flow declares yet — what the agent is for.
  const covered = new Set(flows.flatMap((f) => (f.column ? [f.column] : [])));
  const missingColumns = (matrixField ? (c.custom_fields[matrixField] ?? []) : []).filter(
    (column) => !covered.has(column) && !flows.length,
  );
  const scaffold = async (column?: string) => {
    setBusy(true);
    setError(null);
    try {
      const { flow, todos } = await scaffoldFlowFromCase({ ref: c.ref, column });
      onChanged();
      // Stay here: the flow is now linked to the case, so Run and Open are one
      // click away in this panel.
      setNotice(`Wrote ${flow}${todos ? ` — ${todos} step(s) still need a page object` : ""}.`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Which page objects perform a step. Studio's, not Qase's — kept beside it,
   * and a list because a step regularly bundles several actions.
   */
  const savePoms = async (stepKey: string, calls: StepPomCall[]) => {
    setBusy(true);
    try {
      await setCaseStepPoms(c.ref, stepKey, calls);
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const addPom = (stepKey: string, calls: StepPomCall[], pom: string) => {
    if (pom) void savePoms(stepKey, [...calls, { pom }]);
  };

  /** Swap one of a step's page objects, or drop it when `pom` is empty. */
  const replacePom = (stepKey: string, calls: StepPomCall[], index: number, pom: string) => {
    dropDraft(stepKey, index);
    // A different page object takes different parameters, so its env goes too.
    void savePoms(
      stepKey,
      pom ? calls.map((call, i) => (i === index ? { pom } : call)) : calls.filter((_, i) => i !== index),
    );
  };

  const draftKey = (stepKey: string, index: number) => `${stepKey}#${index}`;

  const dropDraft = (stepKey: string, index: number) =>
    setEnvDrafts(({ [draftKey(stepKey, index)]: _dropped, ...rest }) => rest);

  const envFor = (stepKey: string, index: number, saved?: Record<string, string>) =>
    envDrafts[draftKey(stepKey, index)] ?? saved ?? {};

  const editEnv = (
    stepKey: string,
    index: number,
    saved: Record<string, string> | undefined,
    param: string,
    value: string,
  ) =>
    setEnvDrafts((drafts) => ({
      ...drafts,
      [draftKey(stepKey, index)]: { ...(drafts[draftKey(stepKey, index)] ?? saved ?? {}), [param]: value },
    }));

  /** Write one page object's env, if it actually changed. */
  const saveEnv = async (stepKey: string, calls: StepPomCall[], index: number) => {
    const call = calls[index];
    const draft = envDrafts[draftKey(stepKey, index)];
    if (!call || !draft) return;
    const env = Object.fromEntries(
      Object.entries(draft).filter(([, value]) => value.trim()),
    ) as Record<string, string>;
    if (sameEnv(env, call.env)) return;
    await savePoms(
      stepKey,
      calls.map((current, i) =>
        i === index ? { pom: current.pom, ...(Object.keys(env).length ? { env } : {}) } : current,
      ),
    );
  };

  /** Point an existing flow at this case, by writing its header property. */
  const link = async (flow: string) => {
    if (!flow) return;
    setBusy(true);
    try {
      await linkCaseFlow(flow, [c.ref]);
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  /** Unlink: the flow stops declaring this case, and nothing else changes. */
  const unlink = async (flow: string) => {
    setBusy(true);
    try {
      await linkCaseFlow(flow, []);
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const facets: [string, string[]][] = [
    ...(c.suite ? ([["suite", [c.suite]]] as [string, string[]][]) : []),
    ...Object.entries(c.custom_fields),
    ...(c.tags.length ? ([["tags", c.tags]] as [string, string[]][]) : []),
  ];

  return (
    <aside className={styles.detail}>
      <header className={styles.detailHeader}>
        <div>
          <div className={styles.detailIds}>{ids(c)}</div>
          <h2 className={styles.detailTitle}>{c.title}</h2>
        </div>
        <div className={styles.detailActions}>
          <IconButton icon="close" label="Close case" onClick={onClose} />
        </div>
      </header>

      <div className={styles.detailBody}>
        {error ? <StatusPill tone="error">{error}</StatusPill> : null}
        {notice ? <StatusPill tone="info">{notice}</StatusPill> : null}
        {c.status !== "actual" ? (
          <div className={styles.statRow}>
            <StatusPill tone="warning">{c.status}</StatusPill>
          </div>
        ) : null}

        <section className={styles.section}>
          <Button size="sm" variant="ghost" icon="agent" onClick={() => askAgentToVerifyCase(c)}>
            Verify with the agent
          </Button>
        </section>

        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>Implemented by</h3>
          {flows.map(({ column, flow }) => (
            <div key={`${column}-${flow}`} className={styles.flowRow}>
              <div className={styles.flowText}>
                {column ? <span className={styles.flowColumn}>{column}</span> : null}
                <span className={styles.flowPath}>{flow}</span>
              </div>
              <div className={styles.flowActions}>
                <Button size="sm" variant="secondary" icon="play" onClick={() => onRun(flow, column)}>
                  Run
                </Button>
                <Button size="sm" variant="ghost" icon="file" onClick={() => selectFlow(flow)}>
                  Open
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  title="Remove this flow's testCaseId — the flow itself stays"
                  onClick={() => void unlink(flow)}
                >
                  Unlink
                </Button>
              </div>
            </div>
          ))}

          <label className={styles.field}>
            <span className={styles.fieldLabel}>Link a flow that already exists</span>
            <Select
              value=""
              disabled={busy}
              onChange={(e) => void link(e.target.value)}
              options={[
                { value: "", label: "Choose a flow…" },
                ...flowChoices
                  .filter((path) => !flows.some((f) => f.flow === path))
                  .map((path) => ({ value: path, label: path })),
              ]}
            />
          </label>

          {flows.length === 0 ? (
            <p className={styles.muted}>
              No flow declares this case yet — it is verified by hand, or by the agent executing
              its steps. A flow claims a case with <code>properties.testCaseId: {c.ref}</code> in
              its header.
            </p>
          ) : null}

          {/* The gap is the point: a case covered on one column and not the
              other is the easiest thing to automate, because the other flow is
              the reference. */}
          {missingColumns.length || !flows.length ? (
            <div className={styles.verdictRow}>
              {(missingColumns.length ? missingColumns : [undefined]).map((column) => (
                <Button
                  key={column ?? "any"}
                  size="sm"
                  variant="secondary"
                  icon="agent"
                  disabled={busy}
                  onClick={() => void askAgentToAutomateCase(c, column)}
                >
                  Write the {column ?? ""} flow with the agent
                </Button>
              ))}
              {c.steps?.length
                ? (missingColumns.length ? missingColumns : [undefined]).map((column) => (
                    <Button
                      key={`scaffold-${column ?? "any"}`}
                      size="sm"
                      variant="ghost"
                      icon="plus"
                      disabled={busy}
                      onClick={() => void scaffold(column)}
                    >
                      Scaffold{column ? ` ${column}` : ""} only
                    </Button>
                  ))
                : null}
            </div>
          ) : null}
          {missingColumns.length && flows.length ? (
            <p className={styles.muted}>
              {flows[0].column ?? "The existing flow"} is done; the agent gets it as the reference
              for {missingColumns.join(" and ")}.
            </p>
          ) : null}
        </section>

        {c.description ? (
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Description</h3>
            <p className={styles.prose}>{c.description}</p>
          </section>
        ) : null}

        {c.preconditions ? (
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Preconditions</h3>
            <p className={styles.prose}>{c.preconditions}</p>
          </section>
        ) : null}

        {c.steps?.length ? (
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>
              Steps —{" "}
              {coverage
                ? `${coverage.steps.filter((s) => s.backed).length}/${c.steps.length} automated`
                : "…"}
            </h3>
            {c.steps.map((step, i) => {
              const backed = coverage?.steps.find((s) => s.index === i)?.backed;
              const stepKey = step.hash ?? String(i);
              const calls = step.poms ?? [];
              return (
                <div key={i} className={styles.wizardStep}>
                  <div className={styles.wizardStepText}>
                    <span className={styles.wizardStepAction}>
                      {i + 1}. {step.action}
                    </span>
                    {step.data ? <span className={styles.muted}>data: {step.data}</span> : null}
                    {step.expected_result ? (
                      <span className={styles.wizardExpected}>→ {step.expected_result}</span>
                    ) : null}
                    {/* One step, several actions: "open the page and press play"
                        needs a page object each, run in this order. */}
                    {calls.map((call, j) => (
                      <div key={`${call.pom}-${j}`} className={styles.stepPom}>
                        <div className={styles.stepPomRow}>
                          <Select
                            value={call.pom}
                            disabled={busy}
                            onChange={(e) => replacePom(stepKey, calls, j, e.target.value)}
                            options={[
                              { value: "", label: "remove" },
                              ...poms.map((p) => ({ value: p.path, label: p.path })),
                              ...(poms.some((p) => p.path === call.pom)
                                ? []
                                : [{ value: call.pom, label: `${call.pom} (missing)` }]),
                            ]}
                          />
                          <IconButton
                            icon="close"
                            size={13}
                            label={`Remove ${call.pom}`}
                            onClick={() => replacePom(stepKey, calls, j, "")}
                          />
                        </div>
                        {/* A page object is a parameterized subflow: without its
                            env the runFlow a scaffold writes is incomplete. */}
                        {(poms.find((p) => p.path === call.pom)?.params ?? []).map((param) => (
                          <TextField
                            key={`${call.pom}-${param}`}
                            label={param}
                            className={styles.stepEnvField}
                            placeholder="value"
                            disabled={busy}
                            value={envFor(stepKey, j, call.env)[param] ?? ""}
                            onChange={(e) => editEnv(stepKey, j, call.env, param, e.target.value)}
                            onBlur={() => void saveEnv(stepKey, calls, j)}
                          />
                        ))}
                      </div>
                    ))}
                    <Select
                      value=""
                      disabled={busy}
                      onChange={(e) => addPom(stepKey, calls, e.target.value)}
                      options={[
                        { value: "", label: calls.length ? "add a page object…" : "no page object" },
                        ...poms.map((p) => ({ value: p.path, label: p.path })),
                      ]}
                    />
                  </div>
                  <StatusPill tone={backed ? "success" : calls.length ? "warning" : "neutral"}>
                    {backed ? "automated" : calls.length ? "not in flow" : "manual"}
                  </StatusPill>
                </div>
              );
            })}
            {coverage?.extra.length ? (
              <p className={styles.muted}>
                The flow also calls {coverage.extra.join(", ")} — no step accounts for that.
              </p>
            ) : null}
          </section>
        ) : null}

        {c.postconditions ? (
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Postconditions</h3>
            <p className={styles.prose}>{c.postconditions}</p>
          </section>
        ) : null}

        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>Tags</h3>
          {facets.map(([field, values]) => (
            <div key={field} className={styles.tagRow}>
              <span className={styles.tagDim}>{field}</span>
              <span className={styles.tagValues}>
                {values.map((v) => (
                  <Tag key={v}>{v}</Tag>
                ))}
              </span>
            </div>
          ))}
          {([
            ["severity", c.severity],
            ["priority", c.priority],
            ["type", c.type],
            ["behavior", c.behavior],
          ] as [string, string | undefined][])
            .filter(([, value]) => value)
            .map(([field, value]) => (
              <div key={field} className={styles.tagRow}>
                <span className={styles.tagDim}>{field}</span>
                <span className={styles.tagValues}>{value}</span>
              </div>
            ))}
        </section>

        {c.external_issues?.length ? (
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Traces to</h3>
            {c.external_issues.map((link) => (
              <a key={link} className={styles.link} href={link} target="_blank" rel="noreferrer">
                {link}
              </a>
            ))}
          </section>
        ) : null}

      </div>
    </aside>
  );
}
