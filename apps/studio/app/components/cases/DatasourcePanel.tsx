import { Button, IconButton, Select, StatusPill, TextField } from "@conductor/studio-ui";
import { useEffect, useMemo, useState } from "react";

import {
  activateCaseProject,
  caseProjects as fetchCaseProjects,
  deleteCaseProject,
  listQaseProjects,
  listTags,
  saveCaseProject,
  testCasesDatasource,
} from "../../lib/ipc";
import type { CaseProject, CasesDatasource } from "../../lib/types";
import { ALL_PROJECTS } from "../../lib/types";
import { useDevices } from "../../stores/deviceStore";
import styles from "./CasesView.module.css";

interface DatasourcePanelProps {
  onClose: () => void;
  onChanged: () => void;
  /** Custom fields the pulled cases actually carry, for the column picker. */
  fields: string[];
}

const NEW_PROJECT = "__new__";

function blankProject(): CaseProject {
  return { id: "", name: "", datasource: { mode: "local", projectCode: "" } };
}

/** `Mobile` -> `mobile`, so a sub-project's directory is readable on disk. */
function idFrom(name: string, taken: string[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 32) || "project";
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}

/**
 * The sub-projects a repo's cases are split across — a monorepo holds a mobile
 * app and a tv app, each mirroring its own Qase project, with its own cases,
 * plans, results and flow tag.
 *
 * A token never lands in the settings file in the clear — it goes through
 * Electron's safeStorage — and `QASE_API_TOKEN` overrides all of them.
 */
export function DatasourcePanel({ onClose, onChanged, fields }: DatasourcePanelProps) {
  const [projects, setProjects] = useState<CaseProject[] | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<CaseProject | null>(null);
  const [token, setToken] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [qaseProjects, setQaseProjects] = useState<{ code: string; title: string }[] | null>(null);
  const [qaseError, setQaseError] = useState<string | null>(null);
  const [loadingQase, setLoadingQase] = useState(false);
  const [tags, setTags] = useState<string[]>([]);
  const devices = useDevices();

  useEffect(() => {
    fetchCaseProjects()
      .then(({ projects: list, active }) => {
        setProjects(list);
        const start = active === ALL_PROJECTS ? list[0]?.id : active;
        setEditingId(start ?? NEW_PROJECT);
        setDraft(list.find((p) => p.id === start) ?? blankProject());
      })
      .catch((e) => setError(String(e)));
    listTags()
      .then((known) => setTags(known.map((t) => t.tag)))
      .catch(() => setTags([]));
  }, []);

  const typedToken = token.trim();
  const isNew = editingId === NEW_PROJECT;
  const canListQase = draft?.datasource.mode === "qase" &&
    (typedToken.length > 0 || Boolean(draft.datasource.hasToken));

  // As soon as a token exists — typed here or already stored — the project code
  // becomes a picker instead of something to look up in Qase and retype.
  useEffect(() => {
    if (!canListQase) {
      setQaseProjects(null);
      setQaseError(null);
      return;
    }
    let cancelled = false;
    setLoadingQase(true);
    // Debounced so pasting a token doesn't fire a request per keystroke.
    const timer = setTimeout(() => {
      listQaseProjects(typedToken || undefined, isNew ? undefined : (editingId ?? undefined))
        .then((result) => {
          if (cancelled) return;
          setQaseProjects(result.ok ? (result.projects ?? []) : null);
          setQaseError(result.ok ? null : (result.error ?? "Could not reach Qase."));
        })
        .catch((e) => {
          if (cancelled) return;
          setQaseProjects(null);
          setQaseError(String(e));
        })
        .finally(() => {
          if (!cancelled) setLoadingQase(false);
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [canListQase, typedToken, editingId, isNew]);

  const deviceOptions = useMemo(
    () => [
      { value: "", label: "whichever suits the flow" },
      ...devices.map((d) => ({ value: d.id, label: `${d.name} (${d.platform})` })),
    ],
    [devices],
  );

  if (!projects || !draft) {
    return (
      <aside className={styles.detail}>
        <header className={styles.detailHeader}>
          <h2 className={styles.detailTitle}>Projects</h2>
          <IconButton icon="close" label="Close" onClick={onClose} />
        </header>
        <div className={styles.detailBody}>
          {error ? <StatusPill tone="error">{error}</StatusPill> : <p className={styles.muted}>Loading…</p>}
        </div>
      </aside>
    );
  }

  const edit = (patch: Partial<CaseProject>) => setDraft({ ...draft, ...patch });
  const editSource = (patch: Partial<CasesDatasource>) =>
    setDraft({ ...draft, datasource: { ...draft.datasource, ...patch } });

  const pick = (id: string) => {
    setEditingId(id);
    setDraft(id === NEW_PROJECT ? blankProject() : (projects.find((p) => p.id === id) ?? blankProject()));
    setToken("");
    setStatus(null);
    setError(null);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      if (!draft.name.trim()) throw new Error("A project needs a name.");
      const id = draft.id || idFrom(draft.name, projects.map((p) => p.id));
      const saved = { ...draft, id, name: draft.name.trim() };
      // An empty box means "leave the stored token alone", not "clear it" —
      // the field is never populated with the real value to begin with.
      const next = await saveCaseProject(saved, typedToken || undefined);
      setProjects(next);
      setEditingId(id);
      setDraft(next.find((p) => p.id === id) ?? saved);
      setToken("");
      setStatus("Saved.");
      // A brand new project is what the user wants to be looking at.
      if (isNew) await activateCaseProject(id);
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (isNew) return pick(projects[0]?.id ?? NEW_PROJECT);
    setBusy(true);
    setError(null);
    try {
      const next = await deleteCaseProject(draft.id);
      setProjects(next);
      pick(next[0]?.id ?? NEW_PROJECT);
      setStatus("Project removed. Its cases are still on disk.");
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
    const result = await testCasesDatasource(
      typedToken || undefined,
      draft.datasource.projectCode,
      isNew ? undefined : draft.id,
    );
    setBusy(false);
    if (result.ok) setStatus(`Connected to "${result.project}".`);
    else setError(result.error ?? "Could not reach Qase.");
  };

  return (
    <aside className={styles.detail}>
      <header className={styles.detailHeader}>
        <h2 className={styles.detailTitle}>Projects</h2>
        <IconButton icon="close" label="Close" onClick={onClose} />
      </header>
      <div className={styles.detailBody}>
        {error ? <StatusPill tone="error">{error}</StatusPill> : null}
        {status ? <StatusPill tone="success">{status}</StatusPill> : null}

        <label className={styles.field}>
          <span className={styles.fieldLabel}>Editing</span>
          <Select
            value={editingId ?? NEW_PROJECT}
            onChange={(e) => pick(e.target.value)}
            options={[
              ...projects.map((p) => ({ value: p.id, label: p.name })),
              { value: NEW_PROJECT, label: "＋ New project…" },
            ]}
          />
        </label>

        <label className={styles.field}>
          <span className={styles.fieldLabel}>Name</span>
          <TextField
            value={draft.name}
            placeholder="Mobile"
            onChange={(e) => edit({ name: e.target.value })}
          />
        </label>

        <label className={styles.field}>
          <span className={styles.fieldLabel}>Cases come from</span>
          <Select
            value={draft.datasource.mode}
            onChange={(e) => editSource({ mode: e.target.value as CasesDatasource["mode"] })}
            options={[
              { value: "local", label: "this machine" },
              { value: "qase", label: "Qase" },
            ]}
          />
        </label>

        {draft.datasource.mode === "qase" ? (
          <>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>
                API token {draft.datasource.hasToken ? "(one is stored — type to replace it)" : ""}
              </span>
              <TextField
                type="password"
                value={token}
                placeholder={draft.datasource.hasToken ? "••••••••" : "Paste your Qase API token"}
                onChange={(e) => setToken(e.target.value)}
              />
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Qase project</span>
              {qaseProjects?.length ? (
                <Select
                  value={draft.datasource.projectCode}
                  onChange={(e) => editSource({ projectCode: e.target.value })}
                  options={[
                    ...(draft.datasource.projectCode
                      ? []
                      : [{ value: "", label: "Choose a project…" }]),
                    ...qaseProjects.map((p) => ({
                      value: p.code,
                      label: `${p.title} (${p.code})`,
                    })),
                    // A code saved earlier that this token can't see stays selectable.
                    ...(draft.datasource.projectCode &&
                    !qaseProjects.some((p) => p.code === draft.datasource.projectCode)
                      ? [{ value: draft.datasource.projectCode, label: draft.datasource.projectCode }]
                      : []),
                  ]}
                />
              ) : (
                <TextField
                  value={draft.datasource.projectCode}
                  placeholder="DEMO"
                  onChange={(e) => editSource({ projectCode: e.target.value.trim() })}
                />
              )}
            </label>
            {loadingQase ? <p className={styles.muted}>Loading projects…</p> : null}
            {qaseError ? (
              <p className={styles.muted}>{qaseError} Enter the project code by hand.</p>
            ) : null}
            {!canListQase ? (
              <p className={styles.muted}>Paste a token to pick from your Qase projects.</p>
            ) : null}

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Suites to pull — ids, comma separated (all if empty)</span>
              <TextField
                value={(draft.datasource.qase?.suiteIds ?? []).join(", ")}
                placeholder="12, 15"
                onChange={(e) =>
                  editSource({
                    qase: {
                      ...draft.datasource.qase,
                      suiteIds: e.target.value
                        .split(",")
                        .map((v) => Number(v.trim()))
                        .filter((v) => Number.isFinite(v) && v > 0),
                    },
                  })
                }
              />
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Matrix columns come from</span>
              <Select
                value={draft.datasource.qase?.matrixField ?? "suite"}
                onChange={(e) =>
                  editSource({ qase: { ...draft.datasource.qase, matrixField: e.target.value } })
                }
                options={[...new Set(["suite", ...fields])].map((f) => ({ value: f, label: f }))}
              />
            </label>
          </>
        ) : (
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Case id prefix</span>
            <TextField
              value={draft.datasource.projectCode}
              placeholder="TC"
              onChange={(e) => editSource({ projectCode: e.target.value.trim() })}
            />
          </label>
        )}

        <label className={styles.field}>
          <span className={styles.fieldLabel}>Maestro tag for this project's flows</span>
          <TextField
            value={draft.flowTag ?? ""}
            placeholder="tv"
            list="case-project-tags"
            onChange={(e) => edit({ flowTag: e.target.value.trim() || undefined })}
          />
          <datalist id="case-project-tags">
            {tags.map((tag) => (
              <option key={tag} value={tag} />
            ))}
          </datalist>
        </label>

        <label className={styles.field}>
          <span className={styles.fieldLabel}>Runs start on</span>
          <Select
            value={draft.defaultDeviceId ?? ""}
            onChange={(e) => edit({ defaultDeviceId: e.target.value || undefined })}
            options={
              draft.defaultDeviceId && !devices.some((d) => d.id === draft.defaultDeviceId)
                ? [...deviceOptions, { value: draft.defaultDeviceId, label: `${draft.defaultDeviceId} (offline)` }]
                : deviceOptions
            }
          />
        </label>

        <p className={styles.muted}>
          {draft.datasource.mode === "qase" ? (
            <>
              {draft.datasource.qase?.lastPulledAt
                ? `Last synced ${new Date(draft.datasource.qase.lastPulledAt).toLocaleString()}.`
                : "Never synced."}{" "}
              Qase owns case content; syncing overwrites it here. Flow links and page-object
              assignments are kept.
            </>
          ) : (
            <>
              Cases live only on this machine, under <code>~/.conductor/studio/&lt;project&gt;/cases/</code>, and
              are fully editable in Studio.
            </>
          )}
        </p>

        <div className={styles.verdictRow}>
          <Button size="sm" disabled={busy} onClick={() => void save()}>
            {busy ? "Saving…" : isNew ? "Add project" : "Save"}
          </Button>
          {draft.datasource.mode === "qase" ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void test()}>
              Test connection
            </Button>
          ) : null}
          {!isNew && projects.length > 1 ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void remove()}>
              Remove
            </Button>
          ) : null}
        </div>
      </div>
    </aside>
  );
}
