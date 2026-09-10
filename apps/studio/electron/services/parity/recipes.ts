/**
 * Running a target's recipe: rebuild, relaunch, replay the route, run tests.
 *
 * These are the steps the loop used to hand to the agent with "rebuild / reload
 * and navigate back". They are mechanical, they are the least reliable part of
 * a round when a model does them, and they set the wall clock that every other
 * cost multiplies — so the loop runs them itself and the agent only edits code.
 */
import { spawn } from "node:child_process";
import path from "node:path";

import type { RecipeCommand, RecipeStepResult, Route, RouteStep, TargetRecipe } from "../../../app/lib/types";
import { appState } from "../../state";
import { inputText, launchApp, pressKey, swipe, tap } from "../conductor/conductorService";
import { describeStep } from "./routes";

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
/** Output kept per step — enough to see why a build failed, not the whole log. */
const OUTPUT_TAIL = 4_000;
/** Gap between replayed inputs, so a transition can land before the next one. */
const STEP_GAP_MS = 350;
const DEFAULT_SETTLE_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function tail(s: string): string {
  return s.length > OUTPUT_TAIL ? `…${s.slice(-OUTPUT_TAIL)}` : s;
}

/** Run one shell command from the recipe. Never throws; the result says. */
export function runRecipeCommand(
  cmd: RecipeCommand,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: boolean; durationMs: number; output: string }> {
  const root = appState.projectRoot ?? process.cwd();
  const cwd = cmd.cwd ? path.resolve(root, cmd.cwd) : root;
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", cmd.command], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout?.on("data", (c: Buffer) => (output += c.toString()));
    child.stderr?.on("data", (c: Buffer) => (output += c.toString()));
    const timer = setTimeout(() => {
      output += `\n[timed out after ${cmd.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms]`;
      child.kill("SIGKILL");
    }, cmd.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, durationMs: Date.now() - started, output: tail(output) });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, durationMs: Date.now() - started, output: err.message });
    });
  });
}

/** Play a recorded route on a device, from a fresh launch when the route names an app. */
export async function replayRoute(deviceId: string, route: Route): Promise<RecipeStepResult> {
  const started = Date.now();
  const log: string[] = [];
  try {
    if (route.deepLink) {
      await launchApp(deviceId, route.appId, route.deepLink);
      log.push(`opened ${route.deepLink}`);
    } else if (route.appId) {
      await launchApp(deviceId, route.appId);
      log.push(`launched ${route.appId}`);
    }
    await sleep(route.settleMs ?? DEFAULT_SETTLE_MS);

    for (const [i, step] of route.steps.entries()) {
      switch (step.kind) {
        case "tap":
          await tap(deviceId, step.x, step.y);
          break;
        case "swipe":
          await swipe(deviceId, step.x1, step.y1, step.x2, step.y2);
          break;
        case "key":
          await pressKey(deviceId, step.key);
          break;
        case "text":
          await inputText(deviceId, step.text);
          break;
      }
      log.push(`${i + 1}. ${describeStep(step)}`);
      await sleep(STEP_GAP_MS);
    }
    return { step: "route", ok: true, durationMs: Date.now() - started, output: log.join("\n") };
  } catch (err) {
    log.push(`failed: ${err instanceof Error ? err.message : String(err)}`);
    return { step: "route", ok: false, durationMs: Date.now() - started, output: log.join("\n") };
  }
}

/** Send one input to a device and report it as a step, for interaction parity. */
export async function sendStep(deviceId: string, step: RouteStep): Promise<RecipeStepResult> {
  const started = Date.now();
  try {
    switch (step.kind) {
      case "tap":
        await tap(deviceId, step.x, step.y);
        break;
      case "swipe":
        await swipe(deviceId, step.x1, step.y1, step.x2, step.y2);
        break;
      case "key":
        await pressKey(deviceId, step.key);
        break;
      case "text":
        await inputText(deviceId, step.text);
        break;
    }
    await sleep(STEP_GAP_MS);
    return { step: "route", ok: true, durationMs: Date.now() - started, output: describeStep(step) };
  } catch (err) {
    return {
      step: "route",
      ok: false,
      durationMs: Date.now() - started,
      output: `${describeStep(step)} failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export interface PrepareOptions {
  /** Prefer the recipe's `reload` over a full `build` when both exist. */
  preferReload?: boolean;
}

/**
 * Get a target from "the agent just edited the source" to "the app is running,
 * on the screen, ready to be measured".
 *
 * Order: reload-or-build → install → launch+route. Stops at the first failure
 * and reports it, because measuring a screen after a failed build scores the
 * *old* build and the trend would lie. Each step's tail of output rides along
 * so the brief can show the agent a compile error verbatim.
 */
export async function prepareTarget(
  deviceId: string,
  recipe: TargetRecipe | undefined,
  route: Route | undefined,
  opts: PrepareOptions = {},
): Promise<{ ok: boolean; steps: RecipeStepResult[] }> {
  const steps: RecipeStepResult[] = [];

  const runStep = async (
    name: RecipeStepResult["step"],
    cmd: RecipeCommand | undefined,
  ): Promise<boolean> => {
    if (!cmd) return true;
    const r = await runRecipeCommand(cmd);
    steps.push({ step: name, ...r });
    return r.ok;
  };

  if (recipe) {
    const useReload = opts.preferReload !== false && recipe.reload;
    if (useReload) {
      if (!(await runStep("reload", recipe.reload))) return { ok: false, steps };
    } else if (!(await runStep("build", recipe.build))) {
      return { ok: false, steps };
    }
    if (!(await runStep("install", recipe.install))) return { ok: false, steps };
  }

  // Re-navigation. A route that names an app relaunches it first, which is the
  // only way to get a rebuilt binary on screen; one without an app assumes the
  // recipe's install/launch step already did that, or a reload kept it alive.
  const effectiveRoute: Route | undefined = route ?? (recipe?.appId ? { appId: recipe.appId, steps: [] } : undefined);
  if (effectiveRoute) {
    const withApp = effectiveRoute.appId ? effectiveRoute : { ...effectiveRoute, appId: recipe?.appId };
    const r = await replayRoute(deviceId, withApp);
    steps.push(r);
    if (!r.ok) return { ok: false, steps };
  }

  return { ok: true, steps };
}

/** Run the target's own tests. Absent recipe → vacuously passing, and says so. */
export async function runTargetTests(
  recipe: TargetRecipe | undefined,
): Promise<{ passed: boolean; output: string; step?: RecipeStepResult }> {
  if (!recipe?.test) return { passed: true, output: "(no test recipe)" };
  const r = await runRecipeCommand(recipe.test);
  return { passed: r.ok, output: r.output, step: { step: "test", ...r } };
}
