import { create } from "zustand";

import { listen } from "../lib/events";
import {
  acceptConvergeTarget,
  rejectConvergeTarget,
  cancelConverge,
  cancelParity,
  getConvergeState,
  getParityState,
  resetLiveParity,
  snapParity,
  startConverge,
  startParity,
} from "../lib/ipc";
import type {
  ConvergeProgress,
  DeviceInfo,
  ParityMatrix,
  ParityMode,
  ParityProgress,
  ParityTarget,
  ParityTargetProgress,
} from "../lib/types";
import { setStreamedDevices } from "./deviceStore";

/**
 * A parity run: the reference build on one device, every target build on its
 * own, and the grid that comes out of comparing them.
 *
 * The plan (which flow, which device is the reference, which devices are
 * targets) lives here and survives leaving the view; the live progress is
 * pushed from the main process on `parity_progress`.
 */

interface ParityState {
  /**
   * `flow` walks a scripted journey; `live` compares whatever the devices are
   * showing right now. Live exists because the reference is often already on
   * the screen you care about, and writing a flow to get back there is work
   * that answers no question.
   */
  mode: ParityMode;
  /** In live mode, replay input on the reference to every target. */
  mirrorInput: boolean;
  /** Names of the screens captured in this live session, in order. */
  snaps: string[];
  snapping: boolean;
  flowPath: string | null;
  referenceDeviceId: string | null;
  referenceLabel: string;
  targets: ParityTarget[];
  progress: ParityProgress | null;
  /** The Helix loop, when one is running. */
  converge: ConvergeProgress | null;
  convergeOptions: { strict: boolean; autoApprove: boolean; maxAttempts: number };
  starting: boolean;
  error: string | null;
}

const store = create<ParityState>(() => ({
  mode: "live",
  mirrorInput: true,
  snaps: [],
  snapping: false,
  flowPath: null,
  referenceDeviceId: null,
  referenceLabel: "Reference",
  targets: [],
  progress: null,
  converge: null,
  convergeOptions: { strict: false, autoApprove: true, maxAttempts: 8 },
  starting: false,
  error: null,
}));

export const useParityMode = () => store((s) => s.mode);
export const useParityMirror = () => store((s) => s.mirrorInput);
export const useParitySnaps = () => store((s) => s.snaps);
export const useParitySnapping = () => store((s) => s.snapping);
export const useParityFlow = () => store((s) => s.flowPath);
export const useParityReference = () =>
  store((s) => ({ deviceId: s.referenceDeviceId, label: s.referenceLabel }));
export const useParityTargets = () => store((s) => s.targets);
export const useParityProgress = () => store((s) => s.progress);
export const useParityStarting = () => store((s) => s.starting);
export const useParityError = () => store((s) => s.error);
export const useConverge = () => store((s) => s.converge);
export const useConvergeRunning = () => store((s) => s.converge?.running === true);

export const useParityMatrix = (): ParityMatrix | null =>
  store((s) => s.progress?.matrix ?? null);

/** True while a run is under way — the controls lock, the streams stay up. */
export const useParityRunning = () =>
  store((s) => {
    const phase = s.progress?.phase;
    return (
      s.starting ||
      phase === "recording-reference" ||
      phase === "walking-targets" ||
      phase === "diffing"
    );
  });

export function setParityFlow(flowPath: string | null): void {
  store.setState({ flowPath });
}

export function setParityMode(mode: ParityMode): void {
  store.setState({ mode });
}

export function setParityMirror(mirrorInput: boolean): void {
  store.setState({ mirrorInput });
}

/** Device ids a mirrored input should reach: every target, not the reference. */
export function mirrorTargets(): string[] {
  const s = store.getState();
  return s.mode === "live" && s.mirrorInput ? s.targets.map((t) => t.deviceId) : [];
}

/**
 * Capture what every device is showing right now and diff it.
 *
 * Appends to the running session, so the grid grows a row per captured screen
 * as you move through the app.
 */
export async function snapParityNow(name: string, reset = false): Promise<void> {
  const s = store.getState();
  if (!s.referenceDeviceId) {
    store.setState({ error: "pick the device running the reference build" });
    return;
  }
  if (s.targets.length === 0) {
    store.setState({ error: "add at least one target build to compare against" });
    return;
  }
  const trimmed = name.trim();
  if (!trimmed) {
    store.setState({ error: "name this screen so it can be found in the grid" });
    return;
  }

  store.setState({ snapping: true, error: null });
  try {
    const result = await snapParity({
      name: trimmed,
      referenceDeviceId: s.referenceDeviceId,
      referenceLabel: s.referenceLabel,
      targets: s.targets,
      reset,
    });
    store.setState((prev) => ({
      snaps: reset ? [result.name] : [...prev.snaps, result.name],
    }));
  } catch (err) {
    store.setState({ error: String(err) });
  } finally {
    store.setState({ snapping: false });
  }
}

/**
 * Hold every target to the screen just captured, and let an agent work each one
 * until it matches.
 *
 * The reference is frozen at whatever was last snapped: a goal that moves every
 * round is not a goal.
 */
export async function convergeOnLastSnap(): Promise<void> {
  const s = store.getState();
  const matrix = s.progress?.matrix;
  const checkpoint = s.snaps[s.snaps.length - 1];
  if (!matrix || !checkpoint) {
    store.setState({ error: "capture a reference screen first — there is nothing to match yet" });
    return;
  }
  if (s.targets.length === 0) {
    store.setState({ error: "add at least one target build to converge" });
    return;
  }

  store.setState({ error: null });
  try {
    await startConverge({
      checkpoint,
      referenceDir: matrix.reference.dir,
      referenceLabel: s.referenceLabel,
      targets: s.targets,
      ...s.convergeOptions,
    });
  } catch (err) {
    store.setState({ error: String(err) });
  }
}

export async function stopConvergence(): Promise<void> {
  try {
    await cancelConverge();
  } catch (err) {
    store.setState({ error: String(err) });
  }
}

export async function acceptConverged(label: string): Promise<void> {
  await acceptConvergeTarget(label).catch((err: unknown) => {
    store.setState({ error: String(err) });
  });
}

/** The diff passed; a person looked and says no. The note goes to the agent. */
export async function rejectConverged(label: string, note: string): Promise<void> {
  await rejectConvergeTarget(label, note).catch((err: unknown) => {
    store.setState({ error: String(err) });
  });
}

/** Loop settings, kept here so they survive leaving the view. */
export const useConvergeOptions = () => store((s) => s.convergeOptions);
export function setConvergeOptions(patch: Partial<ParityState["convergeOptions"]>): void {
  store.setState((s) => ({ convergeOptions: { ...s.convergeOptions, ...patch } }));
}

/** Throw the captured screens away and start the session over. */
export async function resetParitySession(): Promise<void> {
  try {
    await resetLiveParity();
  } finally {
    store.setState({ snaps: [], progress: null, error: null });
  }
}

export function setParityReference(deviceId: string | null, label?: string): void {
  store.setState((s) => ({
    referenceDeviceId: deviceId,
    referenceLabel: label ?? s.referenceLabel,
  }));
}

export function setParityReferenceLabel(label: string): void {
  store.setState({ referenceLabel: label });
}

/**
 * Add a device as a target. The label defaults to the device's own name, which
 * is what makes a four-way run readable without typing four column headings —
 * it stays editable because "Apple TV 4K (3rd gen)" is a worse column heading
 * than "tvOS".
 */
export function addParityTarget(device: DeviceInfo): void {
  store.setState((s) => {
    if (s.targets.some((t) => t.deviceId === device.id)) return s;
    if (s.referenceDeviceId === device.id) return s;
    const label = uniqueLabel(suggestLabel(device), s.targets);
    return { targets: [...s.targets, { label, deviceId: device.id, platform: device.platform }] };
  });
}

export function removeParityTarget(deviceId: string): void {
  store.setState((s) => ({ targets: s.targets.filter((t) => t.deviceId !== deviceId) }));
}

export function renameParityTarget(deviceId: string, label: string): void {
  store.setState((s) => ({
    targets: s.targets.map((t) => (t.deviceId === deviceId ? { ...t, label } : t)),
  }));
}

/** A short, platform-shaped column heading. */
export function suggestLabel(device: DeviceInfo): string {
  switch (device.platform) {
    case "tvos":
      return "tvOS";
    case "vega":
      return "VegaOS";
    case "roku":
      return "Roku";
    case "ios":
      return "iOS";
    case "web":
      return "Web";
    case "android":
      return device.formFactor === "tv" ? "Android TV" : "Android";
    default:
      return device.name;
  }
}

function uniqueLabel(base: string, existing: ParityTarget[]): string {
  if (!existing.some((t) => t.label === base)) return base;
  let n = 2;
  while (existing.some((t) => t.label === `${base} ${n}`)) n++;
  return `${base} ${n}`;
}

/** Every device the grid should be showing: the reference plus each target. */
export function streamedDeviceIds(): string[] {
  const s = store.getState();
  return [s.referenceDeviceId, ...s.targets.map((t) => t.deviceId)].filter(
    (id): id is string => Boolean(id),
  );
}

export async function syncParityStreams(): Promise<void> {
  await setStreamedDevices(streamedDeviceIds());
}

export async function startParityRun(): Promise<void> {
  const s = store.getState();
  if (!s.flowPath) {
    store.setState({ error: "pick a flow to walk first" });
    return;
  }
  if (!s.referenceDeviceId) {
    store.setState({ error: "pick the device running the reference build" });
    return;
  }
  if (s.targets.length === 0) {
    store.setState({ error: "add at least one target build to compare against" });
    return;
  }

  store.setState({ starting: true, error: null });
  try {
    // Bring every screen up before the walk starts, so the first checkpoints
    // aren't captured against tiles that are still black.
    await syncParityStreams();
    await startParity({
      flowPath: s.flowPath,
      referenceDeviceId: s.referenceDeviceId,
      referenceLabel: s.referenceLabel,
      targets: s.targets,
    });
  } catch (err) {
    store.setState({ error: String(err) });
  } finally {
    store.setState({ starting: false });
  }
}

export async function cancelParityRun(): Promise<void> {
  try {
    await cancelParity();
  } catch (err) {
    store.setState({ error: String(err) });
  }
}

/** Progress for one target label, for the tile that shows it. */
export function progressFor(
  progress: ParityProgress | null,
  label: string,
): ParityTargetProgress | undefined {
  if (!progress) return undefined;
  if (progress.reference.label === label) return progress.reference;
  return progress.targets.find((t) => t.label === label);
}

/** Subscribe to main-process progress. Called once, at app start. */
export function initParityStore(): () => void {
  void getParityState().then((progress) => {
    if (progress) store.setState({ progress });
  });
  void getConvergeState().then((converge) => {
    if (converge) store.setState({ converge });
  });
  const offProgress = listen<ParityProgress>("parity_progress", (progress) => {
    store.setState({ progress, error: progress.error ?? null });
  });
  const offConverge = listen<ConvergeProgress>("parity_converge", (converge) => {
    store.setState({ converge });
  });
  return () => {
    offProgress();
    offConverge();
  };
}
