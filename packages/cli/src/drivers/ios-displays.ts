/**
 * Which panel to capture on a multi-display device.
 *
 * Foldables (iPhone Duo) have two integrated panels, and the one the system is
 * driving changes as the device folds. `XCUIScreen.main` — what the test driver
 * screenshots — is always the *primary* (cover) panel, so on an unfolded device
 * it captures a powered-off screen: a black image, with no error to explain it.
 */
import type { DeviceDisplay } from './devicectl.js';

/**
 * Roles, which mean the same thing on any platform that grows a foldable.
 * Everything else is addressed by display id: a device's own class and panel
 * names (integrated/carPlay, LCD-1) are platform vocabulary that wouldn't carry
 * over to Android, and every display it could name already has an id. Unknown
 * values list the device's displays so the ids are discoverable.
 */
const ROLE_ALIASES: Record<string, 'primary' | 'secondary'> = {
  cover: 'primary',
  main: 'primary',
  primary: 'primary',
  inner: 'secondary',
  secondary: 'secondary',
};

export interface DisplayChoice {
  /** Display to capture, or null to use the driver's own screenshot. */
  displayId: number | null;
  /** Set when the requested panel could not be resolved. */
  error?: string;
}

/**
 * Pick the display to capture. With no override this is whichever panel is
 * live, which keeps screenshots working across a fold without the caller
 * having to think about it. Returns null for ordinary single-display devices
 * so they keep using the driver path untouched.
 */
export function pickCaptureDisplay(displays: DeviceDisplay[], override?: string): DisplayChoice {
  const integrated = displays.filter((d) => d.integrated);

  if (override) {
    const key = override.trim().toLowerCase();

    const id = Number(key);
    if (Number.isInteger(id) && displays.some((d) => d.displayId === id)) {
      return { displayId: id };
    }

    const role = ROLE_ALIASES[key];
    if (role) {
      const match =
        role === 'primary' ? integrated.find((d) => d.primary) : integrated.find((d) => !d.primary);
      if (match) return { displayId: match.displayId };
    }

    const known = displays
      .map((d) => `${d.displayId} (${[d.name, d.kind].filter(Boolean).join(', ')})`)
      .join('; ');
    return {
      displayId: null,
      error: `this device has no '${override}' display — it reports: ${known}`,
    };
  }

  // Single-panel devices: nothing to choose, let the driver handle it.
  if (integrated.length < 2) return { displayId: null };

  const live = integrated.find((d) => d.active) ?? integrated.find((d) => d.primary);
  return { displayId: live ? live.displayId : null };
}
