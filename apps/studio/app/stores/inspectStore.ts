import { create } from "zustand";

import { captureUi } from "../lib/ipc";
import type { CaptureElement, CaptureUiResult } from "../lib/types";

/**
 * The element-picking session shared by the device stream and the inspector
 * tree: one capture, one hovered element, one selected element. Inspect mode
 * hands pointer events to the annotations instead of driving the device.
 */

export type DeviceMode = "interact" | "inspect";

interface InspectState {
  mode: DeviceMode;
  capture: CaptureUiResult | null;
  loading: boolean;
  error: string | null;
  hoveredRef: string | null;
  selectedRef: string | null;
}

const store = create<InspectState>(() => ({
  mode: "interact",
  capture: null,
  loading: false,
  error: null,
  hoveredRef: null,
  selectedRef: null,
}));

export const useDeviceMode = () => store((s) => s.mode);
export const useCapture = () => store((s) => s.capture);
export const useCaptureLoading = () => store((s) => s.loading);
export const useCaptureError = () => store((s) => s.error);
export const useHoveredRef = () => store((s) => s.hoveredRef);
export const useSelectedRef = () => store((s) => s.selectedRef);

export const getCapture = () => store.getState().capture;
export const getDeviceMode = () => store.getState().mode;

export function setHoveredRef(ref: string | null): void {
  store.setState({ hoveredRef: ref });
}

export function setSelectedRef(ref: string | null): void {
  store.setState({ selectedRef: ref });
}

export function setMode(mode: DeviceMode): void {
  store.setState({ mode, hoveredRef: null, selectedRef: mode === "interact" ? null : store.getState().selectedRef });
}

export async function refreshCapture(deviceId: string): Promise<void> {
  store.setState({ loading: true, error: null });
  try {
    const capture = await captureUi(deviceId);
    // Refs are only valid within a capture, so drop a selection it doesn't have.
    const selectedRef = store.getState().selectedRef;
    store.setState({
      capture,
      loading: false,
      selectedRef: selectedRef && findElement(capture.root, selectedRef) ? selectedRef : null,
      hoveredRef: null,
    });
  } catch (err) {
    store.setState({ loading: false, error: String(err), capture: null });
  }
}

export function findElement(root: CaptureElement, ref: string): CaptureElement | null {
  if (root.ref === ref) return root;
  for (const child of root.children ?? []) {
    const found = findElement(child, ref);
    if (found) return found;
  }
  return null;
}

/** Every element that has bounds, smallest last so hit-testing prefers it. */
export function elementsWithBounds(root: CaptureElement): CaptureElement[] {
  const out: CaptureElement[] = [];
  const visit = (el: CaptureElement) => {
    if (el.bounds && el.bounds.width > 0 && el.bounds.height > 0) out.push(el);
    for (const child of el.children ?? []) visit(child);
  };
  for (const child of root.children ?? []) visit(child);
  return out.sort((a, b) => area(b) - area(a));
}

function area(el: CaptureElement): number {
  return el.bounds ? el.bounds.width * el.bounds.height : 0;
}
