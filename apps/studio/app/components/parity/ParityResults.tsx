import { EmptyState, Matrix, Panel, Tag, type MatrixColumn, type MatrixRow } from "@conductor/studio-ui";

import type { ParityMatrix, ParitySharedFinding } from "../../lib/types";
import styles from "./ParityResults.module.css";

/**
 * The checkpoint × target grid, and what the targets agree on.
 *
 * The agreement is the part worth reading first, and it is the one thing N
 * targets can tell you that N separate two-way runs cannot: a finding on one
 * target is that target's bug, while a finding on *every* target is a statement
 * about the reference. Four independent rebuilds rarely drop the same control,
 * so when they all report it the reference run is the likelier suspect — stale,
 * behind a flag, or in a different experiment bucket.
 */

function cell(status: "pass" | "fail" | "absent", blocking: number, advisory: number) {
  const mark = status === "pass" ? "✓" : status === "fail" ? "✗" : "–";
  const count = blocking > 0 ? blocking : advisory > 0 ? advisory : 0;
  return (
    <span className={[styles.cell, styles[status]].join(" ")}>
      <span className={styles.mark}>{mark}</span>
      {count > 0 ? (
        <span className={blocking > 0 ? styles.countBlocking : styles.count}>{count}</span>
      ) : null}
    </span>
  );
}

function FindingRow({ finding }: { finding: ParitySharedFinding }) {
  return (
    <li className={[styles.finding, finding.severity === "blocking" && styles.blocking]
      .filter(Boolean)
      .join(" ")}>
      <span className={styles.kind}>{finding.kind}</span>
      <span className={styles.detail}>
        <strong>{finding.checkpoint}</strong> — {finding.detail}
        <span className={styles.chips}>
          {finding.targets.map((t) => (
            <Tag key={t}>{t}</Tag>
          ))}
        </span>
      </span>
    </li>
  );
}

export function ParityResults({ matrix }: { matrix: ParityMatrix | null }) {
  if (!matrix) {
    return (
      <Panel title="Results">
        <EmptyState
          icon="matrix"
          title="No comparison yet"
          description="Pick a flow, choose the device running the reference build, add the builds to compare against, and run. Every target walks the same journey at once."
        />
      </Panel>
    );
  }

  const columns: MatrixColumn[] = matrix.targets.map((t) => ({
    id: t.label,
    label: (
      <span className={styles.colHead}>
        <span className={styles.colLabel}>{t.label}</span>
        <span className={styles.colPlatform}>{t.platform}</span>
      </span>
    ),
    width: 96,
  }));

  const rows: MatrixRow[] = matrix.rows.map((row) => ({
    id: row.checkpoint,
    label: row.checkpoint,
    cells: Object.fromEntries(
      row.cells.map((c) => [c.target, cell(c.status, c.blocking, c.advisory)]),
    ),
  }));

  const universal = matrix.shared.filter((f) => f.universal);
  const perTarget = matrix.shared.filter((f) => !f.universal);

  return (
    <div className={styles.results}>
      <Panel
        title="Parity matrix"
        actions={
          <span className={styles.summary}>
            {matrix.summary.targetsPassed}/{matrix.summary.targets} at parity ·{" "}
            {matrix.summary.blocking} blocking
          </span>
        }
      >
        <Matrix columns={columns} rows={rows} rowHeader="Checkpoint" />
      </Panel>

      {universal.length > 0 ? (
        <Panel title={`Reported by every target · ${universal.length}`}>
          <p className={styles.note}>
            Every one of the {matrix.summary.targets} targets reports these. Independent rebuilds
            rarely diverge the same way — look at the reference run first: it may be stale, behind a
            feature flag, or in a different experiment bucket. One fix there clears the finding from
            every column at once.
          </p>
          <ul className={styles.findings}>
            {universal.map((f) => (
              <FindingRow key={f.signature} finding={f} />
            ))}
          </ul>
        </Panel>
      ) : null}

      {perTarget.length > 0 ? (
        <Panel title={`Per-target findings · ${perTarget.length}`}>
          <ul className={styles.findings}>
            {perTarget.map((f) => (
              <FindingRow key={f.signature} finding={f} />
            ))}
          </ul>
        </Panel>
      ) : null}

      {matrix.shared.length === 0 ? (
        <Panel title="Findings">
          <EmptyState
            icon="check"
            title="Every target matches the reference"
            description={`${matrix.summary.checkpoints} checkpoint(s) compared across ${matrix.summary.targets} target(s) with nothing to report.`}
          />
        </Panel>
      ) : null}
    </div>
  );
}
