import type { ReactNode } from "react";

import styles from "./StatusPill.module.css";

export type StatusTone = "neutral" | "success" | "warning" | "error" | "info" | "running";

export interface StatusPillProps {
  tone?: StatusTone;
  children: ReactNode;
  pulse?: boolean;
}

export function StatusPill({ tone = "neutral", children, pulse }: StatusPillProps) {
  return (
    <span className={[styles.pill, styles[tone]].join(" ")}>
      <span className={[styles.dot, pulse && styles.pulse].filter(Boolean).join(" ")} />
      {children}
    </span>
  );
}
