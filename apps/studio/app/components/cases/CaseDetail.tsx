import { Button, IconButton, Select, StatusPill, Tag, TextField, type StatusTone } from "@conductor/studio-ui";
import { useEffect, useMemo, useState } from "react";

import {
  caseStepCoverage,
  linkCaseFlow,
  listStepPoms,
  qaseProjects,
  recordCaseResult,
  scaffoldFlowFromCase,
  setCaseStepPom,
  loadFlowCatalog,
} from "../../lib/ipc";
import { askAgentToVerifyCase } from "../../lib/agentHandoff";
import { askAgentToAutomateCase } from "../../lib/agentHandoff";
import { selectFlow } from "../../lib/router";
import {
  RESULT_STATUSES,
  type Case,
  type CaseResult,
  type FlowCatalogEntry,
  type ResultStatus,
  type StepCoverage,
} from "../../lib/types";
import styles from "./CasesView.module.css";

const STATUS_TONE: Record<ResultStatus, StatusTone> = {
  passed: "success",
  failed: "error",
  blocked: "warning",
  skipped: "neutral",
  invalid: "warning",
};

const SOURCE_LABEL: Record<CaseResult["source"], string> = {
  run: "flow run",
  manual: "manual",
  report: "agent",
};

export const ids = (c: Case) => c.ref;

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
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [coverage, setCoverage] = useState<StepCoverage | null>(null);
  const [matrixField, setMatrixField] = useState<string | undefined>();
  const [poms, setPoms] = useState<FlowCatalogEntry[]>([]);
  const [flowChoices, setFlowChoices] = useState<string[]>([]);

  useEffect(() => {
    setComment("");
    setError(null);
    setCoverage(null);
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
  const results = c.results ?? [];
  const stats = useMemo(() => {
    const decisive = results.filter((r) => r.status === "passed" || r.status === "failed");
    const passed = decisive.filter((r) => r.status === "passed").length;
    const recent = decisive.slice(0, 10);
    return {
      total: results.length,
      passRate: decisive.length ? Math.round((passed / decisive.length) * 100) : null,
      flaky: recent.some((r) => r.status === "passed") && recent.some((r) => r.status === "failed"),
    };
  }, [results]);

  const record = async (status: ResultStatus) => {
    setBusy(true);
    try {
      await recordCaseResult({
        case_id: c.id,
        ref: c.ref,
        status,
        source: "manual",
        comment: comment.trim() || undefined,
      });
      setComment("");
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const scaffold = async (column?: string) => {
    setBusy(true);
    try {
      const { flow, todos } = await scaffoldFlowFromCase({ ref: c.ref, column });
      onChanged();
      // Stay here: the flow is now linked to the case, so Run and Open are one
      // click away in this panel.
      setError(`Wrote ${flow}${todos ? ` — ${todos} step(s) still need a page object` : ""}.`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  /** Which page object performs a step. Studio's, not Qase's — kept beside it. */
  const assignPom = async (stepKey: string, pom: string) => {
    setBusy(true);
    try {
      await setCaseStepPom(c.ref, stepKey, pom || undefined);
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
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
        <div className={styles.statRow}>
          {c.lastResult ? (
            <StatusPill tone={STATUS_TONE[c.lastResult.status]}>
              {c.lastResult.status} · {SOURCE_LABEL[c.lastResult.source]}
            </StatusPill>
          ) : (
            <StatusPill tone="neutral">never executed</StatusPill>
          )}
          {stats.passRate !== null ? (
            <span className={styles.muted}>
              {stats.passRate}% pass over {stats.total}
            </span>
          ) : null}
          {stats.flaky ? <StatusPill tone="warning">flaky</StatusPill> : null}
          {c.status !== "actual" ? <StatusPill tone="warning">{c.status}</StatusPill> : null}
        </div>

        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>Record a result</h3>
          <TextField
            placeholder="What happened? (optional)"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
          <div className={styles.verdictRow}>
            {RESULT_STATUSES.map((v) => (
              <Button key={v} size="sm" variant="secondary" disabled={busy} onClick={() => void record(v)}>
                {v}
              </Button>
            ))}
          </div>
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
                    {step.env && step.pom ? (
                      <span className={styles.flowPath}>
                        {Object.entries(step.env).map(([k, v]) => `${k}=${v}`).join(", ")}
                      </span>
                    ) : null}
                    <Select
                      value={step.pom ?? ""}
                      disabled={busy}
                      onChange={(e) => void assignPom(step.hash ?? String(i), e.target.value)}
                      options={[
                        { value: "", label: "no page object" },
                        ...poms.map((p) => ({ value: p.path, label: p.path })),
                        ...(step.pom && !poms.some((p) => p.path === step.pom)
                          ? [{ value: step.pom, label: `${step.pom} (missing)` }]
                          : []),
                      ]}
                    />
                  </div>
                  <StatusPill tone={backed ? "success" : step.pom ? "warning" : "neutral"}>
                    {backed ? "automated" : step.pom ? "not in flow" : "manual"}
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

        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>History ({results.length})</h3>
          {results.length ? (
            results.slice(0, 25).map((r) => (
              <div key={r.id} className={styles.historyRow}>
                <StatusPill tone={STATUS_TONE[r.status]}>{r.status}</StatusPill>
                <span className={styles.historyMeta}>
                  {SOURCE_LABEL[r.source]}
                  {r.column ? ` · ${r.column}` : ""} · {new Date(r.at).toLocaleString()}
                  {r.app_version ? ` · ${r.app_version}` : ""}
                  {r.comment ? ` — ${r.comment}` : ""}
                </span>
              </div>
            ))
          ) : (
            <p className={styles.muted}>Nothing has run this case yet.</p>
          )}
        </section>

      </div>
    </aside>
  );
}
