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
 * Lightning ones in TypeScript. They converge independently and in parallel —
 * after one shared first round, see `startConvergence`.
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
  RecipeStepResult,
  TargetRecipe,
} from "../../../app/lib/types";
import { broadcastToRenderers } from "../../broadcast";
import { appState } from "../../state";
import {
  isAgentRunning,
  sendAgentMessage,
  startAgent,
  stopAgent,
  waitForAgentTurn,
} from "../agent/agentService";
import { resolveConductor } from "../maestro/maestroService";
import { getRecipe } from "./config";
import { decideNextRound, universalBlockingFindings } from "./convergeDecision";
import { slugForLabel } from "./labels";
import { readMemory, remember, renderMemoryForBrief } from "./memory";
import { prepareTarget, runTargetTests } from "./recipes";

const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_PATIENCE = 3;
/** Rounds a target gets back after a human rejects it with a note. */
const REJECT_EXTRA_ROUNDS = 3;
/** The CLI needs a moment to finish its initialize handshake before a message. */
const AGENT_WARMUP_MS = 400;

interface ReferenceFiles {
  snapshot: string;
  screenshot: string;
}

interface ActiveGoal {
  progress: ConvergeProgress;
  req: ConvergeRequest;
  cancelled: boolean;
  dir: string;
  maxAttempts: number;
  patience: number;
  reference: ReferenceFiles | null;
  /** Per-target budget top-ups from rejections. */
  extraRounds: Map<string, number>;
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

function targetState(label: string): ConvergeTargetState | undefined {
  return goal?.progress.targets.find((t) => t.label === label);
}

function update(label: string, mutate: (t: ConvergeTargetState) => void): void {
  const target = targetState(label);
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Where the frozen reference screen lives on disk. The agent is pointed at
 * these files: findings say *what* differs, but to build a missing control it
 * needs the reference's structure — label, role, position, what sits around it
 * — and its screenshot to see what it looks like.
 */
async function locateReference(referenceDir: string, checkpoint: string): Promise<ReferenceFiles> {
  const manifest = JSON.parse(await readFile(path.join(referenceDir, "run.json"), "utf-8")) as {
    checkpoints: Array<{ name: string; snapshotFile: string; screenshotFile: string }>;
  };
  const record = manifest.checkpoints.find((c) => c.name === checkpoint);
  if (!record) {
    throw new Error(`the reference run has no checkpoint named "${checkpoint}"`);
  }
  return {
    snapshot: path.join(referenceDir, record.snapshotFile),
    screenshot: path.join(referenceDir, record.screenshotFile),
  };
}

// ── One round ────────────────────────────────────────────────────────────────

/**
 * Capture the target's current screen into a fresh directory and diff it
 * against the frozen reference.
 *
 * The reference is deliberately *not* re-captured: it is the goal, and a goal
 * that moves every round is not a goal.
 *
 * The verdict is taken from the one checkpoint being converged on, never from
 * the matrix as a whole. The reference directory is a whole live session and
 * may hold several snapped screens; an attempt captures only this one, so every
 * other reference screen would read as `checkpoint-missing` and the matrix
 * verdict could never pass.
 */
async function measure(
  target: ParityTarget,
  attemptIndex: number,
  recipe?: TargetRecipe,
  steps: RecipeStepResult[] = [],
): Promise<ConvergeAttempt> {
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
    steps,
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
    return attempt;
  }

  const reportPath = path.join(dir, "parity.json");
  await runCli(
    bin,
    [
      ...prefix,
      "parity",
      "matrix",
      g.progress.referenceDir,
      dir,
      "--json-report",
      reportPath,
      ...(g.req.strict ? ["--strict"] : []),
    ],
    env,
  );

  let matrix: ParityMatrix;
  try {
    matrix = JSON.parse(await readFile(reportPath, "utf-8")) as ParityMatrix;
  } catch {
    attempt.error = "the diff produced no report";
    attempt.finishedAt = Date.now();
    return attempt;
  }

  const checkpoint = matrix.targets[0]?.report.checkpoints.find(
    (c) => c.name === g.progress.checkpoint,
  );
  if (!checkpoint) {
    attempt.error = `the diff has no result for "${g.progress.checkpoint}"`;
    attempt.finishedAt = Date.now();
    return attempt;
  }
  attempt.findings = checkpoint.findings;
  attempt.blocking = checkpoint.findings.filter((f) => f.severity === "blocking").length;
  attempt.advisory = checkpoint.findings.filter((f) => f.severity === "advisory").length;
  attempt.passed = checkpoint.passed;

  // The screen matching is necessary, not sufficient: Helix's gate also asks
  // the rebuild to "prove its behavior with tests". Run them only once the
  // screen passes — a red suite on a screen that is still wrong is noise.
  if (attempt.passed && recipe?.test) {
    const t = await runTargetTests(recipe);
    attempt.tests = { passed: t.passed, output: t.output };
    if (t.step) attempt.steps = [...(attempt.steps ?? []), t.step];
    if (!t.passed) attempt.passed = false;
  }

  attempt.finishedAt = Date.now();
  return attempt;
}

/**
 * An attempt that never got as far as a capture because the rebuild failed.
 * Findings carry over unchanged — nothing was measured — so the trend shows a
 * flat line rather than a false zero, and patience ticks down as it should.
 */
function unbuiltAttempt(
  previous: ConvergeAttempt | undefined,
  index: number,
  dir: string,
  steps: RecipeStepResult[],
): ConvergeAttempt {
  return {
    index,
    startedAt: Date.now(),
    finishedAt: Date.now(),
    blocking: previous?.blocking ?? 0,
    advisory: previous?.advisory ?? 0,
    passed: false,
    findings: previous?.findings ?? [],
    dir,
    steps,
  };
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
 * Three things it has to get right, and all are easy to get wrong:
 *
 * 1. The agent does not judge parity. It fixes and re-navigates; the loop
 *    measures. Left to itself a model will declare victory on a screen that
 *    still differs, which is the failure mode this whole loop exists to remove.
 * 2. It must leave the app *on the screen*. The next round captures whatever is
 *    showing, so a build that ends on a splash screen scores a splash screen.
 * 3. It needs to be able to *see the reference*. Findings alone say a button is
 *    missing; the reference snapshot says where it goes, what it's called, what
 *    role it plays and what surrounds it. The brief points at the files.
 */
function buildBrief(
  target: ConvergeTargetState,
  attempt: ConvergeAttempt,
  humanNote: string | undefined,
  recipe: TargetRecipe | undefined,
  memoryBlock: string,
): string {
  const g = goal;
  if (!g) return "";
  const loopOwnsRebuild = Boolean(recipe?.build || recipe?.reload);
  const loopOwnsRoute = Boolean(g.req.route || recipe?.appId);
  const { checkpoint, referenceLabel } = g.progress;
  const budget = g.maxAttempts + (g.extraRounds.get(target.label) ?? 0);
  const previous = target.attempts.slice(0, -1);
  const lastTwo = previous.slice(-2);
  const stuck = lastTwo.length === 2 && lastTwo[1].blocking >= lastTwo[0].blocking;

  const history = previous.length
    ? [
        "",
        "## What earlier rounds already tried",
        ...previous.map((a) => `- round ${a.index}: ${a.blocking} blocking, ${a.advisory} advisory`),
        stuck
          ? "The last round did not reduce the blocking count. Do something different — re-read the reference's structure rather than retrying the same edit."
          : "",
      ]
        .filter(Boolean)
        .join("\n")
    : "";

  const failedStep = (attempt.steps ?? []).find((s) => !s.ok);
  const buildBlock = failedStep
    ? [
        "",
        `## The ${failedStep.step} step failed last round — fix this first`,
        "```",
        failedStep.output.trim(),
        "```",
        "Nothing was measured, because measuring a screen after a failed build would score",
        "the old binary. The findings below are from the last successful capture.",
      ].join("\n")
    : "";
  const testBlock =
    attempt.tests && !attempt.tests.passed
      ? [
          "",
          "## The screen matches, but the target's tests fail",
          "```",
          attempt.tests.output.trim(),
          "```",
          "Parity is not the whole gate: the rebuild has to prove its behaviour too.",
        ].join("\n")
      : "";

  const reviewer = humanNote
    ? [
        "",
        "## A human looked at your last result and sent it back",
        `> ${humanNote.trim().split("\n").join("\n> ")}`,
        "Their note outranks the findings below: the diff passed, and they still say it is wrong.",
      ].join("\n")
    : "";

  return [
    `# Parity round ${attempt.index} of ${budget} — ${target.label}`,
    "",
    `You are making the **${target.label}** build match the **${referenceLabel}** build on the`,
    `screen called "${checkpoint}". The two were just compared. Here is what still differs:`,
    "",
    describeFindings(attempt.findings) || "- (nothing — see the reviewer's note)",
    buildBlock,
    testBlock,
    reviewer,
    history,
    memoryBlock ? "" : "",
    memoryBlock,
    "",
    "## The reference — read this before changing anything",
    "",
    "Findings say *what* differs. To build it you need to see what you are matching:",
    "",
    `- Structure: \`${g.reference?.snapshot ?? "(unavailable)"}\` — the reference screen's`,
    "  accessibility snapshot. Every element with its label, role, frame (x, y, w, h), value,",
    "  focus state and reading order. Elements carry an `identifier` when the app tagged them;",
    "  give your element the **same identifier** and it pairs exactly.",
    `- Screenshot: \`${g.reference?.screenshot ?? "(unavailable)"}\` — what it looks like.`,
    `- Your build's capture from this round: \`${path.join(attempt.dir)}\` — the same files`,
    "  for what your app is currently showing, so you can compare structure to structure.",
    "",
    "## What to do",
    "",
    `1. Fix the cause in the ${target.label} app's source. These are real differences in what`,
    "   the app renders — a missing control, wrong copy, the wrong thing focused. Change the",
    "   code, not the test.",
    ...(loopOwnsRebuild
      ? [
          "2. Save your changes and end your turn. **The loop rebuilds the app for you** using",
          `   the recipe (${recipe?.reload ? "reload" : "build"}${recipe?.install ? " + install" : ""}); a build error comes back to you verbatim next round.`,
        ]
      : [
          "2. Rebuild / reload so the running app picks the change up. If you worked out how to",
          "   build and launch this app in an earlier round, do the same again — and record how",
          "   with `remember_for_target` so the next goal doesn't have to rediscover it.",
        ]),
    ...(loopOwnsRoute
      ? ["3. **The loop re-navigates for you** by replaying the recorded route. Do not navigate."]
      : [`3. Navigate the app back to the "${checkpoint}" screen and leave it there.`]),
    "4. If you learned something that will still be true next time — how this app builds,",
    "   a convention, a trap — write it down with `remember_for_target`. It is read back to",
    "   you at the start of every round on this target, in every future goal.",
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
    "Findings marked MUST FIX are what block. Advisory ones are worth fixing if they are",
    "cheap and clearly right, but they will not hold the gate closed.",
  ].join("\n");
}

// ── The loop ─────────────────────────────────────────────────────────────────

/** Run rounds for one target until the decision says stop. Resumable. */
async function runRounds(
  target: ParityTarget,
  startIndex: number,
  firstBrief?: { note: string },
): Promise<void> {
  const g = goal;
  if (!g) return;
  const label = target.label;
  let note = firstBrief?.note;
  const recipe = await getRecipe(label);

  try {
    for (let index = startIndex; ; index++) {
      if (g.cancelled) return;

      // Between the agent's edit and the next measurement: rebuild, relaunch,
      // replay the route. On the first round of a resume there is nothing to
      // rebuild — the agent has not touched anything yet.
      let prepared: { ok: boolean; steps: RecipeStepResult[] } = { ok: true, steps: [] };
      const previous = targetState(label)?.attempts.at(-1);
      if (index > 1 && index !== startIndex) {
        update(label, (t) => {
          t.phase = "preparing";
        });
        prepared = await prepareTarget(target.deviceId, recipe, g.req.route, {
          preferReload: g.req.preferReload,
        });
        if (g.cancelled) return;
      }

      update(label, (t) => {
        t.phase = "capturing";
      });
      const attempt = prepared.ok
        ? await measure(target, index, recipe, prepared.steps)
        : unbuiltAttempt(
            previous,
            index,
            path.join(g.dir, "targets", slugForLabel(label), `attempt-${index}`),
            prepared.steps,
          );
      if (g.cancelled) return;

      update(label, (t) => {
        t.attempts.push(attempt);
        t.phase = "diffing";
      });

      const state = targetState(label);
      if (!state) return;
      const maxAttempts = g.maxAttempts + (g.extraRounds.get(label) ?? 0);
      const decision = decideNextRound(state.attempts, { maxAttempts, patience: g.patience });

      if (decision.next === "review" && !note) {
        // Deliberately not "done". Parity is the gate, not the sign-off — a
        // human still looks at the screen before this counts as finished. The
        // agent stays alive so a rejection can send the note back to the same
        // context rather than to a fresh one that has forgotten the codebase.
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
        if (!attempt.error && attempt.blocking > 0) {
          const stuckOn = attempt.findings
            .filter((f) => f.severity === "blocking")
            .slice(0, 3)
            .map((f) => f.detail)
            .join("; ");
          await remember(
            label,
            "loop",
            `Stalled on "${g.progress.checkpoint}" after ${state.attempts.length} rounds, stuck on: ${stuckOn}`,
          );
        }
        await stopTargetAgent(label);
        return;
      }

      // Start this target's agent lazily: a target already at parity on round 1
      // never needs one.
      let agentId = state.agentId;
      if (!agentId || !isAgentRunning(agentId)) {
        const started = await startAgent(target.deviceId, g.req.autoApprove ?? true);
        agentId = started.agentId;
        update(label, (t) => {
          t.agentId = agentId;
        });
        await sleep(AGENT_WARMUP_MS);
      }

      update(label, (t) => {
        t.phase = "agent-working";
      });
      const memoryBlock = renderMemoryForBrief(await readMemory(label));
      sendAgentMessage(agentId, buildBrief(state, attempt, note, recipe, memoryBlock));
      // A reviewer's note is delivered once, with the round it prompted.
      note = undefined;

      try {
        const turn = await waitForAgentTurn(agentId);
        update(label, (t) => {
          const a = t.attempts.at(-1);
          if (a) a.agent = { durationMs: turn.durationMs, costUsd: turn.costUsd, turns: turn.turns };
        });
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
    await stopTargetAgent(label);
  }
}

async function stopTargetAgent(label: string): Promise<void> {
  const state = targetState(label);
  if (state?.agentId && isAgentRunning(state.agentId)) {
    await stopAgent(state.agentId).catch(() => {});
  }
}

function finishGoalIfIdle(): void {
  if (!goal) return;
  const busy = goal.progress.targets.some(
    (t) => t.phase === "capturing" || t.phase === "diffing" || t.phase === "agent-working",
  );
  if (!busy && goal.progress.running) {
    goal.progress.running = false;
    goal.progress.finishedAt = Date.now();
    publish();
  }
}

export async function startConvergence(req: ConvergeRequest): Promise<{ goalId: string }> {
  if (goal?.progress.running) throw new Error("a convergence run is already in progress");
  if (req.targets.length === 0) throw new Error("convergence needs at least one target");

  const goalId = randomUUID();
  const root = appState.projectRoot ?? process.cwd();
  const reference = await locateReference(req.referenceDir, req.checkpoint);

  goal = {
    req,
    cancelled: false,
    dir: path.join(root, ".conductor", "parity", `converge-${goalId}`),
    maxAttempts: Math.max(1, req.maxAttempts ?? DEFAULT_MAX_ATTEMPTS),
    patience: Math.max(1, req.patience ?? DEFAULT_PATIENCE),
    reference,
    extraRounds: new Map(),
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

  void (async () => {
    const g = goal;
    if (!g) return;

    // ── Round 1 for everyone, before any agent is dispatched ──
    //
    // A finding every target reports is a statement about the reference, not
    // the targets: independent rebuilds rarely drop the same control. Sending
    // four agents off to each build a control the reference shouldn't have is
    // the one thing a matrix exists to prevent, so measure all targets first
    // and halt if they agree.
    for (const t of g.progress.targets) t.phase = "capturing";
    publish();
    const firsts = await Promise.all(
      req.targets.map(async (t) => measure(t, 1, await getRecipe(t.label))),
    );
    if (g.cancelled) return;
    for (let i = 0; i < req.targets.length; i++) {
      update(req.targets[i].label, (t) => {
        t.attempts.push(firsts[i]);
        t.phase = "diffing";
      });
    }

    const universal = universalBlockingFindings(firsts);
    if (req.targets.length > 1 && universal.length > 0) {
      const list = universal.map((f) => `${f.kind}: ${f.detail}`).join("\n  ");
      for (const t of g.progress.targets) {
        t.phase = "stalled";
        t.outcome =
          `halted before dispatching an agent: every target reports the same ${universal.length} ` +
          `blocking finding(s), which points at the reference rather than the targets.\n  ${list}`;
      }
      g.progress.running = false;
      g.progress.finishedAt = Date.now();
      publish();
      return;
    }

    // ── Then each target on its own ──
    await Promise.all(
      req.targets.map((t, i) => {
        const decision = decideNextRound([firsts[i]], {
          maxAttempts: g.maxAttempts,
          patience: g.patience,
        });
        if (decision.next === "review") {
          update(t.label, (s) => {
            s.phase = "awaiting-review";
            s.outcome = decision.reason;
          });
          return Promise.resolve();
        }
        if (decision.next === "stop") {
          update(t.label, (s) => {
            s.phase = firsts[i].error ? "failed" : "stalled";
            s.outcome = decision.reason;
            if (firsts[i].error) s.error = firsts[i].error;
          });
          return Promise.resolve();
        }
        return dispatchAndContinue(t, firsts[i]);
      }),
    );
    finishGoalIfIdle();
  })().catch(() => {
    /* per-target failures are already recorded on the target */
  });

  return { goalId };
}

/** After a measured round 1 that did not pass: brief the agent, then keep going. */
async function dispatchAndContinue(target: ParityTarget, first: ConvergeAttempt): Promise<void> {
  const g = goal;
  if (!g) return;
  const state = targetState(target.label);
  if (!state) return;

  const started = await startAgent(target.deviceId, g.req.autoApprove ?? true);
  update(target.label, (t) => {
    t.agentId = started.agentId;
    t.phase = "agent-working";
  });
  await sleep(AGENT_WARMUP_MS);
  const recipe = await getRecipe(target.label);
  const memoryBlock = renderMemoryForBrief(await readMemory(target.label));
  sendAgentMessage(started.agentId, buildBrief(state, first, undefined, recipe, memoryBlock));
  try {
    const turn = await waitForAgentTurn(started.agentId);
    update(target.label, (t) => {
      const a = t.attempts.at(-1);
      if (a) a.agent = { durationMs: turn.durationMs, costUsd: turn.costUsd, turns: turn.turns };
    });
  } catch (err) {
    update(target.label, (t) => {
      t.phase = "failed";
      t.error = err instanceof Error ? err.message : String(err);
      t.outcome = "the agent stopped";
    });
    return;
  }
  await runRounds(target, 2);
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

/** The human's nod: looked at, accepted. The agent is released. */
export async function acceptTarget(label: string): Promise<void> {
  const state = targetState(label);
  if (!state || state.phase !== "awaiting-review") return;
  update(label, (t) => {
    t.accepted = true;
    t.outcome = `${t.outcome ?? "matched"} · accepted`;
  });
  await stopTargetAgent(label);
  finishGoalIfIdle();
}

/**
 * The human's shake: the diff passed, a person looked and still says no.
 *
 * Their note goes back to the *same* agent, which still has the codebase in
 * context, and the target gets a few more rounds. This is the other half of
 * "get a human's nod": a review that can only say yes is not a review.
 */
export async function rejectTarget(label: string, note: string): Promise<void> {
  const g = goal;
  const state = targetState(label);
  const target = g?.req.targets.find((t) => t.label === label);
  if (!g || !state || !target || state.phase !== "awaiting-review") return;
  if (!note.trim()) throw new Error("say what is wrong — the note is what the agent works from");

  g.extraRounds.set(label, (g.extraRounds.get(label) ?? 0) + REJECT_EXTRA_ROUNDS);
  await remember(label, "reviewer", `On "${g.progress.checkpoint}": ${note.trim()}`);
  g.progress.running = true;
  g.progress.finishedAt = undefined;
  update(label, (t) => {
    t.outcome = undefined;
  });
  void runRounds(target, state.attempts.length + 1, { note }).finally(finishGoalIfIdle);
}
