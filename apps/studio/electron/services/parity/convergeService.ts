/**
 * The convergence loop: hold a reference screen, let agents work until the
 * rebuilt apps match it.
 *
 * This is the part that makes parity a gate rather than a report. The agent is
 * never asked whether it is finished — each round captures the target's screen,
 * diffs it against the frozen reference, and either hands the findings back for
 * another round or stops. An imperfect attempt cannot move forward until the
 * diff says it is a good one.
 *
 * Each target gets its own agent and its own device, because they are different
 * jobs: the tvOS findings are fixed in Swift, the Android TV ones in Kotlin, the
 * Lightning ones in TypeScript. They converge independently and in parallel.
 *
 * Every round captures into its own directory, so the attempt history *is* the
 * record of what changed — which is also what lets each round tell the agent
 * what the last one already tried.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import type {
  ConvergeAttempt,
  ConvergeProgress,
  ConvergeRequest,
  ConvergeTargetState,
  ParityFinding,
  ParityMatrix,
  ParityTarget,
} from "../../../app/lib/types";
import { broadcastToRenderers } from "../../broadcast";
import { appState } from "../../state";
import { isAgentRunning, sendAgentMessage, startAgent, stopAgent, waitForAgentTurn } from "../agent/agentService";
import { resolveConductor } from "../maestro/maestroService";
import { decideNextRound } from "./convergeDecision";
import { slugForLabel } from "./labels";

const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_PATIENCE = 3;

interface ActiveGoal {
  progress: ConvergeProgress;
  cancelled: boolean;
  dir: string;
}

let goal: ActiveGoal | null = null;

export function getConvergence(): ConvergeProgress | null {
  return goal?.progress ?? null;
}

function publish(): void {
  if (goal) {
    broadcastToRenderers("parity_converge", JSON.parse(JSON.stringify(goal.progress)));
  }
}

function update(label: string, mutate: (t: ConvergeTargetState) => void): void {
  const target = goal?.progress.targets.find((t) => t.label === label);
  if (!target) return;
  mutate(target);
  publish();
}

async function cli(): Promise<{ bin: string; prefix: string[]; env: NodeJS.ProcessEnv }> {
  const resolved = await resolveConductor();
  if (!resolved) throw new Error("Bundled conductor CLI is missing.");
  return { bin: resolved.bin, prefix: resolved.prefixArgs, env: resolved.env };
}

function runCli(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], env });
    let output = "";
    child.stdout?.on("data", (c: Buffer) => (output += c.toString()));
    child.stderr?.on("data", (c: Buffer) => (output += c.toString()));
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
    child.on("error", (err) => resolve({ code: 1, output: err.message }));
  });
}

// ── One round ────────────────────────────────────────────────────────────────

/**
 * Capture the target's current screen into a fresh directory and diff it
 * against the frozen reference.
 *
 * The reference is deliberately *not* re-captured: it is the goal, and a goal
 * that moves every round is not a goal. Comparing against the recording made
 * when the loop started is what lets a target converge on something stable.
 */
async function measure(
  target: ParityTarget,
  attemptIndex: number,
): Promise<{ attempt: ConvergeAttempt; matrix?: ParityMatrix }> {
  const g = goal;
  if (!g) throw new Error("no convergence goal");
  const { bin, prefix, env } = await cli();

  const dir = path.join(g.dir, "targets", slugForLabel(target.label), `attempt-${attemptIndex}`);
  await mkdir(path.dirname(dir), { recursive: true });

  const attempt: ConvergeAttempt = {
    index: attemptIndex,
    startedAt: Date.now(),
    blocking: 0,
    advisory: 0,
    passed: false,
    findings: [],
    dir,
  };

  const captured = await runCli(
    bin,
    [
      ...prefix,
      "checkpoint",
      g.progress.checkpoint,
      "--run",
      dir,
      "--device",
      target.deviceId,
      "--label",
      target.label,
      "--role",
      "candidate",
    ],
    env,
  );
  if (captured.code !== 0) {
    attempt.error = `could not capture the screen: ${captured.output.trim()}`;
    attempt.finishedAt = Date.now();
    return { attempt };
  }

  const reportPath = path.join(dir, "parity.json");
  await runCli(
    bin,
    [...prefix, "parity", "matrix", g.progress.referenceDir, dir, "--json-report", reportPath],
    env,
  );

  let matrix: ParityMatrix;
  try {
    matrix = JSON.parse(await readFile(reportPath, "utf-8")) as ParityMatrix;
  } catch {
    attempt.error = "the diff produced no report";
    attempt.finishedAt = Date.now();
    return { attempt };
  }

  const checkpoint = matrix.targets[0]?.report.checkpoints.find(
    (c) => c.name === g.progress.checkpoint,
  );
  attempt.findings = checkpoint?.findings ?? [];
  attempt.blocking = attempt.findings.filter((f) => f.severity === "blocking").length;
  attempt.advisory = attempt.findings.filter((f) => f.severity === "advisory").length;
  attempt.passed = matrix.passed;
  attempt.finishedAt = Date.now();
  return { attempt, matrix };
}

// ── The brief handed to the agent ────────────────────────────────────────────

function describeFindings(findings: ParityFinding[]): string {
  return findings
    .map((f) => {
      const id = f.identifier ? ` [${f.identifier}]` : "";
      return `- ${f.severity === "blocking" ? "MUST FIX" : "advisory"} (${f.kind})${id}: ${f.detail}`;
    })
    .join("\n");
}

/**
 * What the agent is told each round.
 *
 * Two things it has to get right, and both are easy to get wrong:
 *
 * 1. The agent does not judge parity. It fixes and re-navigates; the loop
 *    measures. Left to itself a model will declare victory on a screen that
 *    still differs, which is the failure mode this whole loop exists to remove.
 * 2. It must leave the app *on the screen*. The next round captures whatever is
 *    showing, so a build that ends on a splash screen scores a splash screen.
 */
function buildBrief(
  target: ConvergeTargetState,
  checkpoint: string,
  referenceLabel: string,
  attempt: ConvergeAttempt,
  maxAttempts: number,
): string {
  const previous = target.attempts.slice(0, -1);
  const history = previous.length
    ? [
        "",
        "## What earlier rounds already tried",
        ...previous.map(
          (a) => `- round ${a.index}: ${a.blocking} blocking, ${a.advisory} advisory`,
        ),
        previous.length >= 2 &&
        previous[previous.length - 1].blocking >= previous[previous.length - 2].blocking
          ? "The last round did not reduce the blocking count. Do something different — re-read the reference's structure rather than retrying the same edit."
          : "",
      ]
        .filter(Boolean)
        .join("\n")
    : "";

  return [
    `# Parity round ${attempt.index} of ${maxAttempts} — ${target.label}`,
    "",
    `You are making the **${target.label}** build match the **${referenceLabel}** build on the`,
    `screen called "${checkpoint}". The two were just compared. Here is what still differs:`,
    "",
    describeFindings(attempt.findings) || "- (no findings recorded)",
    history,
    "",
    "## What to do",
    "",
    `1. Fix the cause in the ${target.label} app's source. These are real differences in what`,
    "   the app renders — a missing control, wrong copy, the wrong thing focused. Change the",
    "   code, not the test.",
    "2. Rebuild / reload so the running app picks the change up.",
    `3. Navigate the app back to the "${checkpoint}" screen and leave it there.`,
    "4. End your turn.",
    "",
    "## What not to do",
    "",
    "- **Do not decide whether you have reached parity.** You are not the judge here; the",
    "  next round captures the screen and diffs it, and that verdict is the only one that",
    "  counts. Say what you changed, not whether it worked.",
    "- Do not call the parity tools. The loop measures between rounds.",
    "- Do not leave the app on some other screen — whatever is showing when your turn ends",
    "  is what gets compared.",
    "- Do not weaken the comparison to pass it (renaming things to match, hiding elements).",
    "  If a finding looks wrong, say so plainly and leave it; a human reads this log.",
    "",
    `Findings marked MUST FIX are what block. Advisory ones are worth fixing if they are`,
    "cheap and clearly right, but they will not hold the gate closed.",
  ].join("\n");
}

// ── The loop ─────────────────────────────────────────────────────────────────

async function convergeTarget(
  target: ParityTarget,
  req: ConvergeRequest,
  maxAttempts: number,
  patience: number,
): Promise<void> {
  const label = target.label;
  let agentId: string | undefined;

  try {
    for (let index = 1; index <= maxAttempts; index++) {
      if (goal?.cancelled) return;

      update(label, (t) => {
        t.phase = "capturing";
      });
      const { attempt } = await measure(target, index);
      if (goal?.cancelled) return;

      update(label, (t) => {
        t.attempts.push(attempt);
        t.phase = "diffing";
      });

      const state0 = goal?.progress.targets.find((t) => t.label === label);
      const decision = decideNextRound(state0?.attempts ?? [attempt], { maxAttempts, patience });

      if (decision.next === "review") {
        // Deliberately not "done". Parity is the gate, not the sign-off — a
        // human still looks at the screen before this counts as finished.
        update(label, (t) => {
          t.phase = "awaiting-review";
          t.outcome = decision.reason;
        });
        return;
      }

      if (decision.next === "stop") {
        update(label, (t) => {
          t.phase = attempt.error ? "failed" : "stalled";
          t.outcome = decision.reason;
          if (attempt.error) t.error = attempt.error;
        });
        return;
      }

      // Start this target's agent lazily: a target already at parity on round 1
      // never needs one.
      if (!agentId || !isAgentRunning(agentId)) {
        const started = await startAgent(target.deviceId, req.autoApprove);
        agentId = started.agentId;
        update(label, (t) => {
          t.agentId = agentId;
        });
      }

      const state = goal?.progress.targets.find((t) => t.label === label);
      if (!state) return;

      update(label, (t) => {
        t.phase = "agent-working";
      });
      sendAgentMessage(
        agentId,
        buildBrief(state, req.checkpoint, req.referenceLabel, attempt, maxAttempts),
      );

      try {
        await waitForAgentTurn(agentId);
      } catch (err) {
        update(label, (t) => {
          t.phase = "failed";
          t.error = err instanceof Error ? err.message : String(err);
          t.outcome = "the agent stopped";
        });
        return;
      }
    }
  } catch (err) {
    update(label, (t) => {
      t.phase = "failed";
      t.error = err instanceof Error ? err.message : String(err);
    });
  } finally {
    // The device goes back to the pool either way; a target left at parity does
    // not need an agent holding its simulator.
    if (agentId && isAgentRunning(agentId)) await stopAgent(agentId).catch(() => {});
  }
}

export async function startConvergence(req: ConvergeRequest): Promise<{ goalId: string }> {
  if (goal?.progress.running) throw new Error("a convergence run is already in progress");
  if (req.targets.length === 0) throw new Error("convergence needs at least one target");

  const maxAttempts = Math.max(1, req.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const patience = Math.max(1, req.patience ?? DEFAULT_PATIENCE);
  const goalId = randomUUID();
  const root = appState.projectRoot ?? process.cwd();

  goal = {
    cancelled: false,
    dir: path.join(root, ".conductor", "parity", `converge-${goalId}`),
    progress: {
      goalId,
      checkpoint: req.checkpoint,
      referenceLabel: req.referenceLabel,
      referenceDir: req.referenceDir,
      running: true,
      startedAt: Date.now(),
      targets: req.targets.map((t) => ({
        label: t.label,
        deviceId: t.deviceId,
        platform: t.platform,
        phase: "idle" as const,
        attempts: [],
      })),
    },
  };
  publish();

  // Targets converge in parallel: they are separate codebases on separate
  // devices, and holding tvOS up while Android TV works would triple the wall
  // clock for no reason.
  void Promise.all(req.targets.map((t) => convergeTarget(t, req, maxAttempts, patience)))
    .catch(() => {
      /* per-target failures are already recorded on the target */
    })
    .finally(() => {
      if (goal) {
        goal.progress.running = false;
        goal.progress.finishedAt = Date.now();
        publish();
      }
    });

  return { goalId };
}

export async function cancelConvergence(): Promise<void> {
  if (!goal) return;
  goal.cancelled = true;
  const agents = goal.progress.targets.map((t) => t.agentId).filter(Boolean) as string[];
  await Promise.all(agents.map((id) => stopAgent(id).catch(() => {})));
  goal.progress.running = false;
  goal.progress.finishedAt = Date.now();
  for (const t of goal.progress.targets) {
    if (t.phase === "capturing" || t.phase === "diffing" || t.phase === "agent-working") {
      t.phase = "stalled";
      t.outcome = "cancelled";
    }
  }
  publish();
}

/** The human's nod: this target's screen has been looked at and accepted. */
export function acceptTarget(label: string): void {
  update(label, (t) => {
    if (t.phase === "awaiting-review") t.outcome = `${t.outcome ?? "matched"} · accepted`;
  });
}
