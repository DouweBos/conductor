/**
 * A campaign: the queue of reference screens a rebuild is held to.
 *
 * Persisted in the project at `.conductor/parity/campaign.json`, run goal by
 * goal through the convergence loop, with the reference for each goal frozen
 * at capture — and refreshable, because the app being ported from keeps
 * shipping while the port happens, and a reference captured in January is a
 * lie by March.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  CampaignProgress,
  ParityCampaign,
  ParityGoal,
  ParityMatrix,
  ParityTarget,
  Route,
} from "../../../app/lib/types";
import { broadcastToRenderers } from "../../broadcast";
import { appState } from "../../state";
import { resolveConductor } from "../maestro/maestroService";
import {
  applyConvergence,
  applyDrift,
  applyNoDrift,
  nextGoal,
  runnableTargets,
} from "./campaignPlan";
import { cancelConvergence, startConvergence, waitForConvergenceSettled } from "./convergeService";
import { replayRoute } from "./recipes";

interface RunState {
  running: boolean;
  currentGoalId?: string;
  stop: boolean;
  error?: string;
}

const run: RunState = { running: false, stop: false };

function campaignPath(): string {
  const root = appState.projectRoot ?? process.cwd();
  return path.join(root, ".conductor", "parity", "campaign.json");
}

async function load(): Promise<ParityCampaign> {
  try {
    const parsed = JSON.parse(await readFile(campaignPath(), "utf-8")) as ParityCampaign;
    return { version: 1, goals: parsed.goals ?? [] };
  } catch {
    return { version: 1, goals: [] };
  }
}

async function save(campaign: ParityCampaign): Promise<void> {
  await mkdir(path.dirname(campaignPath()), { recursive: true });
  await writeFile(campaignPath(), JSON.stringify(campaign, null, 2) + "\n", "utf-8");
}

async function publish(): Promise<CampaignProgress> {
  const progress: CampaignProgress = {
    campaign: await load(),
    running: run.running,
    currentGoalId: run.currentGoalId,
    error: run.error,
  };
  broadcastToRenderers("parity_campaign", progress);
  return progress;
}

export async function getCampaign(): Promise<CampaignProgress> {
  return publish();
}

async function updateGoal(id: string, mutate: (g: ParityGoal) => ParityGoal): Promise<void> {
  const campaign = await load();
  campaign.goals = campaign.goals.map((g) => (g.id === id ? mutate(g) : g));
  await save(campaign);
  await publish();
}

// ── Goals ────────────────────────────────────────────────────────────────────

export async function addGoal(input: {
  checkpoint: string;
  referenceDir: string;
  referenceLabel: string;
  referenceDeviceId: string;
  route?: Route;
  targets: ParityTarget[];
}): Promise<ParityGoal> {
  const campaign = await load();
  const goal: ParityGoal = {
    id: randomUUID(),
    checkpoint: input.checkpoint,
    referenceDir: path.resolve(input.referenceDir),
    referenceLabel: input.referenceLabel,
    referenceDeviceId: input.referenceDeviceId,
    referenceCapturedAt: Date.now(),
    route: input.route,
    targets: input.targets,
    status: Object.fromEntries(input.targets.map((t) => [t.label, "pending" as const])),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  campaign.goals.push(goal);
  await save(campaign);
  await publish();
  return goal;
}

export async function removeGoal(id: string): Promise<void> {
  const campaign = await load();
  campaign.goals = campaign.goals.filter((g) => g.id !== id);
  await save(campaign);
  await publish();
}

/** A deep link that opens the app straight at this screen, replacing the route's steps. */
export async function setGoalDeepLink(id: string, deepLink: string): Promise<void> {
  await updateGoal(id, (g) => ({
    ...g,
    route: {
      ...(g.route ?? { steps: [] }),
      deepLink: deepLink.trim() || undefined,
      // A deep link makes the recorded steps redundant; keep them in case it is
      // cleared again, but they are not replayed while it is set.
    },
    updatedAt: Date.now(),
  }));
}

/** Mark a target's review outcome on the goal without re-running anything. */
export async function setGoalTargetStatus(
  id: string,
  label: string,
  status: ParityGoal["status"][string],
): Promise<void> {
  await updateGoal(id, (g) => ({ ...g, status: { ...g.status, [label]: status }, updatedAt: Date.now() }));
}

// ── Running ──────────────────────────────────────────────────────────────────

/**
 * Work the queue: for each goal with anything runnable, converge only those
 * targets, fold the result back, move on. Review is not waited for — a goal
 * whose targets all reached review is finished as far as the campaign is
 * concerned, and a human catches up on reviews when they like.
 */
export async function runCampaign(opts: {
  strict?: boolean;
  autoApprove?: boolean;
  maxAttempts?: number;
  preferReload?: boolean;
}): Promise<void> {
  if (run.running) throw new Error("the campaign is already running");
  run.running = true;
  run.stop = false;
  run.error = undefined;
  await publish();

  void (async () => {
    try {
      for (;;) {
        if (run.stop) break;
        const campaign = await load();
        const goal = nextGoal(campaign.goals);
        if (!goal) break;

        const labels = new Set(runnableTargets(goal));
        const targets = goal.targets.filter((t) => labels.has(t.label));
        run.currentGoalId = goal.id;
        await updateGoal(goal.id, (g) => ({
          ...g,
          status: { ...g.status, ...Object.fromEntries(targets.map((t) => [t.label, "converging" as const])) },
        }));

        await startConvergence({
          checkpoint: goal.checkpoint,
          referenceDir: goal.referenceDir,
          referenceLabel: goal.referenceLabel,
          targets,
          route: goal.route,
          holdAgentForReview: false,
          ...opts,
        });
        const settled = await waitForConvergenceSettled();
        if (settled) await updateGoal(goal.id, (g) => applyConvergence(g, settled));
        if (run.stop) break;
      }
    } catch (err) {
      run.error = err instanceof Error ? err.message : String(err);
    } finally {
      run.running = false;
      run.currentGoalId = undefined;
      await publish();
    }
  })();
}

export async function stopCampaign(): Promise<void> {
  run.stop = true;
  await cancelConvergence();
  await publish();
}

// ── Reference drift ──────────────────────────────────────────────────────────

async function cli(): Promise<{ bin: string; prefix: string[]; env: NodeJS.ProcessEnv }> {
  const resolved = await resolveConductor();
  if (!resolved) throw new Error("Bundled conductor CLI is missing.");
  return { bin: resolved.bin, prefix: resolved.prefixArgs, env: resolved.env };
}

function runCli(bin: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], env });
    let output = "";
    child.stdout?.on("data", (c: Buffer) => (output += c.toString()));
    child.stderr?.on("data", (c: Buffer) => (output += c.toString()));
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
    child.on("error", (err) => resolve({ code: 1, output: err.message }));
  });
}

/**
 * Re-capture a goal's reference and see whether it moved.
 *
 * The route is replayed on the reference device to get it back to the screen,
 * the screen is captured into a fresh reference directory, and the old
 * reference is diffed against the new one — old as reference, new as
 * candidate, on the one checkpoint. Any blocking difference means accepted
 * targets were accepted against a screen that no longer exists.
 */
export async function refreshGoalReference(id: string): Promise<ParityGoal> {
  const campaign = await load();
  const goal = campaign.goals.find((g) => g.id === id);
  if (!goal) throw new Error("no such goal");
  if (run.running) throw new Error("stop the campaign before refreshing a reference");

  const { bin, prefix, env } = await cli();
  const root = appState.projectRoot ?? process.cwd();
  const newDir = path.join(root, ".conductor", "parity", `reference-${goal.id.slice(0, 8)}-${Date.now()}`);

  if (goal.route && (goal.route.steps.length || goal.route.appId || goal.route.deepLink)) {
    const r = await replayRoute(goal.referenceDeviceId, goal.route);
    if (!r.ok) throw new Error(`could not re-navigate the reference: ${r.output}`);
  }

  const captured = await runCli(
    bin,
    [
      ...prefix,
      "checkpoint",
      goal.checkpoint,
      "--run",
      newDir,
      "--device",
      goal.referenceDeviceId,
      "--label",
      goal.referenceLabel,
      "--role",
      "reference",
    ],
    env,
  );
  if (captured.code !== 0) throw new Error(`could not capture the reference: ${captured.output.trim()}`);

  const reportPath = path.join(newDir, "drift.json");
  await runCli(
    bin,
    [...prefix, "parity", "matrix", goal.referenceDir, newDir, "--json-report", reportPath],
    env,
  );
  let matrix: ParityMatrix;
  try {
    matrix = JSON.parse(await readFile(reportPath, "utf-8")) as ParityMatrix;
  } catch {
    throw new Error("the drift diff produced no report");
  }
  const cp = matrix.targets[0]?.report.checkpoints.find((c) => c.name === goal.checkpoint);
  const blocking = cp?.findings.filter((f) => f.severity === "blocking") ?? [];

  const next = blocking.length
    ? applyDrift(goal, newDir, {
        blocking: blocking.length,
        summary: blocking
          .slice(0, 4)
          .map((f) => f.detail)
          .join("; "),
      })
    : applyNoDrift(goal, newDir);

  await updateGoal(id, () => next);
  return next;
}
