import { type ReactNode, useEffect } from "react";

import { IconButton } from "../IconButton/IconButton";
import styles from "./Dialog.module.css";

export interface DialogProps {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}

export function Dialog({ open, title, onClose, children, footer, width = 480 }: DialogProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className={styles.scrim} onClick={onClose} role="presentation">
      <div
        className={styles.dialog}
        style={{ width }}
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <header className={styles.header}>
          <h2 className={styles.title}>{title}</h2>
          <IconButton icon="close" label="Close" onClick={onClose} />
        </header>
        <div className={styles.body}>{children}</div>
        {footer ? <footer className={styles.footer}>{footer}</footer> : null}
      </div>
    </div>
  );
}
