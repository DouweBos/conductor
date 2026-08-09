import { useState } from "react";

import { Icon } from "../../icons/Icons";
import styles from "./ToolCallCard.module.css";

export type ToolCallState = "pending" | "done" | "error";

export interface ToolCallCardProps {
  name: string;
  summary?: string;
  detail?: string;
  state?: ToolCallState;
}

export function ToolCallCard({ name, summary, detail, state = "done" }: ToolCallCardProps) {
  const [open, setOpen] = useState(false);
  return (
    <div className={styles.card}>
      <button
        type="button"
        className={styles.header}
        onClick={() => setOpen((o) => !o)}
        disabled={!detail}
      >
        <Icon name={detail ? (open ? "chevronDown" : "chevronRight") : "code"} size={12} />
        <span className={[styles.dot, styles[state]].join(" ")} />
        <span className={styles.name}>{name}</span>
        {summary ? <span className={styles.summary}>{summary}</span> : null}
      </button>
      {open && detail ? <pre className={styles.detail}>{detail}</pre> : null}
    </div>
  );
}
