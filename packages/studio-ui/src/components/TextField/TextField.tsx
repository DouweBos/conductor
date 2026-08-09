import type { InputHTMLAttributes } from "react";

import { Icon, type IconName } from "../../icons/Icons";
import styles from "./TextField.module.css";

export interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  icon?: IconName;
  label?: string;
}

export function TextField({ icon, label, className, id, ...rest }: TextFieldProps) {
  const input = (
    <div className={styles.wrapper}>
      {icon ? <Icon name={icon} size={14} className={styles.icon} /> : null}
      <input
        id={id}
        className={[styles.input, icon && styles.hasIcon].filter(Boolean).join(" ")}
        {...rest}
      />
    </div>
  );
  if (!label) return <div className={className}>{input}</div>;
  return (
    <label className={[styles.field, className].filter(Boolean).join(" ")} htmlFor={id}>
      <span className={styles.label}>{label}</span>
      {input}
    </label>
  );
}
