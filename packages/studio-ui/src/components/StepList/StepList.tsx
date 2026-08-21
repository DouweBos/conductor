import { Icon, type IconName } from "../../icons/Icons";
import { Spinner } from "../Spinner/Spinner";
import styles from "./StepList.module.css";

export type StepStatus = "pending" | "running" | "passed" | "failed";

export interface StepItem {
  id: string;
  label: string;
  status: StepStatus;
}

export interface StepListProps {
  steps: StepItem[];
}

const ICON: Record<Exclude<StepStatus, "running">, IconName> = {
  pending: "dot",
  passed: "check",
  failed: "close",
};

export function StepList({ steps }: StepListProps) {
  if (steps.length === 0) return null;
  return (
    <ol className={styles.list}>
      {steps.map((step) => (
        <li key={step.id} className={[styles.step, styles[step.status]].join(" ")}>
          <span className={styles.marker}>
            {step.status === "running" ? <Spinner size={12} /> : <Icon name={ICON[step.status]} size={13} />}
          </span>
          <span className={styles.label}>{step.label}</span>
        </li>
      ))}
    </ol>
  );
}
