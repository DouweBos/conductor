import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { studioDir } from "../util/studioPaths";

/**
 * Which page object performs each step of a case. Qase has no concept of it and
 * the flow has no place for it, so Studio keeps it: `<case ref>` -> step key ->
 * the page object and its env.
 *
 * Keyed by Qase's per-step `hash` where there is one, falling back to the step
 * index — the hash is stable across edits, the index is not, which is the only
 * assignment a case rewrite can lose.
 */

export interface StepPom {
  pom?: string;
  env?: Record<string, string>;
}

export type StepPomsByCase = Record<string, Record<string, StepPom>>;

function file(): string {
  return path.join(studioDir("automation"), "step-poms.json");
}

export async function stepPoms(): Promise<StepPomsByCase> {
  const target = file();
  if (!existsSync(target)) return {};
  try {
    return JSON.parse(await readFile(target, "utf8")) as StepPomsByCase;
  } catch {
    return {};
  }
}

export async function setStepPom(
  ref: string,
  stepKey: string,
  assignment: StepPom | null,
): Promise<StepPomsByCase> {
  const all = await stepPoms();
  const forCase = { ...(all[ref] ?? {}) };
  if (!assignment?.pom) delete forCase[stepKey];
  else forCase[stepKey] = assignment;

  if (Object.keys(forCase).length) all[ref] = forCase;
  else delete all[ref];

  const target = file();
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(all, null, 2), "utf8");
  return all;
}
