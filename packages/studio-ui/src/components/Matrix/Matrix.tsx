import type { ReactNode } from "react";

import styles from "./Matrix.module.css";

export interface MatrixColumn {
  id: string;
  label: ReactNode;
}

export interface MatrixRow {
  id: string;
  label: ReactNode;
  sublabel?: ReactNode;
  cells: Record<string, ReactNode>;
}

export interface MatrixProps {
  columns: MatrixColumn[];
  rows: MatrixRow[];
  rowHeader?: ReactNode;
  onRowClick?: (id: string) => void;
}

export function Matrix({ columns, rows, rowHeader = "User story", onRowClick }: MatrixProps) {
  return (
    <div className={styles.scroll}>
      <table className={styles.matrix}>
        <thead>
          <tr>
            <th className={styles.corner}>{rowHeader}</th>
            {columns.map((col) => (
              <th key={col.id} className={styles.colHead}>
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              className={onRowClick ? styles.clickable : undefined}
              onClick={() => onRowClick?.(row.id)}
            >
              <th className={styles.rowHead}>
                <span className={styles.rowLabel}>{row.label}</span>
                {row.sublabel ? <span className={styles.rowSub}>{row.sublabel}</span> : null}
              </th>
              {columns.map((col) => (
                <td key={col.id} className={styles.cell}>
                  {row.cells[col.id] ?? <span className={styles.blank}>—</span>}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
