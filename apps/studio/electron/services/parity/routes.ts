/**
 * Route helpers with no Electron or conductor imports, so they can be unit
 * tested — the replayer that drives devices lives in recipes.ts.
 */
import type { Route, RouteStep } from "../../../app/lib/types";

export function describeStep(step: RouteStep): string {
  switch (step.kind) {
    case "tap":
      return `tap ${step.x.toFixed(3)},${step.y.toFixed(3)}`;
    case "swipe":
      return `swipe ${step.x1.toFixed(2)},${step.y1.toFixed(2)} → ${step.x2.toFixed(2)},${step.y2.toFixed(2)}`;
    case "key":
      return `press ${step.key}`;
    case "text":
      return `type "${step.text}"`;
  }
}

/** One line per step, for a log or a brief. */
export function describeRoute(route: Route): string {
  const head = route.deepLink
    ? `open ${route.deepLink}`
    : route.appId
      ? `launch ${route.appId}`
      : "(no launch)";
  return [head, ...route.steps.map((s, i) => `${i + 1}. ${describeStep(s)}`)].join("\n");
}
