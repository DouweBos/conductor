import type { ReactNode } from "react";

import { Icon } from "../../icons/Icons";
import styles from "./Tag.module.css";

export interface TagProps {
  children: ReactNode;
  onRemove?: () => void;
  interactive?: boolean;
  onClick?: () => void;
}

export function Tag({ children, onRemove, interactive, onClick }: TagProps) {
  const cls = [styles.tag, interactive && styles.interactive].filter(Boolean).join(" ");
  return (
    <span className={cls} onClick={onClick}>
      <Icon name="tag" size={11} />
      <span>{children}</span>
      {onRemove ? (
        <button
          type="button"
          className={styles.remove}
          aria-label="Remove tag"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          <Icon name="close" size={10} />
        </button>
      ) : null}
    </span>
  );
}
