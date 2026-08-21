import type { ReactNode } from "react";

import { Icon } from "../../icons/Icons";
import styles from "./Matrix.module.css";

export interface MatrixColumn {
  id: string;
  label: ReactNode;
  /** Fixed width in px. Status columns want to stay narrow and equal. */
  width?: number;
}

export interface MatrixRow {
  id: string;
  label: ReactNode;
  sublabel?: ReactNode;
  cells: Record<string, ReactNode>;
}

/** A collapsible band of rows — a suite, an area, a priority. */
export interface MatrixGroup {
  id: string;
  label: ReactNode;
  /** Summary shown on the right of the group header, e.g. counts. */
  meta?: ReactNode;
  collapsed?: boolean;
  rows: MatrixRow[];
}

export interface MatrixProps {
  columns: MatrixColumn[];
  /** Flat rows. Ignored when `groups` is given. */
  rows?: MatrixRow[];
  groups?: MatrixGroup[];
  rowHeader?: ReactNode;
  onRowClick?: (id: string) => void;
  onToggleGroup?: (id: string) => void;
}

export function Matrix({
  columns,
  rows,
  groups,
  rowHeader = "User story",
  onRowClick,
  onToggleGroup,
}: MatrixProps) {
  const body = (list: MatrixRow[]) =>
    list.map((row) => (
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
    ));

  return (
    <div className={styles.scroll}>
      <table className={styles.matrix}>
        <colgroup>
          <col />
          {columns.map((col) => (
            <col key={col.id} style={col.width ? { width: col.width } : undefined} />
          ))}
        </colgroup>
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
        {groups ? (
          groups.map((group) => (
            <tbody key={group.id}>
              <tr className={styles.groupRow} onClick={() => onToggleGroup?.(group.id)}>
                <th className={styles.groupHead} colSpan={columns.length + 1}>
                  <Icon name={group.collapsed ? "chevronRight" : "chevronDown"} size={13} />
                  <span className={styles.groupLabel}>{group.label}</span>
                  <span className={styles.groupCount}>{group.rows.length}</span>
                  {group.meta ? <span className={styles.groupMeta}>{group.meta}</span> : null}
                </th>
              </tr>
              {group.collapsed ? null : body(group.rows)}
            </tbody>
          ))
        ) : (
          <tbody>{body(rows ?? [])}</tbody>
        )}
      </table>
    </div>
  );
}
