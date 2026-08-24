import { Button, IconButton, StatusPill, Tag, TextField, type StatusTone } from "@conductor/studio-ui";
import { useEffect, useMemo, useState } from "react";

import {
  caseStepCoverage,
  casesDatasource,
  deleteCase,
  recordCaseResult,
  listStepPoms,
  saveCase,
  scaffoldFlowFromCase,
} from "../../lib/ipc";
import { askAgentToVerifyCase } from "../../lib/agentHandoff";
import { askAgentToAutomateCase } from "../../lib/agentHandoff";
import { selectFlow } from "../../lib/router";
import {
  CASE_STATUSES,
  PRIORITIES,
  RESULT_STATUSES,
  SEVERITIES,
  type Case,
  type CaseInput,
  type CaseResult,
  type CasesDatasource,
  type CaseStatus,
  type FlowCatalogEntry,
  type Priority,
  type ResultStatus,
  type Severity,
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

export function allFlows(c: Case): { column?: string; flow: string }[] {
  const entries: { column?: string; flow: string }[] = Object.entries(c.conductor?.flows ?? {}).map(
    ([column, flow]) => ({ column, flow }),
  );
  if (c.conductor?.flow) entries.push({ flow: c.conductor.flow });
  return entries;
}

interface CaseDetailProps {
  testCase: Case;
  onClose: () => void;
  onRun: (flow: string, platform?: string, projectId?: string) => void;
  onChanged: () => void;
}

export function CaseDetail({ testCase: c, onClose, onRun, onChanged }: CaseDetailProps) {
  const [editing, setEditing] = useState(false);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [coverage, setCoverage] = useState<StepCoverage | null>(null);
  const [source, setSource] = useState<CasesDatasource | null>(null);

  useEffect(() => {
    setEditing(false);
    setComment("");
    setError(null);
    setConfirmDelete(false);
    setCoverage(null);
    // Which steps the flow behind this case actually performs, via their POMs.
    caseStepCoverage(c.ref).then(setCoverage).catch(() => setCoverage(null));
  }, [c.ref]);

  useEffect(() => {
    casesDatasource().then(setSource).catch(() => setSource(null));
  }, []);

  const flows = allFlows(c);
  // Columns the case claims but nothing implements yet — what the agent is for.
  const matrixField = source?.qase?.matrixField;
  const missingColumns = (matrixField ? (c.custom_fields[matrixField] ?? []) : []).filter(
    (p) => !c.conductor?.flows?.[p] && !c.conductor?.flow,
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

  const remove = async () => {
    try {
      await deleteCase(c.id);
      onClose();
      onChanged();
    } catch (e) {
      setError(String(e));
    }
  };

  if (editing) {
    return (
      <CaseEditor
        testCase={c}
        onCancel={() => setEditing(false)}
        onSaved={() => {
          setEditing(false);
          onChanged();
        }}
      />
    );
  }

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
          <IconButton icon="code" label="Edit case" onClick={() => setEditing(true)} />
          <IconButton
            icon="trash"
            label={confirmDelete ? "Confirm delete" : "Delete case"}
            active={confirmDelete}
            onClick={() => (confirmDelete ? void remove() : setConfirmDelete(true))}
          />
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
                <Button size="sm" variant="secondary" icon="play" onClick={() => onRun(flow, column, c.project)}>
                  Run
                </Button>
                <Button size="sm" variant="ghost" icon="file" onClick={() => selectFlow(flow)}>
                  Open
                </Button>
              </div>
            </div>
          ))}

          {flows.length === 0 ? (
            <p className={styles.muted}>
              No flow yet — this case is verified by hand, or by the agent executing its steps
              (“Verify with the agent” above files a report and a result).
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
                    {step.pom ? (
                      <span className={styles.flowPath}>
                        {step.pom}
                        {step.env
                          ? ` (${Object.entries(step.env).map(([k, v]) => `${k}=${v}`).join(", ")})`
                          : ""}
                      </span>
                    ) : null}
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

        <p className={styles.muted}>{c.filePath}</p>
      </div>
    </aside>
  );
}

// ── Editor ──────────────────────────────────────────────────────────────────

interface CaseEditorProps {
  testCase: Case | null;
  onCancel: () => void;
  onSaved: (saved: Case) => void;
}

/**
 * Create or edit a case. Writes the YAML file; comments in it survive.
 *
 * When cases come from Qase, everything Qase owns is read-only here — it is
 * authored there, and the next sync would revert an edit made in Studio. What
 * stays editable is Conductor's own wiring: which flow implements the case, and
 * which page object performs each step.
 */
export function CaseEditor({ testCase, onCancel, onSaved }: CaseEditorProps) {
  const [source, setSource] = useState<CasesDatasource | null>(null);
  const locked = source?.mode === "qase";

  const [draft, setDraft] = useState<CaseInput>(() => ({
    id: testCase?.id ?? 0,
    title: testCase?.title ?? "",
    description: testCase?.description ?? "",
    preconditions: testCase?.preconditions ?? "",
    postconditions: testCase?.postconditions ?? "",
    severity: testCase?.severity,
    priority: testCase?.priority,
    status: testCase?.status,
    custom_fields: testCase?.custom_fields ?? {},
    tags: testCase?.tags ?? [],
    conductor: testCase?.conductor,
    previousId: testCase?.id,
  }));
  // `1. action -> expected @ pages/foo.yaml?key=value` per line: readable to a
  // tester, and still carries the page object that automates it.
  const [stepText, setStepText] = useState(() =>
    (testCase?.steps ?? [])
      .map((step) => {
        const env = step.env ? `?${new URLSearchParams(step.env).toString()}` : "";
        return [
          step.action,
          step.expected_result ? ` -> ${step.expected_result}` : "",
          step.pom ? ` @ ${step.pom}${env}` : "",
        ].join("");
      })
      .join("\n"),
  );
  const [fieldText, setFieldText] = useState(() =>
    Object.entries(testCase?.custom_fields ?? {})
      .map(([field, values]) => `${field}: ${values.join(", ")}`)
      .join("\n"),
  );
  const [flowText, setFlowText] = useState(() =>
    testCase?.conductor?.flows
      ? Object.entries(testCase.conductor.flows).map(([col, flow]) => `${col}: ${flow}`).join("\n")
      : (testCase?.conductor?.flow ?? ""),
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [poms, setPoms] = useState<FlowCatalogEntry[]>([]);

  useEffect(() => {
    listStepPoms().then(setPoms).catch(() => {});
    casesDatasource().then(setSource).catch(() => setSource(null));
  }, []);

  const set = <K extends keyof CaseInput>(key: K, value: CaseInput[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const save = async () => {
    setSaving(true);
    try {
      // `field: a, b` per line for custom fields; `column: flow` (or a bare
      // path) for flows.
      const custom_fields: Record<string, string[]> = {};
      for (const line of fieldText.split("\n")) {
        const [field, rest] = line.split(":");
        if (!field?.trim() || !rest?.trim()) continue;
        custom_fields[field.trim()] = rest.split(",").map((v) => v.trim()).filter(Boolean);
      }
      const flows: Record<string, string> = {};
      let flow: string | undefined;
      for (const line of flowText.split("\n")) {
        if (!line.trim()) continue;
        const [column, ...rest] = line.split(":");
        if (rest.length && rest.join(":").trim()) flows[column.trim()] = rest.join(":").trim();
        else flow = line.trim();
      }
      const steps = stepText
        .split("\n")
        .map((line) => line.replace(/^\s*\d+[.)]\s*/, "").trim())
        .filter(Boolean)
        .map((line) => {
          const [before, pomPart] = line.split(" @ ");
          const [action, expected] = before.split(" -> ");
          if (!pomPart) return { action: action.trim(), expected_result: expected?.trim() };
          const [pom, queryString] = pomPart.trim().split("?");
          const env = Object.fromEntries(new URLSearchParams(queryString ?? ""));
          return {
            action: action.trim(),
            expected_result: expected?.trim(),
            pom: pom.trim(),
            env: Object.keys(env).length ? env : undefined,
          };
        });

      // In qase mode only the wiring is ours to write; sending the rest back
      // unchanged is what saveCase refuses, so don't send it at all.
      const saved = await saveCase(
        locked
          ? {
              id: draft.id,
              previousId: draft.previousId,
              title: draft.title,
              steps,
              conductor: {
                flow: Object.keys(flows).length ? undefined : flow,
                flows: Object.keys(flows).length ? flows : undefined,
              },
            }
          : {
              ...draft,
              steps,
              custom_fields,
              conductor: {
                flow: Object.keys(flows).length ? undefined : flow,
                flows: Object.keys(flows).length ? flows : undefined,
              },
            },
      );
      onSaved(saved);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <aside className={styles.detail}>
      <header className={styles.detailHeader}>
        <h2 className={styles.detailTitle}>{testCase ? "Edit case" : "New case"}</h2>
        <IconButton icon="close" label="Cancel" onClick={onCancel} />
      </header>
      <div className={styles.detailBody}>
        {error ? <StatusPill tone="error">{error}</StatusPill> : null}
        {locked ? (
          <p className={styles.muted}>
            Cases come from Qase project {source?.projectCode}. Title, steps, tags and fields are
            edited there — here you link the flow that implements the case and the page object
            behind each step.
          </p>
        ) : null}
        <Field label="Id">
          <TextField
            value={String(draft.id || "")}
            disabled={locked}
            onChange={(e) => set("id", Number(e.target.value.replace(/[^0-9]/g, "")) || 0)}
            placeholder="12"
          />
        </Field>
        <Field label="Title">
          <TextField
            value={draft.title}
            disabled={locked}
            onChange={(e) => set("title", e.target.value)}
          />
        </Field>
        <Field label="Description">
          <textarea
            className={styles.textarea}
            rows={3}
            disabled={locked}
            value={draft.description ?? ""}
            onChange={(e) => set("description", e.target.value)}
          />
        </Field>
        <Field label="Steps — `action -> expected @ pages/x.yaml?key=value` per line">
          <textarea
            className={styles.textarea}
            rows={7}
            value={stepText}
            onChange={(e) => setStepText(e.target.value)}
            placeholder={
              "Open the details page -> The title is shown @ pages/details/open.yaml?path=movie/sintel"
            }
          />
          {poms.length ? (
            <span className={styles.fieldLabel}>
              {poms.length} page objects available — e.g. {poms[0].path}
              {poms[0].params.length ? `?${poms[0].params.map((p) => `${p}=`).join("&")}` : ""}
            </span>
          ) : null}
          {locked ? (
            <span className={styles.fieldLabel}>
              Only the `@ page-object` part of a step is saved — the wording comes from Qase.
            </span>
          ) : null}
        </Field>
        <Field label="Preconditions">
          <textarea
            className={styles.textarea}
            rows={2}
            disabled={locked}
            value={draft.preconditions ?? ""}
            onChange={(e) => set("preconditions", e.target.value)}
          />
        </Field>
        <Field label="Postconditions">
          <textarea
            className={styles.textarea}
            rows={2}
            disabled={locked}
            value={draft.postconditions ?? ""}
            onChange={(e) => set("postconditions", e.target.value)}
          />
        </Field>
        <Field label="Custom fields — one `field: a, b` per line">
          <textarea
            className={styles.textarea}
            rows={4}
            disabled={locked}
            value={fieldText}
            onChange={(e) => setFieldText(e.target.value)}
            placeholder={"Platform: ios, android"}
          />
        </Field>
        <Field label="Tags — comma separated">
          <TextField
            value={(draft.tags ?? []).join(", ")}
            disabled={locked}
            onChange={(e) =>
              set("tags", e.target.value.split(",").map((v) => v.trim()).filter(Boolean))
            }
          />
        </Field>
        <Field label="Flows — `column: path`, or one bare path">
          <textarea
            className={styles.textarea}
            rows={3}
            value={flowText}
            onChange={(e) => setFlowText(e.target.value)}
          />
        </Field>
        <Field label="Severity">
          <select
            className={styles.textarea}
            disabled={locked}
            value={draft.severity ?? ""}
            onChange={(e) => set("severity", (e.target.value || undefined) as Severity | undefined)}
          >
            <option value="">—</option>
            {SEVERITIES.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Priority">
          <select
            className={styles.textarea}
            disabled={locked}
            value={draft.priority ?? ""}
            onChange={(e) => set("priority", (e.target.value || undefined) as Priority | undefined)}
          >
            <option value="">—</option>
            {PRIORITIES.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Status">
          <select
            className={styles.textarea}
            disabled={locked}
            value={draft.status ?? "actual"}
            onChange={(e) => set("status", e.target.value as CaseStatus)}
          >
            {CASE_STATUSES.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        <div className={styles.verdictRow}>
          <Button size="sm" disabled={saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Save case"}
          </Button>
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </aside>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      {children}
    </label>
  );
}
