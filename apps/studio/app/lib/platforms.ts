import type { DeviceInfo, Platform } from "./types";

/**
 * What kind of device a flow needs, and whether a given device is one.
 *
 * Shared by the runner (which picks the device) and the Cases screen (which
 * offers you the choice), so the two can't drift into disagreeing about what
 * "tv" means.
 */

/** Platforms a hint accepts. `null` means "no opinion" — a `common` flow. */
export function wantedPlatforms(hint: string): Platform[] | null {
  switch (hint.toLowerCase().trim()) {
    case "tv":
    case "tvos":
    case "appletv":
    case "androidtv":
    case "firetv":
      return ["tvos", "android"];
    case "responsive":
    case "mobile":
    case "phone":
    case "handset":
      return ["ios", "android"];
    case "ios":
    case "iphone":
    case "ipad":
      return ["ios"];
    case "android":
      return ["android"];
    case "web":
    case "browser":
      return ["web"];
    default:
      return null;
  }
}

/**
 * Android reports phones, tablets and TVs alike as `android`, so the platform
 * alone can't answer "is this the right device for a tv flow" — the form factor
 * has to. A device that hasn't been probed (`formFactor` absent) is allowed
 * through rather than hidden, so an unknown device is never silently excluded.
 */
export function deviceMatches(device: DeviceInfo, hint: string): boolean {
  const wanted = wantedPlatforms(hint);
  if (!wanted) return true;
  if (!wanted.includes(device.platform)) return false;
  if (device.platform !== "android") return true;
  const wantsTv = wanted.includes("tvos");
  if (!device.formFactor) return true;
  return wantsTv ? device.formFactor === "tv" : device.formFactor !== "tv";
}

/** Candidates for a column, best first: right form factor, booted, unclaimed. */
export function devicesFor(devices: DeviceInfo[], hint: string): DeviceInfo[] {
  return devices
    .filter((d) => deviceMatches(d, hint))
    .sort(
      (a, b) =>
        Number(b.state === "booted") - Number(a.state === "booted") ||
        Number(!a.reservedBy) - Number(!b.reservedBy) ||
        a.name.localeCompare(b.name),
    );
}
