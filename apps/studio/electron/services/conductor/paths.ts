/**
 * Path helpers for the bundled conductor CLI.
 *
 * Studio ships a self-contained conductor tree:
 *
 * - **Packaged app:** `<resourcesPath>/conductor/`
 * - **Development:** `<app>/native/conductor/`
 *
 * Inside that tree, `bin/conductor` is a small Node shim written once by
 * `scripts/prepare-conductor.ts`. The shim resolves its entry point via
 * `__dirname`-relative lookup, so it works in both layouts — and in a runtime
 * override tree — without being rewritten.
 *
 * A version the user pinned in Settings (installed under
 * `<userData>/conductor/<version>/`) wins over the bundled tree.
 */

import { getBundledConductorDir } from "./bundled";
import { entryPath, shimBinPath } from "./install";
import { getActiveConductorOverrideDir } from "./override";

/** The tree conductor invocations should actually use. */
export function getConductorDir(): string {
  return getActiveConductorOverrideDir() ?? getBundledConductorDir();
}

/** The CLI's JS entry point in the active tree — what Studio spawns directly. */
export function getConductorEntry(): string {
  return entryPath(getConductorDir());
}

/** The shim in the active tree — an executable agents can run from a shell. */
export function getConductorBinPath(): string {
  return shimBinPath(getConductorDir());
}
