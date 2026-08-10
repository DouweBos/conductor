import { acquireDevice, releaseDevice } from "../conductor/conductorService";
import { broadcastToRenderers } from "../../broadcast";

/**
 * Device claims in conductor's shared pool, counted per device.
 *
 * An agent session and a flow run can both want the same device, and they're
 * both us — so the claim is taken once and only handed back when the last
 * holder is done. Without the count, a flow run finishing would release the
 * device out from under an agent still driving it.
 */

const holders = new Map<string, number>();

/** Claim a device, or throw if another agent holds it. */
export async function reserveDevice(deviceId: string, purpose: string): Promise<void> {
  const held = holders.get(deviceId) ?? 0;
  if (held === 0 && !(await acquireDevice(deviceId))) {
    throw new Error(
      `${deviceId} is reserved by another agent — ${purpose} would fight it for the screen.`,
    );
  }
  holders.set(deviceId, held + 1);
  if (held === 0) broadcastToRenderers("devices:pool", {});
}

/** Hand a claim back once nothing else here is using the device. */
export async function endReservation(deviceId: string): Promise<void> {
  const held = holders.get(deviceId) ?? 0;
  if (held <= 1) {
    holders.delete(deviceId);
    await releaseDevice(deviceId);
    broadcastToRenderers("devices:pool", {});
    return;
  }
  holders.set(deviceId, held - 1);
}

/** Release everything on shutdown, so a quit doesn't strand a device. */
export async function releaseAllReservations(): Promise<void> {
  const ids = [...holders.keys()];
  holders.clear();
  await Promise.all(ids.map((id) => releaseDevice(id)));
}
