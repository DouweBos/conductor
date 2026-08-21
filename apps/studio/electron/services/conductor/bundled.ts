/**
 * Where the conductor tree that ships with this build lives.
 *
 * Its own module so both `paths.ts` (which layers the user's override on top)
 * and `override.ts` (which reports the bundled version) can read it without
 * importing each other.
 *
 * - **Packaged app:** `<resourcesPath>/conductor/`, put there by the
 *   `afterPack` hook in `scripts/electron-after-pack.cjs`.
 * - **Development:** `<app>/native/conductor/`, from `pnpm prepare-conductor`.
 */

import { app } from "electron";
import path from "node:path";

export function getBundledConductorDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "conductor")
    : path.join(app.getAppPath(), "native", "conductor");
}
