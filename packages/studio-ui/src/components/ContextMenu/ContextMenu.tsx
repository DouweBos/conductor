import { useEffect } from "react";

import { Icon, type IconName } from "../../icons/Icons";
import styles from "./ContextMenu.module.css";

export interface ContextMenuItem {
  label: string;
  icon?: IconName;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}

export interface ContextMenuProps {
  open: boolean;
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export function ContextMenu({ open, x, y, items, onClose }: ContextMenuProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className={styles.scrim} onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }}>
      <div
        className={styles.menu}
        style={{ left: x, top: y }}
        onClick={(e) => e.stopPropagation()}
        role="menu"
      >
        {items.map((item, i) => (
          <button
            key={i}
            type="button"
            role="menuitem"
            className={[styles.item, item.danger && styles.danger].filter(Boolean).join(" ")}
            disabled={item.disabled}
            onClick={() => {
              item.onClick();
              onClose();
            }}
          >
            {item.icon ? <Icon name={item.icon} size={14} /> : <span className={styles.gap} />}
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}
