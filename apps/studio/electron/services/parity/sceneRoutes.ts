/**
 * Turning what the scene graph recorded into a route the loop can replay.
 *
 * The graph's edges carry the action Studio performed, in the wording
 * `conductorService` writes to `appState.lastAction`. Most of that is
 * mechanical and replays exactly; a text selector (`tapOn: "Login"`) is not a
 * coordinate and cannot be replayed blind, so a route containing one is
 * reported as not replayable rather than replayed wrong. Typed text was
 * recorded truncated to 24 characters, so it is replayed with a warning.
 */
import type { Route, RouteStep } from "../../../app/lib/types";
import type { FoundPath } from "../scenegraph/graph";

export interface ParsedAction {
  step?: RouteStep;
  /** Set when the action starts the app; becomes the route's appId. */
  appId?: string;
  /** Why it couldn't be turned into a step, when it couldn't. */
  reason?: string;
}

export function actionToStep(action: string): ParsedAction {
  const a = action.trim();

  let m = /^launchApp:\s*(.+)$/.exec(a);
  if (m) return { appId: m[1].trim() };

  m = /^tapOn:\s*point\s+([\d.]+),([\d.]+)$/.exec(a);
  if (m) return { step: { kind: "tap", x: Number(m[1]), y: Number(m[2]) } };

  m = /^swipe\s+([\d.]+),([\d.]+)\s*(?:→|->)\s*([\d.]+),([\d.]+)$/.exec(a);
  if (m) {
    return {
      step: { kind: "swipe", x1: Number(m[1]), y1: Number(m[2]), x2: Number(m[3]), y2: Number(m[4]) },
    };
  }

  m = /^pressKey:\s*(.+)$/.exec(a);
  if (m) return { step: { kind: "key", key: m[1].trim() } };

  m = /^inputText:\s*"(.*)"$/.exec(a);
  if (m) {
    const text = m[1];
    return {
      step: { kind: "text", text },
      ...(text.length >= 24 ? { reason: `typed text was recorded truncated: "${text}"` } : {}),
    };
  }

  return { reason: `not replayable from the graph: ${a}` };
}

export interface GraphRoute {
  route: Route;
  /** False when any step could not be turned into a replayable input. */
  replayable: boolean;
  unreplayable: string[];
}

/** A route from a found path. Launch actions become the route's app, not a step. */
export function routeFromPath(found: FoundPath, appId?: string): GraphRoute {
  const steps: RouteStep[] = [];
  const unreplayable: string[] = [];
  let app = appId;
  for (const s of found.steps) {
    const parsed = actionToStep(s.action);
    if (parsed.appId) {
      app = parsed.appId;
      continue;
    }
    if (parsed.step) steps.push(parsed.step);
    if (parsed.reason) unreplayable.push(parsed.reason);
    if (!parsed.step && !parsed.appId) continue;
  }
  const hard = unreplayable.filter((r) => r.startsWith("not replayable"));
  return {
    route: { appId: app, steps },
    replayable: hard.length === 0,
    unreplayable,
  };
}
