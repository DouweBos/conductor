import { Icon, type IconName } from "../../icons/Icons";
import styles from "./Tabs.module.css";

export interface TabItem {
  id: string;
  label: string;
  icon?: IconName;
  dirty?: boolean;
  closable?: boolean;
}

export interface TabsProps {
  tabs: TabItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose?: (id: string) => void;
}

export function Tabs({ tabs, activeId, onSelect, onClose }: TabsProps) {
  return (
    <div className={styles.tabs} role="tablist">
      {tabs.map((tab) => {
        const active = tab.id === activeId;
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={active}
            tabIndex={0}
            className={[styles.tab, active && styles.active].filter(Boolean).join(" ")}
            onClick={() => onSelect(tab.id)}
            onKeyDown={(e) => e.key === "Enter" && onSelect(tab.id)}
          >
            {tab.icon ? <Icon name={tab.icon} size={13} /> : null}
            <span className={styles.label}>{tab.label}</span>
            {tab.dirty ? <span className={styles.dirty} aria-label="unsaved" /> : null}
            {tab.closable !== false && onClose ? (
              <button
                type="button"
                className={styles.close}
                aria-label={`Close ${tab.label}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(tab.id);
                }}
              >
                <Icon name="close" size={12} />
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
