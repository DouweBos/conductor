import type { ButtonHTMLAttributes } from "react";

import { Icon, type IconName } from "../../icons/Icons";
import styles from "./IconButton.module.css";

export interface IconButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: IconName;
  label: string;
  size?: number;
  active?: boolean;
}

export function IconButton({
  icon,
  label,
  size = 16,
  active,
  className,
  ...rest
}: IconButtonProps) {
  const cls = [styles.iconButton, active && styles.active, className]
    .filter(Boolean)
    .join(" ");
  return (
    <button type="button" className={cls} aria-label={label} title={label} {...rest}>
      <Icon name={icon} size={size} />
    </button>
  );
}
