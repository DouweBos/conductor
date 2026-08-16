import { existsSync } from "node:fs";

import { getConductorBinPath, getConductorEntry } from "../conductor/paths";
import { getActiveConductorOverrideDir } from "../conductor/override";
import { run, which } from "../util/exec";

export interface ResolvedBin {
  /** The executable to spawn. */
  bin: string;
  /** Args to prepend (the CLI's JS entry, run under Electron-as-Node). */
  prefixArgs: string[];
  /** Whether this is the tree shipped with the app or a version the user pinned. */
  source: "bundled" | "override";
  /** Env the CLI must run under — always pass this when spawning it. */
  env: NodeJS.ProcessEnv;
  /** The `bin/conductor` shim — an executable an agent can run from a shell. */
  shim: string;
}

/**
 * Resolve the conductor CLI from the tree Studio ships (or the version the
 * user pinned in Settings). There is no PATH lookup: a globally installed
 * conductor of some unrelated version is exactly what bundling is meant to
 * avoid. Point `CONDUCTOR_LOCAL` at a checkout and re-run
 * `pnpm prepare-conductor` to develop against unpublished changes.
 *
 * Not cached — the active tree changes when the user pins a version, and the
 * indirection is two path joins.
 */
export async function resolveConductor(): Promise<ResolvedBin | null> {
  const entry = getConductorEntry();
  if (!existsSync(entry)) return null;

  return {
    // process.execPath is Electron — without ELECTRON_RUN_AS_NODE it boots a
    // second Electron app instead of running the CLI script under Node.
    bin: process.execPath,
    prefixArgs: [entry],
    source: getActiveConductorOverrideDir() ? "override" : "bundled",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    shim: getConductorBinPath(),
  };
}

async function version(resolved: ResolvedBin): Promise<string | undefined> {
  try {
    const res = await run(resolved.bin, [...resolved.prefixArgs, "--version"], {
      timeout: 8000,
      env: resolved.env,
    });
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
