import type { ReactNode } from "react";

import styles from "./Toolbar.module.css";

export interface ToolbarProps {
  children: ReactNode;
  className?: string;
}

export function Toolbar({ children, className }: ToolbarProps) {
  return (
    <div className={[styles.toolbar, className].filter(Boolean).join(" ")}>
      {children}
    </div>
  );
}

export function ToolbarSpacer() {
  return <div className={styles.spacer} />;
}

export function ToolbarDivider() {
  return <div className={styles.divider} />;
}
