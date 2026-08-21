import { Button, Dialog, Select, StatusPill, TextField } from "@conductor/studio-ui";
import { useState } from "react";

import { importCases, pickCaseCsv, previewCaseImport } from "../../lib/ipc";
import type { CasePreview } from "../../lib/types";
import styles from "./CasesView.module.css";

const FIELDS = [
  { value: "", label: "— ignore —" },
  { value: "id", label: "id" },
  { value: "title", label: "title" },
  { value: "userStory", label: "business rule" },
  { value: "description", label: "steps" },
  { value: "owner", label: "owner" },
  { value: "state", label: "state" },
  { value: "links", label: "links" },
  { value: "flow", label: "flow" },
  { value: "altIds", label: "alternate ids" },
];

interface ImportDialogProps {
  onClose: () => void;
  onImported: (created: number, updated: number) => void;
}

/** CSV in: pick a file, confirm what each column means, write the case files. */
export function ImportDialog({ onClose, onImported }: ImportDialogProps) {
  const [file, setFile] = useState<string | null>(null);
  const [preview, setPreview] = useState<CasePreview | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [stampField, setStampField] = useState("Platform");
  const [stampValue, setStampValue] = useState("");
  const [overwrite, setOverwrite] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const choose = async () => {
    try {
      const picked = await pickCaseCsv();
      if (!picked) return;
      setFile(picked);
      const p = await previewCaseImport(picked);
      setPreview(p);
      setMapping(p.mapping);
    } catch (e) {
      setError(String(e));
    }
  };

  const doImport = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const result = await importCases({
        file,
        mapping,
        stamp: stampValue.trim() ? { [stampField.trim()]: stampValue.trim() } : undefined,
        overwrite,
      });
      onImported(result.created, result.updated);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open title="Import test cases" onClose={onClose}>
      <div className={styles.importBody}>
        {error ? <StatusPill tone="error">{error}</StatusPill> : null}
        <div className={styles.verdictRow}>
          <Button size="sm" variant="secondary" icon="folder" onClick={() => void choose()}>
            {file ? "Choose another CSV" : "Choose CSV…"}
          </Button>
          {file ? <span className={styles.muted}>{file}</span> : null}
        </div>

        {preview ? (
          <>
            <p className={styles.muted}>
              Unrecognised columns become custom fields, so a Platform column turns into a
              filterable field the matrix can key on. {preview.rows.length} rows previewed.
            </p>
            <div className={styles.mapGrid}>
              {preview.headers.map((header) => (
                <div key={header} className={styles.mapRow}>
                  <span className={styles.mapHeader}>{header}</span>
                  <Select
                    value={
                      FIELDS.some((f) => f.value === mapping[header]) ? mapping[header] : "__field"
                    }
                    onChange={(e) =>
                      setMapping((m) => ({
                        ...m,
                        [header]: e.target.value === "__field" ? `field:${header}` : e.target.value,
                      }))
                    }
                    options={[...FIELDS, { value: "__field", label: `custom field: ${header}` }]}
                  />
                  <span className={styles.mapSample}>{preview.rows[0]?.[preview.headers.indexOf(header)] ?? ""}</span>
                </div>
              ))}
            </div>
            <div className={styles.verdictRow}>
              <TextField
                label="Stamp every case with"
                value={stampField}
                onChange={(e) => setStampField(e.target.value)}
              />
              <TextField
                label="value"
                placeholder="e.g. tv"
                value={stampValue}
                onChange={(e) => setStampValue(e.target.value)}
              />
              <label className={styles.checkbox}>
                <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
                Overwrite existing ids
              </label>
            </div>
          </>
        ) : null}

        <div className={styles.verdictRow}>
          <Button size="sm" disabled={!preview || busy} onClick={() => void doImport()}>
            {busy ? "Importing…" : "Import"}
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
