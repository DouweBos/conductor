/**
 * The planner: which screens a port should be held to, and in what order.
 *
 * Helix runs against "a sequence of checkpoints"; someone has to write that
 * sequence. Two sources know the app's surface without a human listing it:
 * the scene graph Studio recorded while the reference was explored (every
 * screen seen, every transition that led there), and the reference's source
 * (its router, its screens directory), which an agent can read. The graph
 * gives screens with a replayable route; the agent gives screens nobody has
 * navigated to yet and the deep links its router defines. Both are proposals —
 * a person picks which become goals.
 *
 * Kept pure so ordering, merging and the agent's answer can be tested without
 * a graph on disk or an agent on PATH.
 */
import type { PlanProposal, SceneGraph } from "../../../app/lib/types";
import { findPath, SceneGraphIndex } from "../scenegraph/graph";
import { routeFromPath } from "./sceneRoutes";

/** A name that pairs across sources: case, spacing and punctuation folded. */
export function proposalKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Where a walk of the app starts. A launch edge names the screen the app
 * opens on; failing that, screens nothing leads to; failing that, the screen
 * most things lead out of. A graph with no edges makes every screen a root.
 */
export function rootsOf(graph: SceneGraph): { ids: string[]; appId?: string } {
  const launches = graph.edges.filter((e) => /^launchApp:\s*/i.test(e.action));
  const appId = launches[0]?.action.replace(/^launchApp:\s*/i, "").trim() || graph.app?.appId;
  const launched = [...new Set(launches.map((e) => e.to))].filter((id) => graph.nodes.some((n) => n.id === id));
  if (launched.length) return { ids: launched, appId };

  const incoming = new Set(graph.edges.map((e) => e.to));
  const orphans = graph.nodes.filter((n) => !incoming.has(n.id)).map((n) => n.id);
  if (orphans.length) return { ids: orphans, appId };

  let best: string | null = null;
  let bestOut = -1;
  for (const n of graph.nodes) {
    const out = graph.edges.filter((e) => e.from === n.id).length;
    if (out > bestOut) {
      bestOut = out;
      best = n.id;
    }
  }
  return { ids: best ? [best] : [], appId };
}

/**
 * Every recorded screen as a proposal, shallowest first — that *is* the
 * checkpoint sequence: the entry screen before what it leads to, so a port
 * that fails on the home screen fails there and not three screens in. A
 * screen no root reaches is still proposed, without a route; the agent
 * navigates to it, or a person gives it a deep link.
 */
export function proposeFromSceneGraph(graph: SceneGraph): PlanProposal[] {
  if (!graph.nodes.length) return [];
  const index = new SceneGraphIndex(graph);
  const { ids: roots, appId } = rootsOf(graph);

  const proposals: Array<PlanProposal & { depth: number }> = [];
  for (const node of graph.nodes) {
    let shortest: ReturnType<typeof findPath> = null;
    for (const root of roots) {
      const found = findPath(index, root, node.id);
      if (found && (!shortest || found.cost < shortest.cost)) shortest = found;
    }
    const inbound = index.edgesTo(node.id).length;
    const outbound = index.edgesFrom(node.id).length;
    const base: PlanProposal & { depth: number } = {
      id: `graph:${node.id}`,
      name: node.label,
      source: "scene-graph",
      rationale: `${inbound} way${inbound === 1 ? "" : "s"} in, ${outbound} out`,
      depth: shortest ? shortest.cost : Number.POSITIVE_INFINITY,
    };
    if (shortest) {
      const gr = routeFromPath(shortest, appId);
      base.route = gr.route;
      if (gr.unreplayable.length) base.unreplayable = gr.unreplayable;
      base.rationale = `${shortest.cost} step${shortest.cost === 1 ? "" : "s"} from launch · ${base.rationale}`;
    } else {
      base.rationale = `not reached from launch in the recorded graph · ${base.rationale}`;
    }
    proposals.push(base);
  }

  proposals.sort((a, b) => a.depth - b.depth || a.name.localeCompare(b.name));
  return proposals.map(({ depth: _d, ...p }) => p);
}

/**
 * What the planner agent is asked. It reads the reference's source — the
 * router, the screens — and answers with JSON, because its answer is data
 * the plan merges, not prose a person reads. Screens the graph already knows
 * are listed so the agent names them the same way and adds what is missing,
 * rather than re-listing the graph in its own words.
 */
export interface PlannerBriefInput {
  sourceDir: string;
  appId?: string;
  platform?: string;
  known: Array<{ name: string; route?: string }>;
}

export function buildPlannerBrief(input: PlannerBriefInput): string {
  const known = input.known.length
    ? input.known.map((k) => `- ${k.name}${k.route ? ` (${k.route})` : ""}`).join("\n")
    : "- (none recorded yet)";
  return [
    `You are planning a port. A reference app${input.appId ? ` (${input.appId}` + (input.platform ? `, ${input.platform}` : "") + ")" : ""} is being rebuilt on other platforms, and each of its screens will become a parity goal: the rebuilt apps are held to the reference screen until the accessibility diff says they match.`,
    "",
    `Read the reference's source at: ${input.sourceDir}`,
    "Find its screens: the router or navigator, the screens/pages/views directory, deep-link or URL scheme definitions. Do not build or run anything. Do not modify files.",
    "",
    "Screens Studio has already recorded while the app was explored (name them the same way when you mean the same screen):",
    known,
    "",
    "Answer with ONE JSON object in a ```json fence, and nothing else after it:",
    "```json",
    '{ "screens": [',
    '  { "name": "Home", "rationale": "entry screen; the row component every other screen reuses", "deepLink": "myapp://home" },',
    '  { "name": "Detail", "rationale": "reached from every row; the focus model lives here" }',
    "] }",
    "```",
    "",
    "Rules for the list:",
    "- Order it as a port should tackle it: the entry screen first, shallow before deep, screens that define shared components before the screens that only use them.",
    "- One entry per distinct screen. Skip modals and toasts unless they are a screen of their own. Skip screens that need an account state you cannot describe.",
    "- `deepLink` only when the router actually defines one — a made-up link wastes a round. Omit it otherwise.",
    "- `rationale` is one sentence: why this screen, and what in the rebuilt apps it will exercise.",
  ].join("\n");
}

export interface ParsedPlannerAnswer {
  proposals: PlanProposal[];
  error?: string;
}

interface PlannerScreen {
  name?: unknown;
  rationale?: unknown;
  deepLink?: unknown;
}

/**
 * Read the agent's answer. The last fenced JSON block wins — a planner that
 * thinks aloud and then answers is read by its answer. No JSON at all is
 * reported as such rather than guessed from prose.
 */
export function parsePlannerAnswer(text: string, appId?: string): ParsedPlannerAnswer {
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1].trim());
  const candidates = fences.length ? [fences[fences.length - 1]] : [];
  if (!candidates.length) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  }
  let parsed: unknown = null;
  for (const c of candidates) {
    try {
      parsed = JSON.parse(c);
      break;
    } catch {
      // try the next candidate
    }
  }
  if (parsed === null) return { proposals: [], error: "the planner gave no JSON answer" };

  const screens = Array.isArray(parsed)
    ? (parsed as PlannerScreen[])
    : Array.isArray((parsed as { screens?: unknown }).screens)
      ? ((parsed as { screens: PlannerScreen[] }).screens)
      : null;
  if (!screens) return { proposals: [], error: 'the planner\'s JSON has no "screens" list' };

  const seen = new Set<string>();
  const proposals: PlanProposal[] = [];
  for (const s of screens) {
    const name = typeof s.name === "string" ? s.name.trim() : "";
    if (!name) continue;
    const key = proposalKey(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const deepLink = typeof s.deepLink === "string" && s.deepLink.trim() ? s.deepLink.trim() : undefined;
    proposals.push({
      id: `agent:${key.replace(/\s+/g, "-")}`,
      name,
      source: "agent",
      rationale: typeof s.rationale === "string" ? s.rationale.trim() || undefined : undefined,
      route: deepLink ? { appId, deepLink, steps: [] } : undefined,
    });
  }
  if (!proposals.length) return { proposals, error: "the planner listed no screens" };
  return { proposals };
}

/**
 * Fold new proposals into the plan. Screens pair by name. An existing entry
 * keeps its identity and anything the loop already did with it (the goal it
 * became, the error it hit); it gains a route or rationale it lacked. Order:
 * existing entries stay where they are, new ones append in the order given —
 * re-planning never shuffles what a person has already looked at.
 */
export function mergeProposals(existing: PlanProposal[], incoming: PlanProposal[]): PlanProposal[] {
  const byKey = new Map(existing.map((p) => [proposalKey(p.name), p] as const));
  const out = [...existing];
  for (const inc of incoming) {
    const key = proposalKey(inc.name);
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, inc);
      out.push(inc);
      continue;
    }
    const route = pickRoute(prev.route, inc.route);
    const merged: PlanProposal = {
      ...prev,
      route,
      rationale: prev.rationale && inc.rationale && prev.rationale !== inc.rationale
        ? `${prev.rationale} · ${inc.rationale}`
        : (prev.rationale ?? inc.rationale),
      unreplayable: route === inc.route ? inc.unreplayable : prev.unreplayable,
      source: prev.source === "scene-graph" || inc.source === "scene-graph" ? "scene-graph" : "agent",
    };
    if (!merged.rationale) delete merged.rationale;
    if (!merged.unreplayable?.length) delete merged.unreplayable;
    if (!merged.route) delete merged.route;
    const at = out.findIndex((p) => p.id === prev.id);
    out[at] = merged;
    byKey.set(key, merged);
  }
  return out;
}

/** A deep link beats replayed steps; steps beat nothing; a bare launch beats nothing. */
function pickRoute(a: PlanProposal["route"], b: PlanProposal["route"]): PlanProposal["route"] {
  const score = (r: PlanProposal["route"]): number =>
    !r ? 0 : r.deepLink ? 3 : r.steps.length ? 2 : r.appId ? 1 : 0;
  return score(b) > score(a) ? b : a;
}
