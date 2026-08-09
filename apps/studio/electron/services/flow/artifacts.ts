import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { RunArtifacts, RunArtifactStep } from "../../../app/lib/types";

/**
 * Maestro's own debug output, which is where a failure actually explains itself.
 * Each run writes `~/.maestro/tests/<timestamp>/<flow>/` holding `commands.json`
 * (every executed command and its status), a screenshot per step, the screen
 * hierarchy at each step, and device logs. Studio reads that rather than
 * re-deriving anything from stdout.
 */

const TESTS_DIR = path.join(homedir(), ".maestro", "tests");

/** The newest run directory written at or after `since`. */
export function findRunDir(since: number): string | null {
  if (!existsSync(TESTS_DIR)) return null;
  let best: { dir: string; at: number } | null = null;
  for (const name of readdirSync(TESTS_DIR)) {
    const dir = path.join(TESTS_DIR, name);
    let at: number;
    try {
      const stat = statSync(dir);
      if (!stat.isDirectory()) continue;
      at = stat.mtimeMs;
    } catch {
      continue;
    }
    // A second of slack: the directory is stamped when maestro starts.
    if (at + 1000 < since) continue;
    if (!best || at > best.at) best = { dir, at };
  }
  return best?.dir ?? null;
}

export function readArtifacts(runDir: string): RunArtifacts | null {
  if (!existsSync(runDir)) return null;
  const flowDirs = readdirSync(runDir).filter((name) => {
    const full = path.join(runDir, name);
    return statSync(full).isDirectory() && existsSync(path.join(full, "commands.json"));
  });
  if (flowDirs.length === 0) return null;

  // One flow per run in Studio; if maestro sharded, the first is the one we ran.
  const flowDir = path.join(runDir, flowDirs[0]);
  return {
    dir: flowDir,
    flowName: flowDirs[0],
    steps: readSteps(flowDir),
    logs: readdirSync(path.join(flowDir, "logs"), { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(flowDir, "logs", entry.name)),
  };
}

function readSteps(flowDir: string): RunArtifactStep[] {
  let commands: unknown;
  try {
    commands = JSON.parse(readFileSync(path.join(flowDir, "commands.json"), "utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(commands)) return [];

  const screenshots = listStepFiles(path.join(flowDir, "screenshots"));
  const hierarchies = listStepFiles(path.join(flowDir, "screen-hierarchy"));

  return commands.map((entry, index) => {
    const record = entry as { command?: Record<string, unknown>; metadata?: Record<string, unknown> };
    const kind = Object.keys(record.command ?? {})[0] ?? "command";
    const body = (record.command?.[kind] ?? {}) as Record<string, unknown>;
    const sequence = Number(record.metadata?.sequenceNumber ?? index);
    // Artifacts are numbered from 1, commands from 0.
    const step = sequence + 1;
    return {
      index: sequence,
      label: describe(kind, body),
      status: String(record.metadata?.status ?? "UNKNOWN"),
      durationMs: Number(record.metadata?.duration ?? 0) || undefined,
      screenshot: screenshots.get(step),
      hierarchy: hierarchies.get(step),
    };
  });
}

/** `step-004-assertCondition-NoSuchElementXYZ.png` -> 4. */
function listStepFiles(dir: string): Map<number, string> {
  const out = new Map<number, string>();
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const match = /^step-(\d+)/.exec(name);
    if (match) out.set(Number(match[1]), path.join(dir, name));
  }
  return out;
}

/**
 * A readable name for a command out of its JSON shape. The interesting part is
 * the selector, which sits at a different depth per command (`assertCondition`
 * nests it under `condition.visible`), so search rather than guess.
 */
const NAMING_KEYS = ["textRegex", "idRegex", "text", "id", "appId", "link", "path", "key"];
/** `runFlow` inlines its subflow, so don't go looking for a name inside it. */
const OPAQUE_KEYS = new Set(["commands", "config", "script", "env"]);

function describe(kind: string, body: Record<string, unknown>): string {
  const name = kind.replace(/Command$/, "");
  const detail = findNaming(body, 3);
  return detail ? `${name} "${detail}"` : name;
}

function findNaming(value: unknown, depth: number): string | undefined {
  if (!value || typeof value !== "object" || depth < 0) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of NAMING_KEYS) {
    const found = firstString(record[key]);
    if (found) return found;
  }
  for (const [key, nested] of Object.entries(record)) {
    if (OPAQUE_KEYS.has(key)) continue;
    const found = findNaming(nested, depth - 1);
    if (found) return found;
  }
  return undefined;
}

function firstString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
