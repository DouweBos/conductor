import type { ReactNode } from "react";

import { Icon } from "../../icons/Icons";
import styles from "./ChatMessage.module.css";

export interface ChatMessageProps {
  role: "assistant" | "user";
  children: ReactNode;
}

export function ChatMessage({ role, children }: ChatMessageProps) {
  return (
    <div className={[styles.row, styles[role]].join(" ")}>
      <div className={styles.avatar}>
        <Icon name={role === "assistant" ? "agent" : "dot"} size={14} />
      </div>
      <div className={styles.bubble}>{children}</div>
    </div>
  );
}
