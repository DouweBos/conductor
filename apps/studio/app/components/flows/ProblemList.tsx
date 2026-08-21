import { Button, EmptyState, StatusPill, type StatusTone } from "@conductor/studio-ui";

import { selectFlow } from "../../lib/router";
import type { LintProblem } from "../../lib/types";
import styles from "./ProblemList.module.css";

const TONE: Record<LintProblem["severity"], StatusTone> = {
  error: "error",
  warning: "warning",
  info: "info",
};

/** Everything wrong with the project that we can see without running it. */
export function ProblemList({
  problems,
  onRefresh,
}: {
  problems: LintProblem[];
  onRefresh: () => void;
}) {
  if (problems.length === 0) {
    return (
      <div className={styles.empty}>
        <EmptyState
          icon="check"
          title="No problems found"
          description="Unknown commands, broken runFlow paths, and missing parameters all show up here."
          action={
            <Button size="sm" variant="secondary" icon="refresh" onClick={onRefresh}>
              Check the project
            </Button>
          }
        />
      </div>
    );
  }
  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <span className={styles.count}>
          {problems.length} problem{problems.length === 1 ? "" : "s"}
        </span>
        <Button size="sm" variant="ghost" icon="refresh" onClick={onRefresh}>
          Re-check
        </Button>
      </div>
      <ul className={styles.list}>
        {problems.map((problem, index) => (
          <li key={`${problem.file}:${problem.line}:${index}`}>
            <button
              type="button"
              className={styles.item}
              onClick={() => selectFlow(problem.file)}
            >
              <StatusPill tone={TONE[problem.severity]}>{problem.severity}</StatusPill>
              <span className={styles.message}>{problem.message}</span>
              <span className={styles.where}>
                {problem.file}:{problem.line}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
