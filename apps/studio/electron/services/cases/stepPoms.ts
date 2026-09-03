import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { studioDir } from "../util/studioPaths";
import type { StepPomCall } from "./model";

/**
 * Which page objects perform each step of a case. Qase has no concept of it and
 * the flow has no place for it, so Studio keeps it: `<case ref>` -> step key ->
 * the page objects and their env, in the order they run.
 *
 * Keyed by Qase's per-step `hash` where there is one, falling back to the step
 * index — the hash is stable across edits, the index is not, which is the only
 * assignment a case rewrite can lose.
 */

export type StepPomsByCase = Record<string, Record<string, StepPomCall[]>>;

/** What the file held before a step could name more than one page object. */
export type Stored = StepPomCall[] | { pom?: string; env?: Record<string, string> };

function file(): string {
  return path.join(studioDir("automation"), "step-poms.json");
}

/** Reads both shapes: the current list, and the single `{pom, env}` it replaced. */
export function normalizeStepPoms(stored: Stored): StepPomCall[] {
  const calls = Array.isArray(stored) ? stored : stored.pom ? [stored as StepPomCall] : [];
  return calls.filter((call) => call?.pom);
}

export async function stepPoms(): Promise<StepPomsByCase> {
  const target = file();
  if (!existsSync(target)) return {};
  let raw: Record<string, Record<string, Stored>>;
  try {
    raw = JSON.parse(await readFile(target, "utf8")) as Record<string, Record<string, Stored>>;
  } catch {
    return {};
  }
  const all: StepPomsByCase = {};
  for (const [ref, steps] of Object.entries(raw ?? {})) {
    const forCase: Record<string, StepPomCall[]> = {};
    for (const [stepKey, stored] of Object.entries(steps ?? {})) {
      const calls = normalizeStepPoms(stored);
      if (calls.length) forCase[stepKey] = calls;
    }
    if (Object.keys(forCase).length) all[ref] = forCase;
  }
  return all;
}

export async function setStepPoms(
  ref: string,
  stepKey: string,
  calls: StepPomCall[],
): Promise<StepPomsByCase> {
  const all = await stepPoms();
  const forCase = { ...(all[ref] ?? {}) };
  const kept = calls.filter((call) => call?.pom);
  if (kept.length) forCase[stepKey] = kept;
  else delete forCase[stepKey];

  if (Object.keys(forCase).length) all[ref] = forCase;
  else delete all[ref];

  const target = file();
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(all, null, 2), "utf8");
  return all;
}
