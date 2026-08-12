import { create } from "zustand";

import { listDevices, startDeviceStream, stopDeviceStream } from "../lib/ipc";
import type { DeviceInfo } from "../lib/types";

interface DeviceState {
  devices: DeviceInfo[];
  selectedId: string | null;
  streaming: boolean;
  /** True while the daemon boots and the stream socket opens. */
  connecting: boolean;
  error: string | null;
}

const store = create<DeviceState>(() => ({
  devices: [],
  selectedId: null,
  streaming: false,
  connecting: false,
  error: null,
}));

export const useDevices = () => store((s) => s.devices);
export const useSelectedDeviceId = () => store((s) => s.selectedId);
export const useDeviceStreaming = () => store((s) => s.streaming);
export const useDeviceConnecting = () => store((s) => s.connecting);
export const useDeviceError = () => store((s) => s.error);

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

/**
 * Follow a device a run chose for us: make sure it's in the list, select it and
 * bring the stream up. Without this a run started with no device selected plays
 * out on a screen Studio isn't watching.
 */
export async function followDevice(id: string): Promise<void> {
  if (!store.getState().devices.some((d) => d.id === id)) await refreshDevices();
  const already = store.getState();
  if (already.selectedId === id && already.streaming) return;
  if (already.streaming && already.selectedId && already.selectedId !== id) {
    await disconnectSelectedDevice();
  }
  selectDevice(id);
  await connectSelectedDevice();
}

export async function connectSelectedDevice(): Promise<void> {
  const device = getSelectedDevice();
  if (!device) return;
  store.setState({ error: null, connecting: true });
  try {
    await startDeviceStream(device.id, device.platform);
    store.setState({ streaming: true });
  } catch (err) {
    store.setState({ error: String(err), streaming: false });
  } finally {
    store.setState({ connecting: false });
  }
}

export async function disconnectSelectedDevice(): Promise<void> {
  const device = getSelectedDevice();
  if (!device) return;
  try {
    await stopDeviceStream(device.id);
  } finally {
    store.setState({ streaming: false });
  }
}
