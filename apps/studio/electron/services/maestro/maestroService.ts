import { existsSync } from "node:fs";
import path from "node:path";

import { run, which } from "../util/exec";

export interface ResolvedBin {
  /** The executable to spawn. */
  bin: string;
  /** Args to prepend (e.g. the JS entry when running via `node`). */
  prefixArgs: string[];
  /** Where it was found, for display. */
  source: "path" | "workspace" | "env";
}

let conductorCache: ResolvedBin | null = null;

/**
 * Resolve the conductor CLI. Preference order:
 *   1. CONDUCTOR_BIN env override
 *   2. `conductor` on PATH (global install)
 *   3. the workspace build at packages/cli/dist/index.js (run via node)
 */
export async function resolveConductor(): Promise<ResolvedBin | null> {
  if (conductorCache) return conductorCache;

  const envBin = process.env.CONDUCTOR_BIN;
  if (envBin && existsSync(envBin)) {
    conductorCache = { bin: envBin, prefixArgs: [], source: "env" };
    return conductorCache;
  }

  const onPath = await which("conductor");
  if (onPath) {
    conductorCache = { bin: "conductor", prefixArgs: [], source: "path" };
    return conductorCache;
  }

  const workspaceEntry = findWorkspaceConductor();
  if (workspaceEntry) {
    conductorCache = { bin: process.execPath, prefixArgs: [workspaceEntry], source: "workspace" };
    return conductorCache;
  }

  return null;
}

function findWorkspaceConductor(): string | null {
  // Walk up from this module looking for packages/cli/dist/index.js.
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, "packages", "cli", "dist", "index.js");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

async function version(resolved: ResolvedBin): Promise<string | undefined> {
  try {
    const res = await run(resolved.bin, [...resolved.prefixArgs, "--version"], { timeout: 8000 });
    const out = (res.stdout || res.stderr).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

export async function detectConductor(): Promise<{ available: boolean; version?: string }> {
  const resolved = await resolveConductor();
  if (!resolved) return { available: false };
  return { available: true, version: await version(resolved) };
}

export async function detectMaestro(): Promise<{ available: boolean; version?: string }> {
  const onPath = await which("maestro");
  if (!onPath) return { available: false };
  try {
    const res = await run("maestro", ["--version"], { timeout: 8000 });
    return { available: true, version: (res.stdout || res.stderr).trim() || undefined };
  } catch {
    return { available: true };
  }
}
