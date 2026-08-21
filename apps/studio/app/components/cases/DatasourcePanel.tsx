import { Button, IconButton, Select, StatusPill, TextField } from "@conductor/studio-ui";
import { useEffect, useState } from "react";

import { casesDatasource, saveCasesDatasource, testCasesDatasource } from "../../lib/ipc";
import type { CasesDatasource } from "../../lib/types";
import styles from "./CasesView.module.css";

interface DatasourcePanelProps {
  onClose: () => void;
  onChanged: () => void;
  /** Custom fields the pulled cases actually carry, for the column picker. */
  fields: string[];
}

/**
 * Where this project's cases come from. Local means Studio owns them; Qase
 * means Qase does, and Studio mirrors them down on every sync.
 *
 * The token never lands in the settings file in the clear — it goes through
 * Electron's safeStorage — and `QASE_API_TOKEN` overrides it for development.
 */
export function DatasourcePanel({ onClose, onChanged, fields }: DatasourcePanelProps) {
  const [source, setSource] = useState<CasesDatasource | null>(null);
  const [token, setToken] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    casesDatasource().then(setSource).catch((e) => setError(String(e)));
  }, []);

  if (!source) {
    return (
      <aside className={styles.detail}>
        <header className={styles.detailHeader}>
          <h2 className={styles.detailTitle}>Datasource</h2>
          <IconButton icon="close" label="Close" onClick={onClose} />
        </header>
        <div className={styles.detailBody}>
          {error ? <StatusPill tone="error">{error}</StatusPill> : <p className={styles.muted}>Loading…</p>}
        </div>
      </aside>
    );
  }

  const set = <K extends keyof CasesDatasource>(key: K, value: CasesDatasource[K]) =>
    setSource((s) => (s ? { ...s, [key]: value } : s));

  const save = async () => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      // An empty box means "leave the stored token alone", not "clear it" —
      // the field is never populated with the real value to begin with.
      setSource(await saveCasesDatasource(source, token.trim() || undefined));
      setToken("");
      setStatus("Saved.");
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
    const result = await testCasesDatasource();
    setBusy(false);
    if (result.ok) setStatus(`Connected to "${result.project}".`);
    else setError(result.error ?? "Could not reach Qase.");
  };

  return (
    <aside className={styles.detail}>
      <header className={styles.detailHeader}>
        <h2 className={styles.detailTitle}>Datasource</h2>
        <IconButton icon="close" label="Close" onClick={onClose} />
      </header>
      <div className={styles.detailBody}>
        {error ? <StatusPill tone="error">{error}</StatusPill> : null}
        {status ? <StatusPill tone="success">{status}</StatusPill> : null}

        <label className={styles.field}>
          <span className={styles.fieldLabel}>Cases come from</span>
          <Select
            value={source.mode}
            onChange={(e) => set("mode", e.target.value as CasesDatasource["mode"])}
            options={[
              { value: "local", label: "this machine" },
              { value: "qase", label: "Qase" },
            ]}
          />
        </label>

        <label className={styles.field}>
          <span className={styles.fieldLabel}>
            {source.mode === "qase" ? "Qase project code" : "Case id prefix"}
          </span>
          <TextField
            value={source.projectCode}
            placeholder="DEMO"
            onChange={(e) => set("projectCode", e.target.value.trim())}
          />
        </label>

        {source.mode === "qase" ? (
          <>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>
                API token {source.hasToken ? "(one is stored — type to replace it)" : ""}
              </span>
              <TextField
                type="password"
                value={token}
                placeholder={source.hasToken ? "••••••••" : "Paste your Qase API token"}
                onChange={(e) => setToken(e.target.value)}
              />
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Suites to pull — ids, comma separated (all if empty)</span>
              <TextField
                value={(source.qase?.suiteIds ?? []).join(", ")}
                placeholder="12, 15"
                onChange={(e) =>
                  set("qase", {
                    ...source.qase,
                    suiteIds: e.target.value
                      .split(",")
                      .map((v) => Number(v.trim()))
                      .filter((v) => Number.isFinite(v) && v > 0),
                  })
                }
              />
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Matrix columns come from</span>
              <Select
                value={source.qase?.matrixField ?? "suite"}
                onChange={(e) => set("qase", { ...source.qase, matrixField: e.target.value })}
                options={[...new Set(["suite", ...fields])].map((f) => ({ value: f, label: f }))}
              />
            </label>

            <p className={styles.muted}>
              {source.qase?.lastPulledAt
                ? `Last synced ${new Date(source.qase.lastPulledAt).toLocaleString()}.`
                : "Never synced."}{" "}
              Qase owns case content; syncing overwrites it here. Flow links and page-object
              assignments are kept.
            </p>
          </>
        ) : (
          <p className={styles.muted}>
            Cases live only on this machine, under <code>~/.conductor/studio/cases/</code>, and are
            fully editable in Studio.
          </p>
        )}

        <div className={styles.verdictRow}>
          <Button size="sm" disabled={busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </Button>
          {source.mode === "qase" ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void test()}>
              Test connection
            </Button>
          ) : null}
        </div>
      </div>
    </aside>
  );
}
