import { useEffect, useRef } from "react";

import styles from "./LogView.module.css";

export type LogTone = "default" | "muted" | "success" | "error" | "warning" | "command";

export interface LogLine {
  id: string;
  text: string;
  tone?: LogTone;
}

export interface LogViewProps {
  lines: LogLine[];
  /** Auto-scroll to the newest line as it arrives. */
  follow?: boolean;
  emptyLabel?: string;
}

export function LogView({ lines, follow = true, emptyLabel = "No output yet." }: LogViewProps) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (follow) endRef.current?.scrollIntoView({ block: "end" });
  }, [lines, follow]);

  // Keep the empty label inside the log surface so it sits on the same
  // baseline and grid as the output it stands in for.
  if (lines.length === 0) {
    return (
      <div className={styles.log}>
        <div className={styles.empty}>{emptyLabel}</div>
      </div>
    );
  }

  return (
    <div className={styles.log}>
      {lines.map((line) => (
        <div key={line.id} className={[styles.line, styles[line.tone ?? "default"]].join(" ")}>
          {line.text || " "}
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}
