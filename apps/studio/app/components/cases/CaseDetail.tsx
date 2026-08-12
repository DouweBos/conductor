import { Button, IconButton, StatusPill, Tag, TextField, type StatusTone } from "@conductor/studio-ui";
import { useEffect, useMemo, useState } from "react";

import {
  caseStepCoverage,
  deleteCase,
  recordCaseResult,
  listStepPoms,
  saveCase,
  scaffoldFlowFromCase,
} from "../../lib/ipc";
import { askAgentToVerifyCase } from "../../lib/agentHandoff";
import { askAgentToAutomateCase } from "../../lib/agentHandoff";
import { selectFlow } from "../../lib/router";
import type {
  CaseResult,
  CaseVerdict,
  FlowCatalogEntry,
  StepCoverage,
  TestCase,
  TestCaseInput,
} from "../../lib/types";
import styles from "./CasesView.module.css";

const VERDICT_TONE: Record<CaseVerdict, StatusTone> = {
  passed: "success",
  failed: "error",
  blocked: "warning",
  skipped: "neutral",
};

const SOURCE_LABEL: Record<CaseResult["source"], string> = {
  run: "flow run",
  manual: "manual",
  report: "agent",
  ci: "CI",
};

export const ids = (c: TestCase) => [c.id, ...(c.altIds ?? [])].join(" · ");

export function allFlows(c: TestCase): { column?: string; flow: string }[] {
  const entries: { column?: string; flow: string }[] = Object.entries(c.flows ?? {}).map(
    ([column, flow]) => ({ column, flow }),
  );
  if (c.flow) entries.push({ flow: c.flow });
  return entries;
}

interface CaseDetailProps {
  testCase: TestCase;
  onClose: () => void;
  onRun: (flow: string, platform?: string) => void;
  onChanged: () => void;
}

export function CaseDetail({ testCase: c, onClose, onRun, onChanged }: CaseDetailProps) {
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [coverage, setCoverage] = useState<StepCoverage | null>(null);

  useEffect(() => {
    setEditing(false);
    setNote("");
    setError(null);
    setConfirmDelete(false);
    setCoverage(null);
    // Which steps the flow behind this case actually performs, via their POMs.
    caseStepCoverage(c.id).then(setCoverage).catch(() => setCoverage(null));
  }, [c.id]);

  const flows = allFlows(c);
  // Columns the case claims but nothing implements yet — what the agent is for.
  const missingColumns = (c.tags.platform ?? []).filter((p) => !c.flows?.[p] && !c.flow);
  const results = c.results ?? [];
  const stats = useMemo(() => {
    const decisive = results.filter((r) => r.verdict === "passed" || r.verdict === "failed");
    const passed = decisive.filter((r) => r.verdict === "passed").length;
    const recent = decisive.slice(0, 10);
    return {
      total: results.length,
      passRate: decisive.length ? Math.round((passed / decisive.length) * 100) : null,
      flaky: recent.some((r) => r.verdict === "passed") && recent.some((r) => r.verdict === "failed"),
    };
  }, [results]);


  const record = async (verdict: CaseVerdict) => {
    setBusy(true);
    try {
      await recordCaseResult({ caseId: c.id, verdict, source: "manual", note: note.trim() || undefined });
      setNote("");
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
      const { flow, todos } = await scaffoldFlowFromCase({ caseId: c.id, column });
      onChanged();
      // Stay here: the flow is now linked to the case, so Run and Open are one
      // click away in this panel.
      setError(
        `Wrote ${flow}${todos ? ` — ${todos} step(s) still need a page object` : ""}.`,
      );
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
            <StatusPill tone={VERDICT_TONE[c.lastResult.verdict]}>
              {c.lastResult.verdict} · {SOURCE_LABEL[c.lastResult.source]}
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
        </div>

        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>Record a result</h3>
          <TextField
            placeholder="What happened? (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className={styles.verdictRow}>
            {(["passed", "failed", "blocked", "skipped"] as CaseVerdict[]).map((v) => (
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
              </div>
            </div>
          ))}

          {flows.length === 0 ? (
            <p className={styles.muted}>
              No flow yet — this case is verified by hand, or by the agent executing its steps
              (“Verify with the agent” above files a report and a result).
            </p>
          ) : null}

          {/* The gap is the point: a case covered on one platform and not the
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

        {c.userStory ? (
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Business rule</h3>
            <p className={styles.prose}>{c.userStory}</p>
          </section>
        ) : null}

        {c.preconditions?.length ? (
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Preconditions</h3>
            {c.preconditions.map((p) => (
              <p key={p} className={styles.prose}>
                {p}
              </p>
            ))}
          </section>
        ) : null}

        {c.steps?.length ? (
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>
              Steps — {coverage ? `${coverage.steps.filter((s) => s.backed).length}/${c.steps.length} automated` : "…"}
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
                    {step.expected ? <span className={styles.wizardExpected}>→ {step.expected}</span> : null}
                    {step.pom ? (
                      <span className={styles.flowPath}>
                        {step.pom}
                        {step.env ? ` (${Object.entries(step.env).map(([k, v]) => `${k}=${v}`).join(", ")})` : ""}
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
        ) : c.description ? (
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Steps</h3>
            <pre className={styles.steps}>{c.description}</pre>
          </section>
        ) : null}

        {c.postconditions?.length ? (
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Postconditions</h3>
            {c.postconditions.map((p) => (
              <p key={p} className={styles.prose}>
                {p}
              </p>
            ))}
          </section>
        ) : null}

        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>Tags</h3>
          {Object.entries(c.tags).map(([dim, values]) => (
            <div key={dim} className={styles.tagRow}>
              <span className={styles.tagDim}>{dim}</span>
              <span className={styles.tagValues}>
                {values.map((v) => (
                  <Tag key={v}>{v}</Tag>
                ))}
              </span>
            </div>
          ))}
          {c.owner ? (
            <div className={styles.tagRow}>
              <span className={styles.tagDim}>owner</span>
              <span className={styles.tagValues}>{c.owner}</span>
            </div>
          ) : null}
          {c.state ? (
            <div className={styles.tagRow}>
              <span className={styles.tagDim}>state</span>
              <span className={styles.tagValues}>{c.state}</span>
            </div>
          ) : null}
        </section>

        {c.links?.length ? (
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Traces to</h3>
            {c.links.map((link) => (
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
                <StatusPill tone={VERDICT_TONE[r.verdict]}>{r.verdict}</StatusPill>
                <span className={styles.historyMeta}>
                  {SOURCE_LABEL[r.source]}
                  {r.column ? ` · ${r.column}` : ""} · {new Date(r.at).toLocaleString()}
                  {r.note ? ` — ${r.note}` : ""}
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
  testCase: TestCase | null;
  onCancel: () => void;
  onSaved: (saved: TestCase) => void;
}

/** Create or edit a case. Writes the YAML file; comments in it survive. */
export function CaseEditor({ testCase, onCancel, onSaved }: CaseEditorProps) {
  const [draft, setDraft] = useState<TestCaseInput>(() => ({
    id: testCase?.id ?? "",
    altIds: testCase?.altIds ?? [],
    title: testCase?.title ?? "",
    userStory: testCase?.userStory ?? "",
    description: testCase?.description ?? "",
    tags: testCase?.tags ?? {},
    flow: testCase?.flow,
    flows: testCase?.flows,
    owner: testCase?.owner ?? "",
    state: testCase?.state ?? "",
    links: testCase?.links ?? [],
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
          step.expected ? ` -> ${step.expected}` : "",
          step.pom ? ` @ ${step.pom}${env}` : "",
        ].join("");
      })
      .join("\n"),
  );
  const [conditionText, setConditionText] = useState(() =>
    [
      ...(testCase?.preconditions ?? []).map((p) => `pre: ${p}`),
      ...(testCase?.postconditions ?? []).map((p) => `post: ${p}`),
    ].join("\n"),
  );
  const [tagText, setTagText] = useState(() =>
    Object.entries(testCase?.tags ?? {})
      .map(([dim, values]) => `${dim}: ${values.join(", ")}`)
      .join("\n"),
  );
  const [flowText, setFlowText] = useState(() =>
    testCase?.flows
      ? Object.entries(testCase.flows).map(([col, flow]) => `${col}: ${flow}`).join("\n")
      : (testCase?.flow ?? ""),
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [poms, setPoms] = useState<FlowCatalogEntry[]>([]);

  useEffect(() => {
    listStepPoms().then(setPoms).catch(() => {});
  }, []);

  const set = <K extends keyof TestCaseInput>(key: K, value: TestCaseInput[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const save = async () => {
    setSaving(true);
    try {
      // `dimension: a, b` per line for tags; `column: flow` (or a bare path) for flows.
      const tags: Record<string, string[]> = {};
      for (const line of tagText.split("\n")) {
        const [dim, rest] = line.split(":");
        if (!dim?.trim() || !rest?.trim()) continue;
        tags[dim.trim()] = rest.split(",").map((v) => v.trim()).filter(Boolean);
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
          if (!pomPart) return { action: action.trim(), expected: expected?.trim() };
          const [pom, queryString] = pomPart.trim().split("?");
          const env = Object.fromEntries(new URLSearchParams(queryString ?? ""));
          return {
            action: action.trim(),
            expected: expected?.trim(),
            pom: pom.trim(),
            env: Object.keys(env).length ? env : undefined,
          };
        });
      const preconditions: string[] = [];
      const postconditions: string[] = [];
      for (const line of conditionText.split("\n")) {
        const match = /^\s*(pre|post):\s*(.+)$/i.exec(line);
        if (!match) continue;
        (match[1].toLowerCase() === "pre" ? preconditions : postconditions).push(match[2].trim());
      }

      const saved = await saveCase({
        ...draft,
        steps,
        preconditions,
        postconditions,
        tags,
        flow: Object.keys(flows).length ? undefined : flow,
        flows: Object.keys(flows).length ? flows : undefined,
      });
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
        <Field label="Id">
          <TextField value={draft.id} onChange={(e) => set("id", e.target.value)} placeholder="TC-001" />
        </Field>
        <Field label="Title">
          <TextField value={draft.title} onChange={(e) => set("title", e.target.value)} />
        </Field>
        <Field label="Alternate ids">
          <TextField
            value={(draft.altIds ?? []).join(", ")}
            placeholder="Ids for the same case in other matrices"
            onChange={(e) => set("altIds", e.target.value.split(",").map((v) => v.trim()).filter(Boolean))}
          />
        </Field>
        <Field label="Business rule">
          <textarea
            className={styles.textarea}
            rows={3}
            value={draft.userStory ?? ""}
            onChange={(e) => set("userStory", e.target.value)}
          />
        </Field>
        <Field label="Steps — `action -> expected @ pages/x.yaml?key=value` per line">
          <textarea
            className={styles.textarea}
            rows={7}
            value={stepText}
            onChange={(e) => setStepText(e.target.value)}
            placeholder={"Open the details page -> The title is shown @ pages/details/open.yaml?path=movie/sintel"}
          />
          {poms.length ? (
            <span className={styles.fieldLabel}>
              {poms.length} page objects available — e.g. {poms[0].path}
              {poms[0].params.length ? `?${poms[0].params.map((p) => `${p}=`).join("&")}` : ""}
            </span>
          ) : null}
        </Field>
        <Field label="Pre / postconditions — `pre:` or `post:` per line">
          <textarea
            className={styles.textarea}
            rows={3}
            value={conditionText}
            onChange={(e) => setConditionText(e.target.value)}
          />
        </Field>
        <Field label="Free-text steps (legacy)">
          <textarea
            className={styles.textarea}
            rows={3}
            value={draft.description ?? ""}
            onChange={(e) => set("description", e.target.value)}
          />
        </Field>
        <Field label="Tags — one `dimension: a, b` per line">
          <textarea
            className={styles.textarea}
            rows={4}
            value={tagText}
            onChange={(e) => setTagText(e.target.value)}
          />
        </Field>
        <Field label="Flows — `platform: path`, or one bare path">
          <textarea
            className={styles.textarea}
            rows={3}
            value={flowText}
            onChange={(e) => setFlowText(e.target.value)}
          />
        </Field>
        <Field label="Owner">
          <TextField value={draft.owner ?? ""} onChange={(e) => set("owner", e.target.value)} />
        </Field>
        <Field label="State">
          <TextField
            value={draft.state ?? ""}
            placeholder="draft / review / ready"
            onChange={(e) => set("state", e.target.value)}
          />
        </Field>
        <Field label="Traces to — comma separated URLs">
          <TextField
            value={(draft.links ?? []).join(", ")}
            onChange={(e) => set("links", e.target.value.split(",").map((v) => v.trim()).filter(Boolean))}
          />
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
