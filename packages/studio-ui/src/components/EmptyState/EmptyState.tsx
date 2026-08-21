import type { ReactNode } from "react";

import { Icon, type IconName } from "../../icons/Icons";
import styles from "./EmptyState.module.css";

export interface EmptyStateProps {
  icon?: IconName;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className={styles.empty}>
      {icon ? (
        <div className={styles.iconWrap}>
          <Icon name={icon} size={28} />
        </div>
      ) : null}
      <h3 className={styles.title}>{title}</h3>
      {description ? <p className={styles.description}>{description}</p> : null}
      {action ? <div className={styles.action}>{action}</div> : null}
    </div>
  );
}
