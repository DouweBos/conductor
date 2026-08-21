import type { ReactNode } from "react";

import styles from "./Panel.module.css";

export interface PanelProps {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Removes internal body padding (e.g. for editors / file trees). */
  flush?: boolean;
}

export function Panel({ title, actions, children, className, flush }: PanelProps) {
  const cls = [styles.panel, className].filter(Boolean).join(" ");
  return (
    <section className={cls}>
      {(title || actions) && (
        <header className={styles.header}>
          <div className={styles.title}>{title}</div>
          {actions ? <div className={styles.actions}>{actions}</div> : null}
        </header>
      )}
      <div className={flush ? styles.bodyFlush : styles.body}>{children}</div>
    </section>
  );
}
