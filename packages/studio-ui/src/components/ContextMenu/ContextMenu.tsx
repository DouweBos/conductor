import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { Icon, type IconName } from "../../icons/Icons";
import styles from "./ContextMenu.module.css";

export interface ContextMenuAction {
  label: string;
  icon?: IconName;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Fires as the pointer enters and leaves, for previewing what the item acts on. */
  onHover?: (hovered: boolean) => void;
}

/** A rule between groups of actions. */
export interface ContextMenuSeparator {
  separator: true;
}

export type ContextMenuItem = ContextMenuAction | ContextMenuSeparator;

export interface ContextMenuProps {
  open: boolean;
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export function ContextMenu({ open, x, y, items, onClose }: ContextMenuProps) {
  // The gesture that opens the menu can still deliver a trailing click, which
  // would land on the scrim and shut it again — ignore closes until next frame.
  const [armed, setArmed] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  // Flip a menu opened near an edge back on-screen.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!open || !el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      x: Math.max(4, Math.min(x, window.innerWidth - width - 4)),
      y: Math.max(4, Math.min(y, window.innerHeight - height - 4)),
    });
  }, [open, x, y, items.length]);

  useEffect(() => {
    if (!open) {
      setArmed(false);
      return;
    }
    const frame = requestAnimationFrame(() => setArmed(true));
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  const dismiss = () => {
    if (armed) onClose();
  };

  if (!open) return null;
  return (
    <div
      className={styles.scrim}
      onClick={dismiss}
      onContextMenu={(e) => {
        e.preventDefault();
        dismiss();
      }}
    >
      <div
        ref={menuRef}
        className={styles.menu}
        style={{ left: pos.x, top: pos.y }}
        onClick={(e) => e.stopPropagation()}
        role="menu"
      >
        {items.map((item, i) =>
          "separator" in item ? (
            <div key={i} className={styles.separator} role="separator" />
          ) : (
            <button
              key={i}
              type="button"
              role="menuitem"
              className={[styles.item, item.danger && styles.danger].filter(Boolean).join(" ")}
              disabled={item.disabled}
              onPointerEnter={() => item.onHover?.(true)}
              onPointerLeave={() => item.onHover?.(false)}
              onClick={() => {
                item.onClick();
                onClose();
              }}
            >
              {item.icon ? <Icon name={item.icon} size={14} /> : <span className={styles.gap} />}
              {item.label}
            </button>
          ),
        )}
      </div>
    </div>
  );
}
