/**
 * The plan: proposed screens, and the step from a proposal to a goal.
 *
 * Persisted in the project at `.conductor/parity/plan.json` beside the
 * campaign, so a plan drawn up on one machine is the plan on the next. A
 * proposal becomes a goal by being captured: the reference device is driven
 * to the screen along the proposal's route, the screen is captured as a
 * reference run, and a campaign goal is queued against it with the targets
 * currently in the workspace. Nothing here converges — that is the campaign's.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  AppFingerprint,
  ParityPlan,
  ParityTarget,
  PlanProgress,
  PlanProposal,
} from "../../../app/lib/types";
import { broadcastToRenderers } from "../../broadcast";
import { appState } from "../../state";
import { sendAgentMessage, startAgent, stopAgent, waitForAgentTurn } from "../agent/agentService";
import { findAppByKey, listSceneGraphs, loadSceneGraph } from "../scenegraph/sceneGraphService";
import { addGoal, cli, runCli } from "./campaignService";
import { describeRoute } from "./routes";
import {
  buildPlannerBrief,
  mergeProposals,
  parsePlannerAnswer,
  proposeFromSceneGraph,
} from "./planDecision";
import { replayRoute } from "./recipes";

const AGENT_WARMUP_MS = 400;

interface PlanState {
  planning: boolean;
  capturingId?: string;
  error?: string;
}

const state: PlanState = { planning: false };

function planPath(): string {
  const root = appState.projectRoot ?? process.cwd();
  return path.join(root, ".conductor", "parity", "plan.json");
}

async function load(): Promise<ParityPlan> {
  try {
    const parsed = JSON.parse(await readFile(planPath(), "utf-8")) as ParityPlan;
    return { version: 1, appId: parsed.appId, proposals: parsed.proposals ?? [], plannedAt: parsed.plannedAt };
  } catch {
    return { version: 1, proposals: [] };
  }
}

async function save(plan: ParityPlan): Promise<void> {
  await mkdir(path.dirname(planPath()), { recursive: true });
  await writeFile(planPath(), JSON.stringify(plan, null, 2) + "\n", "utf-8");
}

async function publish(): Promise<PlanProgress> {
  const progress: PlanProgress = {
    plan: await load(),
    planning: state.planning,
    capturingId: state.capturingId,
    error: state.error,
  };
  broadcastToRenderers("parity_plan", progress);
  return progress;
}

export async function getPlan(): Promise<PlanProgress> {
  return publish();
}

async function resolveApp(app?: string): Promise<AppFingerprint | null> {
  if (app) return findAppByKey(app);
  if (appState.currentApp) return appState.currentApp;
  const graphs = await listSceneGraphs();
  return graphs.length === 1 ? graphs[0].app : null;
}

/**
 * Propose from the recorded scene graph: every screen Studio saw while the
 * reference was explored, shallowest first, each with the route that led there.
 */
export async function planFromSceneGraph(app?: string): Promise<PlanProgress> {
  state.error = undefined;
  const fp = await resolveApp(app);
  if (!fp) {
    state.error = app
      ? `no scene graph recorded for "${app}"`
      : "no scene graph to plan from — explore the reference app first, or name the app";
    return publish();
  }
  const graph = await loadSceneGraph(fp);
  const proposals = proposeFromSceneGraph(graph);
  if (!proposals.length) {
    state.error = `the scene graph for ${fp.appName} has no screens yet`;
    return publish();
  }
  const plan = await load();
  await save({
    version: 1,
    appId: plan.appId ?? fp.appId,
    proposals: mergeProposals(plan.proposals, proposals),
    plannedAt: Date.now(),
  });
  return publish();
}

/**
 * Propose by reading the reference's source. A planner agent is started
 * with the brief, its JSON answer is merged into the plan. One planner at a
 * time; the answer's screens pair by name with what the graph proposed.
 */
export async function planWithAgent(input: { sourceDir: string; app?: string }): Promise<PlanProgress> {
  if (state.planning) throw new Error("the planner is already reading the source");
  const sourceDir = input.sourceDir.trim();
  if (!sourceDir) throw new Error("say where the reference's source lives");

  state.planning = true;
  state.error = undefined;
  await publish();

  let agentId: string | null = null;
  try {
    const fp = await resolveApp(input.app);
    const plan = await load();
    const known = plan.proposals.map((p) => ({
      name: p.name,
      route: p.route ? describeRoute(p.route) : undefined,
    }));
    const brief = buildPlannerBrief({
      sourceDir: path.resolve(appState.projectRoot ?? process.cwd(), sourceDir),
      appId: fp?.appId ?? plan.appId,
      platform: fp?.platform,
      known,
    });

    const started = await startAgent(undefined, true);
    agentId = started.agentId;
    await new Promise((r) => setTimeout(r, AGENT_WARMUP_MS));
    sendAgentMessage(agentId, brief);
    const turn = await waitForAgentTurn(agentId);
    const answer = parsePlannerAnswer(turn.text, fp?.appId ?? plan.appId);
    if (answer.error) state.error = answer.error;
    if (answer.proposals.length) {
      await save({
        version: 1,
        appId: plan.appId ?? fp?.appId,
        proposals: mergeProposals(plan.proposals, answer.proposals),
        plannedAt: Date.now(),
      });
    }
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
  } finally {
    state.planning = false;
    if (agentId) await stopAgent(agentId).catch(() => {});
  }
  return publish();
}

export async function removeProposal(id: string): Promise<PlanProgress> {
  const plan = await load();
  plan.proposals = plan.proposals.filter((p) => p.id !== id);
  await save(plan);
  return publish();
}

export async function setProposalDeepLink(id: string, deepLink: string): Promise<PlanProgress> {
  const plan = await load();
  plan.proposals = plan.proposals.map((p) =>
    p.id === id
      ? {
          ...p,
          route: { ...(p.route ?? { steps: [] }), appId: p.route?.appId ?? plan.appId, deepLink: deepLink.trim() || undefined },
        }
      : p,
  );
  await save(plan);
  return publish();
}

export async function clearPlan(): Promise<PlanProgress> {
  await save({ version: 1, proposals: [] });
  state.error = undefined;
  return publish();
}

/**
 * Turn a proposal into a goal: drive the reference there, capture it, queue it.
 * Fails loudly when the route cannot get there — a goal captured on the wrong
 * screen would have every target chasing the wrong thing.
 */
export async function captureProposal(input: {
  id: string;
  referenceDeviceId: string;
  referenceLabel: string;
  targets: ParityTarget[];
}): Promise<PlanProgress> {
  if (state.capturingId) throw new Error("a proposal is already being captured");
  if (!input.targets.length) throw new Error("add at least one target build before capturing a goal");
  const plan = await load();
  const proposal = plan.proposals.find((p) => p.id === input.id);
  if (!proposal) throw new Error("no such proposal");

  state.capturingId = input.id;
  state.error = undefined;
  await publish();

  const setError = async (message: string): Promise<void> => {
    const p = await load();
    p.proposals = p.proposals.map((x) => (x.id === input.id ? { ...x, error: message } : x));
    await save(p);
  };

  try {
    const route = proposal.route ?? (plan.appId ? { appId: plan.appId, steps: [] } : undefined);
    if (route && (route.deepLink || route.steps.length || route.appId)) {
      const r = await replayRoute(input.referenceDeviceId, route);
      if (!r.ok) throw new Error(`could not navigate the reference to "${proposal.name}": ${r.output}`);
    }

    const { bin, prefix, env } = await cli();
    const root = appState.projectRoot ?? process.cwd();
    const dir = path.join(root, ".conductor", "parity", `reference-plan-${Date.now()}`);
    const captured = await runCli(
      bin,
      [
        ...prefix,
        "checkpoint",
        proposal.name,
        "--run",
        dir,
        "--device",
        input.referenceDeviceId,
        "--label",
        input.referenceLabel,
        "--role",
        "reference",
      ],
      env,
    );
    if (captured.code !== 0) throw new Error(`could not capture "${proposal.name}": ${captured.output.trim()}`);

    const goal = await addGoal({
      checkpoint: proposal.name,
      referenceDir: dir,
      referenceLabel: input.referenceLabel,
      referenceDeviceId: input.referenceDeviceId,
      route,
      targets: input.targets,
    });

    const p = await load();
    p.proposals = p.proposals.map((x) => (x.id === input.id ? { ...x, goalId: goal.id, error: undefined } : x));
    await save(p);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    state.error = message;
    await setError(message);
  } finally {
    state.capturingId = undefined;
  }
  return publish();
}

/** For MCP callers: the plan without the run-state envelope. */
export async function listProposals(): Promise<PlanProposal[]> {
  return (await load()).proposals;
}
