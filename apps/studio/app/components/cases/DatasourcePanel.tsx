import { Button, IconButton, Select, StatusPill, TextField } from "@conductor/studio-ui";
import { useEffect, useState } from "react";

import {
  availableQaseProjects,
  deleteQaseProject,
  qaseProjects as fetchQaseProjects,
  saveQaseProject,
  testQaseProject,
} from "../../lib/ipc";
import type { QaseProject } from "../../lib/types";
import styles from "./CasesView.module.css";

interface DatasourcePanelProps {
  onClose: () => void;
  onChanged: () => void;
  /** Custom fields the fetched cases actually carry, for the column picker. */
  fields: string[];
}

const NEW_PROJECT = "__new__";

function blankProject(): QaseProject {
  return { code: "" };
}

/**
 * The Qase projects this repo's flows are written against. Which project a case
 * belongs to is read off its id — `MC-12` is MC's — so all that is configured
 * here is a token per project, and which field the matrix columns come from.
 *
 * A token never lands in the settings file in the clear — it goes through
 * Electron's safeStorage — and `QASE_API_TOKEN` overrides all of them.
 */
export function DatasourcePanel({ onClose, onChanged, fields }: DatasourcePanelProps) {
  const [projects, setProjects] = useState<QaseProject[] | null>(null);
  const [referenced, setReferenced] = useState<string[]>([]);
  const [editing, setEditing] = useState<string>(NEW_PROJECT);
  const [draft, setDraft] = useState<QaseProject>(blankProject());
  const [token, setToken] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [available, setAvailable] = useState<{ code: string; title: string }[] | null>(null);
  const [availableError, setAvailableError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = () =>
    fetchQaseProjects()
      .then(({ projects: list, referenced: codes }) => {
        setProjects(list);
        setReferenced(codes);
        const first = list[0]?.code ?? NEW_PROJECT;
        setEditing(first);
        setDraft(list[0] ?? blankProject());
      })
      .catch((e) => setError(String(e)));

  useEffect(() => {
    void load();
  }, []);

  const typedToken = token.trim();
  const isNew = editing === NEW_PROJECT;
  const canList = typedToken.length > 0 || Boolean(draft.hasToken);

  // As soon as a token exists — typed here or already stored — the project code
  // becomes a picker instead of something to look up in Qase and retype.
  useEffect(() => {
    if (!canList) {
      setAvailable(null);
      setAvailableError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    // Debounced so pasting a token doesn't fire a request per keystroke.
    const timer = setTimeout(() => {
      availableQaseProjects(typedToken || undefined, isNew ? undefined : draft.code)
        .then((result) => {
          if (cancelled) return;
          setAvailable(result.ok ? (result.projects ?? []) : null);
          setAvailableError(result.ok ? null : (result.error ?? "Could not reach Qase."));
        })
        .catch((e) => {
          if (cancelled) return;
          setAvailable(null);
          setAvailableError(String(e));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [canList, typedToken, draft.code, isNew]);

  if (!projects) {
    return (
      <aside className={styles.detail}>
        <header className={styles.detailHeader}>
          <h2 className={styles.detailTitle}>Qase projects</h2>
          <IconButton icon="close" label="Close" onClick={onClose} />
        </header>
        <div className={styles.detailBody}>
          {error ? <StatusPill tone="error">{error}</StatusPill> : <p className={styles.muted}>Loading…</p>}
        </div>
      </aside>
    );
  }

  const pick = (code: string) => {
    setEditing(code);
    setDraft(code === NEW_PROJECT ? blankProject() : (projects.find((p) => p.code === code) ?? blankProject()));
    setToken("");
    setStatus(null);
    setError(null);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      if (!draft.code.trim()) throw new Error("A project needs its Qase code.");
      // An empty box means "leave the stored token alone", not "clear it" —
      // the field is never populated with the real value to begin with.
      const next = await saveQaseProject(draft, typedToken || undefined);
      setProjects(next);
      setEditing(draft.code.toUpperCase());
      setDraft(next.find((p) => p.code === draft.code.toUpperCase()) ?? draft);
      setToken("");
      setStatus("Saved. Refresh to fetch its cases.");
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (isNew) return pick(projects[0]?.code ?? NEW_PROJECT);
    setBusy(true);
    setError(null);
    try {
      const next = await deleteQaseProject(draft.code);
      setProjects(next);
      pick(next[0]?.code ?? NEW_PROJECT);
      setStatus("Removed, along with its cached cases. The flows are untouched.");
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    setError(null);
    setStatus(null);
    const result = await testQaseProject(typedToken || undefined, draft.code);
    setBusy(false);
    if (result.ok) setStatus(`Connected to "${result.project}".`);
    else setError(result.error ?? "Could not reach Qase.");
  };

  const missing = referenced.filter((code) => !projects.some((p) => p.code === code));

  return (
    <aside className={styles.detail}>
      <header className={styles.detailHeader}>
        <h2 className={styles.detailTitle}>Qase projects</h2>
        <IconButton icon="close" label="Close" onClick={onClose} />
      </header>
      <div className={styles.detailBody}>
        {error ? <StatusPill tone="error">{error}</StatusPill> : null}
        {status ? <StatusPill tone="success">{status}</StatusPill> : null}
        {missing.length ? (
          <StatusPill tone="warning">
            Flows reference {missing.join(", ")} — add {missing.length > 1 ? "them" : "it"} to see
            those cases.
          </StatusPill>
        ) : null}

        <label className={styles.field}>
          <span className={styles.fieldLabel}>Editing</span>
          <Select
            value={editing}
            onChange={(e) => pick(e.target.value)}
            options={[
              ...projects.map((p) => ({ value: p.code, label: p.code })),
              { value: NEW_PROJECT, label: "＋ Add a project…" },
            ]}
          />
        </label>

        <label className={styles.field}>
          <span className={styles.fieldLabel}>
            API token {draft.hasToken ? "(one is stored — type to replace it)" : ""}
          </span>
          <TextField
            type="password"
            value={token}
            placeholder={draft.hasToken ? "••••••••" : "Paste your Qase API token"}
            onChange={(e) => setToken(e.target.value)}
          />
        </label>

        <label className={styles.field}>
          <span className={styles.fieldLabel}>Qase project</span>
          {available?.length ? (
            <Select
              value={draft.code}
              onChange={(e) => setDraft({ ...draft, code: e.target.value })}
              options={[
                ...(draft.code ? [] : [{ value: "", label: "Choose a project…" }]),
                ...available.map((p) => ({ value: p.code, label: `${p.title} (${p.code})` })),
                // A code saved earlier that this token can't see stays selectable.
                ...(draft.code && !available.some((p) => p.code === draft.code)
                  ? [{ value: draft.code, label: draft.code }]
                  : []),
              ]}
            />
          ) : (
            <TextField
              value={draft.code}
              placeholder={missing[0] ?? "MC"}
              onChange={(e) => setDraft({ ...draft, code: e.target.value.trim().toUpperCase() })}
            />
          )}
        </label>
        {loading ? <p className={styles.muted}>Loading projects…</p> : null}
        {availableError ? (
          <p className={styles.muted}>{availableError} Enter the project code by hand.</p>
        ) : null}
        {!canList ? (
          <p className={styles.muted}>Paste a token to pick from your Qase projects.</p>
        ) : null}

        <label className={styles.field}>
          <span className={styles.fieldLabel}>Matrix columns come from</span>
          <Select
            value={draft.matrixField ?? "suite"}
            onChange={(e) => setDraft({ ...draft, matrixField: e.target.value })}
            options={[...new Set(["suite", ...fields])].map((f) => ({ value: f, label: f }))}
          />
        </label>

        <p className={styles.muted}>
          {draft.fetchedAt
            ? `Cases last fetched ${new Date(draft.fetchedAt).toLocaleString()}.`
            : "Cases not fetched yet."}{" "}
          Qase owns them; Studio only caches them to show alongside the flows. A flow says which
          case it verifies in its own header, as <code>properties.testCaseId</code>.
        </p>

        <div className={styles.verdictRow}>
          <Button size="sm" disabled={busy} onClick={() => void save()}>
            {busy ? "Saving…" : isNew ? "Add project" : "Save"}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void test()}>
            Test connection
          </Button>
          {!isNew ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void remove()}>
              Remove
            </Button>
          ) : null}
        </div>
      </div>
    </aside>
  );
}
