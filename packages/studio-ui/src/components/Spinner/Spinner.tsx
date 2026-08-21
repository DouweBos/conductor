import styles from "./Spinner.module.css";

export interface SpinnerProps {
  size?: number;
  label?: string;
}

export function Spinner({ size = 16, label }: SpinnerProps) {
  return (
    <span className={styles.wrap} role="status" aria-label={label ?? "Loading"}>
      <span
        className={styles.spinner}
        style={{ width: size, height: size, borderWidth: Math.max(2, size / 8) }}
      />
      {label ? <span className={styles.label}>{label}</span> : null}
    </span>
  );
}
