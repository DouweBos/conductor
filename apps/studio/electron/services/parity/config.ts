/**
 * Per-project parity configuration: the build recipe for each target.
 *
 * Lives in the project at `.conductor/parity/config.json` rather than in
 * Studio's own settings, because it describes the *project* — how to build its
 * tvOS app is true for everyone who checks the repo out, not just this machine.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ParityProjectConfig, TargetRecipe } from "../../../app/lib/types";
import { appState } from "../../state";

function configPath(): string {
  const root = appState.projectRoot ?? process.cwd();
  return path.join(root, ".conductor", "parity", "config.json");
}

const EMPTY: ParityProjectConfig = { version: 1, recipes: {} };

export async function loadParityConfig(): Promise<ParityProjectConfig> {
  try {
    const parsed = JSON.parse(await readFile(configPath(), "utf-8")) as ParityProjectConfig;
    return { version: 1, recipes: parsed.recipes ?? {} };
  } catch {
    return { ...EMPTY, recipes: {} };
  }
}

export async function saveParityConfig(config: ParityProjectConfig): Promise<void> {
  const file = configPath();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

export async function getRecipe(label: string): Promise<TargetRecipe | undefined> {
  return (await loadParityConfig()).recipes[label];
}

export async function putRecipe(recipe: TargetRecipe): Promise<ParityProjectConfig> {
  const config = await loadParityConfig();
  config.recipes[recipe.label] = normalise(recipe);
  await saveParityConfig(config);
  return config;
}

export async function deleteRecipe(label: string): Promise<ParityProjectConfig> {
  const config = await loadParityConfig();
  delete config.recipes[label];
  await saveParityConfig(config);
  return config;
}

/** Drop empty commands so an unfilled form field doesn't become a step that runs "". */
export function normalise(recipe: TargetRecipe): TargetRecipe {
  const clean = (c?: { command: string; cwd?: string; timeoutMs?: number }) =>
    c && c.command.trim()
      ? {
          command: c.command.trim(),
          ...(c.cwd?.trim() ? { cwd: c.cwd.trim() } : {}),
          ...(c.timeoutMs ? { timeoutMs: c.timeoutMs } : {}),
        }
      : undefined;
  return {
    label: recipe.label,
    platform: recipe.platform,
    ...(recipe.appId?.trim() ? { appId: recipe.appId.trim() } : {}),
    ...(recipe.sourceDir?.trim() ? { sourceDir: recipe.sourceDir.trim() } : {}),
    ...(clean(recipe.build) ? { build: clean(recipe.build) } : {}),
    ...(clean(recipe.reload) ? { reload: clean(recipe.reload) } : {}),
    ...(clean(recipe.install) ? { install: clean(recipe.install) } : {}),
    ...(clean(recipe.test) ? { test: clean(recipe.test) } : {}),
  };
}
