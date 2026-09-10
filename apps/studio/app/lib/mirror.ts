import { deviceInputText, devicePressKey, deviceSwipe, deviceTap } from "./ipc";
import type { RouteStep } from "./types";

/**
 * Replay one input across several devices.
 *
 * The point of a live parity session is to get every build onto the *same*
 * screen without a flow, and driving four devices by hand doesn't scale past
 * about one. Mirroring sends what you do on the reference to every target, so
 * they walk together — which for a TV app, where navigation is a sequence of
 * D-pad presses, is usually all it takes.
 *
 * Coordinates are normalised (0–1), so a mirrored tap lands in the same place
 * on a 1080p TV and a 720p browser window. That is a genuine assumption: it
 * holds when the builds lay out alike and breaks when they don't — and when it
 * breaks, the parity diff is what tells you.
 */

export type MirrorInput = RouteStep;

export async function sendInput(deviceId: string, input: MirrorInput): Promise<void> {
  switch (input.kind) {
    case "tap":
      return deviceTap(deviceId, input.x, input.y);
    case "swipe":
      return deviceSwipe(deviceId, input.x1, input.y1, input.x2, input.y2);
    case "key":
      return devicePressKey(deviceId, input.key);
    case "text":
      return deviceInputText(deviceId, input.text);
  }
}

/**
 * Send one input everywhere at once.
 *
 * Failures are collected rather than thrown: one unreachable device shouldn't
 * stop the others from following along, and the tile that failed already shows
 * its own error.
 */
export async function mirrorInput(
  deviceIds: string[],
  input: MirrorInput,
): Promise<{ deviceId: string; error: string }[]> {
  const results = await Promise.allSettled(deviceIds.map((id) => sendInput(id, input)));
  return results.flatMap((r, i) =>
    r.status === "rejected" ? [{ deviceId: deviceIds[i], error: String(r.reason) }] : [],
  );
}
