import { create } from "zustand";

import { listDevices, startDeviceStream, stopDeviceStream } from "../lib/ipc";
import type { DeviceInfo } from "../lib/types";

/**
 * Devices, and which of them Studio is currently streaming.
 *
 * Streams are tracked **per device**, not one at a time: the Maestro workbench
 * watches a single screen, but a parity run watches the reference build and
 * every target build side by side. The selected-device helpers below are thin
 * wrappers over the per-device ones so the single-screen views don't have to
 * care that the store grew a second dimension.
 */

export type StreamPhase = "connecting" | "live" | "error";

interface DeviceState {
  devices: DeviceInfo[];
  selectedId: string | null;
  /** Stream phase per device id. Absent means "not streaming". */
  streams: Record<string, StreamPhase>;
  /** Last error per device id, for the tile that failed. */
  streamErrors: Record<string, string>;
  error: string | null;
}

const store = create<DeviceState>(() => ({
  devices: [],
  selectedId: null,
  streams: {},
  streamErrors: {},
  error: null,
}));

export const useDevices = () => store((s) => s.devices);
export const useSelectedDeviceId = () => store((s) => s.selectedId);
export const useDeviceError = () => store((s) => s.error);

/** Stream phase for one device — what a grid tile watches. */
export const useStreamPhase = (deviceId: string | null): StreamPhase | undefined =>
  store((s) => (deviceId ? s.streams[deviceId] : undefined));

export const useStreamError = (deviceId: string | null): string | undefined =>
  store((s) => (deviceId ? s.streamErrors[deviceId] : undefined));

// ── Selected-device conveniences (single-screen views) ──
export const useDeviceStreaming = () =>
  store((s) => (s.selectedId ? s.streams[s.selectedId] === "live" : false));
export const useDeviceConnecting = () =>
  store((s) => (s.selectedId ? s.streams[s.selectedId] === "connecting" : false));

export function getSelectedDevice(): DeviceInfo | null {
  const { devices, selectedId } = store.getState();
  return devices.find((d) => d.id === selectedId) ?? null;
}

export async function refreshDevices(): Promise<void> {
  try {
    const devices = await listDevices();
    store.setState((s) => ({
      devices,
      error: null,
      selectedId:
        s.selectedId && devices.some((d) => d.id === s.selectedId)
          ? s.selectedId
          : (devices.find((d) => d.state === "booted") ?? devices[0])?.id ?? null,
    }));
  } catch (err) {
    store.setState({ error: String(err) });
  }
}

export function selectDevice(id: string): void {
  store.setState({ selectedId: id });
}

function setPhase(deviceId: string, phase: StreamPhase | null, error?: string): void {
  store.setState((s) => {
    const streams = { ...s.streams };
    const streamErrors = { ...s.streamErrors };
    if (phase === null) {
      delete streams[deviceId];
      delete streamErrors[deviceId];
    } else {
      streams[deviceId] = phase;
      if (error) streamErrors[deviceId] = error;
      else delete streamErrors[deviceId];
    }
    return { streams, streamErrors };
  });
}

/**
 * Bring one device's stream up. Safe to call for a device already live, and
 * safe to call for several devices at once — each keeps its own phase.
 */
export async function connectDevice(deviceId: string): Promise<void> {
  const existing = store.getState().streams[deviceId];
  if (existing === "live" || existing === "connecting") return;

  let device = store.getState().devices.find((d) => d.id === deviceId);
  if (!device) {
    await refreshDevices();
    device = store.getState().devices.find((d) => d.id === deviceId);
  }
  if (!device) {
    setPhase(deviceId, "error", `device ${deviceId} is not connected`);
    return;
  }

  setPhase(deviceId, "connecting");
  try {
    await startDeviceStream(device.id, device.platform);
    setPhase(device.id, "live");
  } catch (err) {
    setPhase(device.id, "error", String(err));
  }
}

export async function disconnectDevice(deviceId: string): Promise<void> {
  try {
    await stopDeviceStream(deviceId);
  } finally {
    setPhase(deviceId, null);
  }
}

/** Bring up exactly this set and drop anything else — the parity grid's needs. */
export async function setStreamedDevices(deviceIds: string[]): Promise<void> {
  const wanted = new Set(deviceIds.filter(Boolean));
  const current = Object.keys(store.getState().streams);
  await Promise.all([
    ...current.filter((id) => !wanted.has(id)).map((id) => disconnectDevice(id)),
    ...[...wanted].map((id) => connectDevice(id)),
  ]);
}

/**
 * Follow a device a run chose for us: make sure it's in the list, select it and
 * bring the stream up. Without this a run started with no device selected plays
 * out on a screen Studio isn't watching.
 */
export async function followDevice(id: string): Promise<void> {
  if (!store.getState().devices.some((d) => d.id === id)) await refreshDevices();
  // Drop the screen we were watching, but only that one: a parity grid's other
  // streams belong to a different view and are not ours to tear down.
  const previous = store.getState().selectedId;
  if (previous && previous !== id && store.getState().streams[previous]) {
    await disconnectDevice(previous);
  }
  selectDevice(id);
  await connectDevice(id);
}

export async function connectSelectedDevice(): Promise<void> {
  const device = getSelectedDevice();
  if (device) await connectDevice(device.id);
}

export async function disconnectSelectedDevice(): Promise<void> {
  const device = getSelectedDevice();
  if (device) await disconnectDevice(device.id);
}
