import { Icon, type IconName } from "@conductor/studio-ui";

import { setView, useRoute, type View } from "../../lib/router";
import styles from "./NavRail.module.css";

const ITEMS: { view: View; icon: IconName; label: string }[] = [
  { view: "flows", icon: "flow", label: "Flows" },
  { view: "agent", icon: "agent", label: "Agent" },
  { view: "cases", icon: "matrix", label: "Cases" },
];

export function NavRail() {
  const route = useRoute();
  return (
    <nav className={styles.rail} aria-label="Primary">
      {ITEMS.map((item) => {
        const active = route.view === item.view;
        return (
          <button
            key={item.view}
            type="button"
            className={[styles.item, active && styles.active].filter(Boolean).join(" ")}
            onClick={() => setView(item.view)}
            aria-current={active ? "page" : undefined}
            title={item.label}
          >
            <Icon name={item.icon} size={20} />
            <span className={styles.label}>{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
