import styles from "./SegmentedControl.module.css";

export interface SegmentedOption {
  value: string;
  label: string;
}

export interface SegmentedControlProps {
  options: SegmentedOption[];
  value: string;
  onChange: (value: string) => void;
  /** Accessible name for the group. */
  label?: string;
}

/** A compact exclusive choice — for modes, not for navigation. */
export function SegmentedControl({ options, value, onChange, label }: SegmentedControlProps) {
  return (
    <div className={styles.group} role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          className={[styles.segment, option.value === value ? styles.active : ""].join(" ")}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
