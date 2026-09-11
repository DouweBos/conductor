/**
 * Matching what goals need to the devices that are actually here.
 *
 * Pure, so it can be tested. A device is eligible for a need when it is
 * booted, nobody holds it, it is the right platform, and — for Android, which
 * reports TVs and phones alike — the right form factor when both sides know
 * theirs. The device a goal used last time is preferred when it qualifies, so
 * a campaign re-run on the same machine lands on the same simulators.
 */
import type { DeviceInfo, DeviceNeed } from "../../../app/lib/types";

export interface Assignment {
  assigned: Record<string, string>;
  /** Needs nothing could satisfy, in the words the panel shows. */
  unmet: string[];
}

export function eligible(device: DeviceInfo, need: DeviceNeed): boolean {
  if (device.state !== "booted") return false;
  if (device.reservedBy) return false;
  if (device.platform !== need.platform) return false;
  if (need.formFactor && device.formFactor && device.formFactor !== need.formFactor) return false;
  return true;
}

export function describeNeed(need: DeviceNeed): string {
  const ff = need.formFactor ? ` (${need.formFactor})` : "";
  return `${need.label}: a booted ${need.platform}${ff} device`;
}

/**
 * Assign one device per need, never the same device twice. Needs are taken in
 * order and preferred devices first, so a goal that lists "tvOS" before "Web"
 * doesn't lose its tvOS simulator to a later need on a tie.
 */
export function assignDevices(
  needs: DeviceNeed[],
  devices: DeviceInfo[],
  alreadyTaken: ReadonlySet<string> = new Set(),
): Assignment {
  const taken = new Set(alreadyTaken);
  const assigned: Record<string, string> = {};
  const unmet: string[] = [];

  for (const need of needs) {
    const pool = devices.filter((d) => eligible(d, need) && !taken.has(d.id));
    const preferred = need.preferredDeviceId ? pool.find((d) => d.id === need.preferredDeviceId) : undefined;
    const pick = preferred ?? pool[0];
    if (!pick) {
      unmet.push(describeNeed(need));
      continue;
    }
    taken.add(pick.id);
    assigned[need.label] = pick.id;
  }
  return { assigned, unmet };
}
