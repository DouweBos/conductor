import {
  Button,
  EmptyState,
  Matrix,
  Select,
  StatusPill,
  type MatrixRow,
  type StatusTone,
} from "@conductor/studio-ui";
import { useEffect, useMemo, useState } from "react";

import { casesMatrix, syncCasesCi } from "../../lib/ipc";
import type { CaseMatrix, FlowRunStatus } from "../../lib/types";
import styles from "./CasesView.module.css";

const DIMENSIONS = ["platform", "vertical", "product"];

const CI_TONE: Record<FlowRunStatus, StatusTone> = {
  running: "running",
  passed: "success",
  failed: "error",
  cancelled: "warning",
  error: "error",
};

export function CasesView() {
  const [dimension, setDimension] = useState("platform");
  const [matrix, setMatrix] = useState<CaseMatrix | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  const sync = async () => {
    setSyncing(true);
    try {
      setMatrix(await syncCasesCi(dimension));
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setSyncing(false);
    }
  };

  useEffect(() => {
    casesMatrix(dimension)
      .then((m) => {
        setMatrix(m);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }, [dimension]);

  const rows: MatrixRow[] = useMemo(() => {
    if (!matrix) return [];
    return matrix.cases.map((c) => {
      const values = c.tags[matrix.dimension] ?? [];
      const cells: Record<string, React.ReactNode> = {};
      for (const col of matrix.columns) {
        if (values.includes(col)) {
          const tone = c.ciStatus ? CI_TONE[c.ciStatus] : "neutral";
          cells[col] = <StatusPill tone={tone}>{c.ciStatus ?? "not run"}</StatusPill>;
        }
      }
      return {
        id: c.id,
        label: c.title,
        sublabel: c.flow ?? c.id,
        cells,
      };
    });
  }, [matrix]);

  const columns = useMemo(
    () => (matrix?.columns ?? []).map((c) => ({ id: c, label: c })),
    [matrix],
  );

  return (
    <div className={styles.view}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Test cases</h1>
          <p className={styles.subtitle}>
            User stories mapped to Maestro flows, tagged by vertical, platform, and product.
            CI status syncs from GitHub Actions.
          </p>
        </div>
        <div className={styles.controls}>
          <span className={styles.controlLabel}>Columns:</span>
          <Select
            options={DIMENSIONS.map((d) => ({ value: d, label: d }))}
            value={dimension}
            onChange={(e) => setDimension(e.target.value)}
          />
          <Button size="sm" variant="secondary" icon="refresh" disabled={syncing} onClick={() => void sync()}>
            {syncing ? "Syncing…" : "Sync CI"}
          </Button>
        </div>
      </header>

      {matrix?.ci ? (
        <div className={styles.ci}>
          <StatusPill tone={matrix.ci.matched ? "info" : "warning"}>
            {matrix.ci.matched}/{matrix.ci.total} cases matched
          </StatusPill>
          <span>
            {matrix.ci.runName ?? "latest run"}
            {matrix.ci.branch ? ` · ${matrix.ci.branch}` : ""}
            {matrix.ci.repo ? ` · ${matrix.ci.repo}` : ""}
          </span>
          {matrix.ci.fallbackToRunStatus ? (
            <span className={styles.ciNote}>
              No job detail — showing the whole run's result for every case.
            </span>
          ) : null}
        </div>
      ) : null}

      <div className={styles.matrix}>
        {error ? (
          <EmptyState icon="alert" title="Couldn't load cases" description={error} />
        ) : !matrix || matrix.cases.length === 0 ? (
          <EmptyState
            icon="matrix"
            title="No test cases yet"
            description="Add YAML case files under test-cases/ in your repo. Each case links a user story to the Maestro flow that implements it."
          />
        ) : (
          <Matrix columns={columns} rows={rows} rowHeader="User story" />
        )}
      </div>
    </div>
  );
}
