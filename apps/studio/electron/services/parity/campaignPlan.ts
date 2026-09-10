/**
 * The campaign's decisions, kept pure so they can be tested: which goal runs
 * next, what a finished convergence means for a goal's targets, and what a
 * moved reference does to work that was already accepted.
 */
import type {
  CampaignBurndown,
  ConvergeProgress,
  GoalTargetStatus,
  ParityGoal,
} from "../../../app/lib/types";

/** Statuses a campaign run will (re)attempt. Failed is retryable: it usually means a device died. */
const RUNNABLE: ReadonlySet<GoalTargetStatus> = new Set(["pending", "stalled", "failed", "recheck"]);

/** Targets of a goal the next run should work, in the goal's own order. */
export function runnableTargets(goal: ParityGoal): string[] {
  return goal.targets.map((t) => t.label).filter((l) => RUNNABLE.has(goal.status[l] ?? "pending"));
}

/** The first goal with anything left to do, in queue order. */
export function nextGoal(goals: ParityGoal[]): ParityGoal | undefined {
  return goals.find((g) => runnableTargets(g).length > 0);
}

/** Map what the loop reported to what the campaign records. */
export function statusFromPhase(
  phase: ConvergeProgress["targets"][number]["phase"],
  accepted: boolean | undefined,
): GoalTargetStatus {
  if (accepted) return "accepted";
  switch (phase) {
    case "awaiting-review":
      return "review";
    case "stalled":
      return "stalled";
    case "failed":
      return "failed";
    case "idle":
      return "pending";
    default:
      return "converging";
  }
}

/** Fold a finished convergence back into the goal it was run for. */
export function applyConvergence(goal: ParityGoal, progress: ConvergeProgress): ParityGoal {
  const status = { ...goal.status };
  const spent = { ...(goal.spent ?? { usd: 0, ms: 0, rounds: 0 }) };
  for (const t of progress.targets) {
    status[t.label] = statusFromPhase(t.phase, t.accepted);
    for (const a of t.attempts) {
      spent.rounds += 1;
      spent.usd += a.agent?.costUsd ?? 0;
      spent.ms += (a.agent?.durationMs ?? 0) + (a.steps ?? []).reduce((m, st) => m + st.durationMs, 0);
    }
  }
  return { ...goal, status, spent, updatedAt: Date.now() };
}

/**
 * The reference moved. Accepted work is not wrong, but it was accepted against
 * a screen that no longer exists, so it goes back for a recheck; everything
 * still in flight is simply held to the new reference from here on.
 */
export function applyDrift(
  goal: ParityGoal,
  newReferenceDir: string,
  drift: { blocking: number; summary: string },
): ParityGoal {
  const status = { ...goal.status };
  for (const [label, s] of Object.entries(status)) {
    if (s === "accepted") status[label] = "recheck";
  }
  return {
    ...goal,
    referenceDir: newReferenceDir,
    referenceCapturedAt: Date.now(),
    status,
    drift: { at: Date.now(), ...drift },
    updatedAt: Date.now(),
  };
}

/** The reference was re-captured and nothing changed: just note the freshness. */
export function applyNoDrift(goal: ParityGoal, newReferenceDir: string): ParityGoal {
  return {
    ...goal,
    referenceDir: newReferenceDir,
    referenceCapturedAt: Date.now(),
    drift: undefined,
    updatedAt: Date.now(),
  };
}

export function burndown(goals: ParityGoal[]): CampaignBurndown {
  const out: CampaignBurndown = {
    goals: goals.length,
    spentUsd: goals.reduce((n, g) => n + (g.spent?.usd ?? 0), 0),
    spentMs: goals.reduce((n, g) => n + (g.spent?.ms ?? 0), 0),
    acceptedByTarget: {},
    accepted: 0,
    review: 0,
    recheck: 0,
    stalled: 0,
    pending: 0,
  };
  for (const g of goals) {
    for (const t of g.targets) {
      const s = g.status[t.label] ?? "pending";
      if (s === "accepted") {
        out.accepted += 1;
        out.acceptedByTarget[t.label] = (out.acceptedByTarget[t.label] ?? 0) + 1;
      } else if (s === "review") out.review += 1;
      else if (s === "recheck") out.recheck += 1;
      else if (s === "stalled" || s === "failed") out.stalled += 1;
      else out.pending += 1;
    }
  }
  return out;
}
