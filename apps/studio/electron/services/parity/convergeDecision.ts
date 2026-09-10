/**
 * When a convergence loop should keep going, and when it should stop.
 *
 * Kept pure and free of Electron so the stop conditions can be tested. They are
 * the part of the loop that has to be right: an agent that can't fix something
 * will happily rediscover that fact for as many rounds as you give it, and a
 * loop with no patience gives up on a fix that was one round away.
 */
import type { ConvergeAttempt, ParityFinding } from "../../../app/lib/types";

export type ConvergeDecision =
  | { next: "review"; reason: string }
  | { next: "continue" }
  | { next: "stop"; reason: string };

export interface ConvergeBudget {
  maxAttempts: number;
  /** Consecutive rounds without fewer blocking findings before giving up. */
  patience: number;
}

/**
 * Decide what happens after `attempts` (most recent last).
 *
 * Progress is measured against the *best* round so far, not the previous one:
 * an agent that goes 5 → 3 → 4 has still made progress overall, and judging it
 * against the round before would call that a regression and stop early.
 */
export function decideNextRound(
  attempts: ConvergeAttempt[],
  budget: ConvergeBudget,
): ConvergeDecision {
  const latest = attempts[attempts.length - 1];
  if (!latest) return { next: "continue" };

  if (latest.error) {
    return { next: "stop", reason: latest.error };
  }

  if (latest.passed) {
    return { next: "review", reason: `matched the reference on round ${latest.index}` };
  }

  // How many rounds since the blocking count last improved on its best.
  let best = Number.POSITIVE_INFINITY;
  let sinceImprovement = 0;
  for (const a of attempts) {
    if (a.blocking < best) {
      best = a.blocking;
      sinceImprovement = 0;
    } else {
      sinceImprovement += 1;
    }
  }

  if (sinceImprovement >= budget.patience) {
    const remaining = budget.maxAttempts - attempts.length;
    return {
      next: "stop",
      reason:
        `${budget.patience} rounds without reducing the blocking count (stuck at ${latest.blocking}). ` +
        (remaining > 0
          ? `Stopping rather than burning the remaining ${remaining} round(s).`
          : "Out of rounds too."),
    };
  }

  if (attempts.length >= budget.maxAttempts) {
    return {
      next: "stop",
      reason: `out of rounds with ${latest.blocking} blocking finding(s) left`,
    };
  }

  return { next: "continue" };
}

/**
 * Blocking findings that every target's first round reports.
 *
 * A finding on one target is that target's bug. A finding on all of them is a
 * statement about the reference — independent rebuilds rarely drop the same
 * control — and the loop halts on it rather than dispatching N agents to each
 * build something the reference probably shouldn't have. Grouped by what the
 * finding is about (kind + identity + role), not its wording, so the same
 * dropped button reads as one finding across platforms.
 */
export function universalBlockingFindings(firsts: ConvergeAttempt[]): ParityFinding[] {
  const key = (f: ParityFinding): string =>
    [f.kind, (f.identifier || f.label || "").toLowerCase(), (f.role ?? "").toLowerCase()].join("|");
  const [head, ...rest] = firsts;
  if (!head || rest.length === 0) return [];
  return head.findings.filter(
    (f) =>
      f.severity === "blocking" &&
      rest.every((a) => a.findings.some((o) => o.severity === "blocking" && key(o) === key(f))),
  );
}
