/**
 * Installs @houwert/conductor into `native/conductor/` as a self-contained
 * directory that electron-builder can bundle into the packaged app.
 *
 * Uses `npm install` (not pnpm) to create a flat node_modules layout with all
 * transitive dependencies resolved — no pnpm virtual store gymnastics needed.
 *
 * Run via: pnpm prepare-conductor
 * Also runs as part of `postinstall` and ahead of every `dist*` script.
 *
 * The `native/conductor/` directory is gitignored.
 *
 * ## Why a published version and not the workspace CLI
 *
 * The published package deliberately ships no `drivers/` — the CLI downloads
 * `drivers.tar.gz` from its own release tag at runtime. A workspace build
 * carries an unreleased version whose tag doesn't exist yet, so its drivers
 * would 404. Pinning a released version keeps that download resolvable.
 *
 * ## Local development against an unpublished conductor
 *
 * Set `CONDUCTOR_LOCAL` to a path (absolute, or relative to this app's
 * directory) pointing at a local conductor CLI package — in this monorepo
 * that's `../../packages/cli`. It's installed via `npm install <dir>` so all
 * transitive deps resolve normally. Local-mode installs bypass the version
 * cache so rebuilds are always picked up.
 *
 * Run `make build` at the repo root first: an unreleased local version has no
 * GitHub release to download drivers from, so the script links
 * `packages/cli/drivers/` into the installed tree instead.
 */

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { registryInstallArgs, writeShim } from "../electron/services/conductor/install";

// ---------------------------------------------------------------------------
// Configuration — bump this when upgrading conductor
// ---------------------------------------------------------------------------

const CONDUCTOR_VERSION = "0.28.0";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "native", "conductor");
const VERSION_FILE = path.join(OUT, ".version");

function log(message: string): void {
  console.log(`[prepare-conductor] ${message}`);
}

function resolveLocalPath(raw: string): string {
  const expanded = raw.startsWith("~") ? path.join(process.env.HOME ?? "", raw.slice(1)) : raw;
  const resolved = path.isAbsolute(expanded) ? expanded : path.resolve(ROOT, expanded);
  if (!existsSync(path.join(resolved, "package.json"))) {
    throw new Error(`CONDUCTOR_LOCAL path has no package.json: ${resolved}`);
  }
  return resolved;
}

function installFromRegistry(): void {
  if (existsSync(VERSION_FILE) && readFileSync(VERSION_FILE, "utf-8").trim() === CONDUCTOR_VERSION) {
    log(`native/conductor/ already at v${CONDUCTOR_VERSION}, skipping install`);
    writeShim(OUT);
    return;
  }

  log(`Installing conductor v${CONDUCTOR_VERSION} from registry into native/conductor/...`);
  mkdirSync(OUT, { recursive: true });

  // Same args the runtime provisioner uses — see electron/services/conductor/install.ts.
  execFileSync("npm", registryInstallArgs(CONDUCTOR_VERSION, OUT), {
    stdio: "inherit",
    cwd: ROOT,
    timeout: 120_000,
  });

  writeFileSync(VERSION_FILE, CONDUCTOR_VERSION);
  writeShim(OUT);
  log(`Done — native/conductor/ ready (v${CONDUCTOR_VERSION})`);
}

function installFromLocal(sourceDir: string): void {
  log(`Installing conductor from local path: ${sourceDir}`);
  mkdirSync(OUT, { recursive: true });

  // `npm install <dir>` copies the package into OUT/node_modules/@houwert/conductor
  // and resolves its dependencies flatly, just like the registry path — but it
  // skips the tarball fetch.
  execFileSync(
    "npm",
    [
      "install",
      sourceDir,
      "--prefix",
      OUT,
      "--ignore-scripts",
      "--no-package-lock",
      "--install-links=true", // copy instead of symlink so electron-builder bundles real files
    ],
    { stdio: "inherit", cwd: ROOT, timeout: 120_000 },
  );

  // `npm install <dir>` packs the source per its `files` field, which excludes
  // `drivers/` — the published CLI downloads those from its release tag at
  // runtime. An unreleased local version has no such tag, so link the locally
  // built drivers into the package root, where bootstrap.ts looks first.
  linkLocalDrivers(sourceDir);

  // Drop the version marker — local builds aren't version-locked, so the next
  // run should always reinstall to pick up source changes.
  rmSync(VERSION_FILE, { force: true });
  writeShim(OUT);
  log(`Done — native/conductor/ ready (local: ${sourceDir})`);
}

/**
 * Symlink (not copy) so driver rebuilds are picked up without re-running this.
 * Dev-only: a local-mode tree points outside the app and must not be packaged
 * for release — `dist:release` installs from the registry.
 */
function linkLocalDrivers(sourceDir: string): void {
  const source = path.join(sourceDir, "drivers");
  if (!existsSync(source)) {
    log("No drivers/ in the local checkout — run `make build` at the repo root, or device commands will fail.");
    return;
  }
  const target = path.join(OUT, "node_modules", "@houwert", "conductor", "drivers");
  try {
    if (lstatSync(target, { throwIfNoEntry: false })) rmSync(target, { recursive: true, force: true });
    symlinkSync(source, target, "dir");
    log(`Linked local drivers: ${target} -> ${source}`);
  } catch (e) {
    log(`Could not link local drivers: ${(e as Error).message}`);
  }
}

function main(): void {
  const local = process.env.CONDUCTOR_LOCAL?.trim();
  if (local) {
    installFromLocal(resolveLocalPath(local));
    return;
  }
  installFromRegistry();
}

main();
