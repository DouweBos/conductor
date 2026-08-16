/**
 * Runtime conductor version override.
 *
 * Lets a user pin a conductor version from Settings and have Studio install it
 * into `<userData>/conductor/<version>/` on demand — no app rebuild/release
 * required. When an override is active and installed, `paths.ts` points every
 * conductor invocation at that tree instead of the bundled one.
 *
 * Main is authoritative: the version is persisted at `<userData>/conductor.json`
 * — deliberately its own file rather than settings.json, so a corrupt settings
 * blob can't strand the app on an uninstallable version. Provisioning runs in
 * this process and requires `npm` on PATH — Electron's Node ships none — plus
 * registry access; failures fall back to the bundled version and surface a
 * status the Settings UI shows.
 */

import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ConductorStatus, ProvisionState } from "../../../app/lib/types";
import { broadcastToRenderers } from "../../broadcast";
import { getBundledConductorDir } from "./bundled";
import { VERSION_MARKER, registryInstallArgs, shimBinPath, writeShim } from "./install";

const execFileAsync = promisify(execFile);

/** Event emitted to renderers whenever the override status changes. */
export const CONDUCTOR_STATUS_EVENT = "conductor_status_changed";

const SCHEMA_VERSION = 1;
const INSTALL_TIMEOUT_MS = 120_000;

/** Loose semver check — enough to reject obvious garbage before hitting npm. */
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

interface ConductorConfigFile {
  version: number;
  overrideVersion: string | null;
}

// ---------------------------------------------------------------------------
// Paths + persistence
// ---------------------------------------------------------------------------

function configFilePath(): string {
  return path.join(app.getPath("userData"), "conductor.json");
}

/** Install tree for a given override version. */
function overrideDir(version: string): string {
  return path.join(app.getPath("userData"), "conductor", version);
}

function readMarker(dir: string): string | null {
  try {
    return fs.readFileSync(path.join(dir, VERSION_MARKER), "utf8").trim();
  } catch {
    return null;
  }
}

/** True when `<dir>` holds a complete install of `version` (marker + shim). */
function isInstalled(version: string): boolean {
  const dir = overrideDir(version);
  return readMarker(dir) === version && fs.existsSync(shimBinPath(dir));
}

function loadConfig(): ConductorConfigFile {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(configFilePath(), "utf8"),
    ) as Partial<ConductorConfigFile>;
    const v = parsed.overrideVersion;
    return {
      version: SCHEMA_VERSION,
      overrideVersion: typeof v === "string" && VERSION_RE.test(v) ? v : null,
    };
  } catch {
    return { version: SCHEMA_VERSION, overrideVersion: null };
  }
}

function saveConfig(cfg: ConductorConfigFile): void {
  const filePath = configFilePath();
  const tmp = `${filePath}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), "utf8");
    fs.renameSync(tmp, filePath);
  } catch (e) {
    console.error("[studio] failed to persist conductor.json:", e);
  }
}

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

/**
 * Directory the resolver should use, or null to fall back to the bundled tree.
 * Only set once an override version is fully installed, so a pending/failed
 * provision never breaks conductor invocations.
 */
let activeOverrideDir: string | null = null;
let overrideVersion: string | null = null;
let state: ProvisionState = "idle";
let error: string | null = null;

/**
 * The active override install dir, or null when the bundled conductor should
 * be used. Read synchronously on every invocation.
 */
export function getActiveConductorOverrideDir(): string | null {
  return activeOverrideDir;
}

/** Read the version baked into the bundled tree (its `.version` marker). */
export function readBundledVersion(): string | null {
  const dir = getBundledConductorDir();
  const marker = readMarker(dir);
  if (marker) return marker;
  // A CONDUCTOR_LOCAL build has no marker — read the installed package instead.
  try {
    const pkg = path.join(dir, "node_modules", "@houwert", "conductor", "package.json");
    return (JSON.parse(fs.readFileSync(pkg, "utf8")) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

export function getConductorStatus(): ConductorStatus {
  const bundledVersion = readBundledVersion();
  return {
    overrideVersion,
    activeVersion: overrideVersion && activeOverrideDir ? overrideVersion : bundledVersion,
    bundledVersion,
    state,
    error,
  };
}

function setState(next: ProvisionState, err: string | null = null): void {
  state = next;
  error = err;
  broadcastToRenderers(CONDUCTOR_STATUS_EVENT, getConductorStatus());
}

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

async function provision(version: string): Promise<void> {
  if (isInstalled(version)) {
    activeOverrideDir = overrideDir(version);
    setState("ready");
    return;
  }

  setState("installing");
  const dir = overrideDir(version);
  try {
    fs.mkdirSync(dir, { recursive: true });
    await execFileAsync("npm", registryInstallArgs(version, dir), {
      timeout: INSTALL_TIMEOUT_MS,
    });
    fs.writeFileSync(path.join(dir, VERSION_MARKER), version);
    writeShim(dir);

    // Config may have changed while npm ran — only activate if still current.
    if (overrideVersion === version) {
      activeOverrideDir = dir;
      setState("ready");
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const hint = /ENOENT|not found|spawn npm/i.test(message)
      ? "npm not found on PATH — install Node.js/npm to use a custom conductor version."
      : message;
    console.error(`[studio] failed to install conductor v${version}:`, message);
    if (overrideVersion === version) {
      activeOverrideDir = null; // fall back to bundled
      setState("error", hint);
    }
  }
}

/**
 * Set (or clear, with null) the pinned conductor version and provision it.
 * Returns the resulting status. Clearing reverts to the bundled version.
 */
export async function setConductorOverrideVersion(
  version: string | null,
): Promise<ConductorStatus> {
  const trimmed = version?.trim() || null;
  if (trimmed && !VERSION_RE.test(trimmed)) {
    throw new Error(`Invalid conductor version: ${trimmed}`);
  }

  overrideVersion = trimmed;
  saveConfig({ version: SCHEMA_VERSION, overrideVersion: trimmed });

  if (!trimmed) {
    activeOverrideDir = null;
    setState("idle");
    return getConductorStatus();
  }

  await provision(trimmed);
  return getConductorStatus();
}

/**
 * Load the persisted override on startup. If a version is pinned but not yet
 * installed, provisioning runs in the background — invocations use the bundled
 * version until it completes.
 */
export function initConductorOverride(): void {
  overrideVersion = loadConfig().overrideVersion;
  if (!overrideVersion) return;

  if (isInstalled(overrideVersion)) {
    activeOverrideDir = overrideDir(overrideVersion);
    setState("ready");
    return;
  }
  // Background provision; errors are captured in status, not thrown.
  void provision(overrideVersion);
}
