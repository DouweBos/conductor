import { create } from "zustand";

import { listen } from "../lib/events";
import {
  acceptConvergeTarget,
  addCampaignGoal,
  getCampaign,
  refreshCampaignReference,
  removeCampaignGoal,
  runCampaign,
  setCampaignDeepLink,
  stopCampaign,
  deleteParityRecipe,
  getParityConfig,
  putParityRecipe,
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
  CampaignProgress,
  ConvergeProgress,
  DeviceInfo,
  InteractionStep,
  ParityProjectConfig,
  RouteStep,
  TargetRecipe,
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
  /** Every Helix loop the main process knows about — one per goal, newest last. */
  converges: ConvergeProgress[];
  campaign: CampaignProgress | null;
  convergeOptions: {
    strict: boolean;
    autoApprove: boolean;
    maxAttempts: number;
    preferReload: boolean;
    adversarialReview: boolean;
    commitOnAccept: boolean;
  };
  /**
   * The inputs sent to the reference since it was last launched, in order.
   * Attached to the next snap as the route the loop replays on each target.
   */
  route: RouteStep[];
  /** App the reference is running, so a route can start from a fresh launch. */
  referenceAppId: string;
  /**
   * Interaction recording: on, every input to the reference after the last
   * capture becomes an interaction step and captures its own checkpoint on
   * every device — so "Down, Down, Enter" is held to parity screen by screen.
   */
  recordingInteraction: boolean;
  interaction: InteractionStep[];
  config: ParityProjectConfig;
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
  converges: [],
  campaign: null,
  convergeOptions: {
    strict: false,
    autoApprove: true,
    maxAttempts: 8,
    preferReload: true,
    adversarialReview: true,
    commitOnAccept: true,
  },
  route: [],
  referenceAppId: "",
  recordingInteraction: false,
  interaction: [],
  config: { version: 1, recipes: {} },
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
export const useConverges = () => store((s) => s.converges);
/** The most recent loop — what a single-screen session is looking at. */
export const useConverge = () => store((s) => s.converges[s.converges.length - 1] ?? null);
export const useParityRoute = () => store((s) => s.route);
export const useCampaign = () => store((s) => s.campaign);

/** Queue the screen just captured as a goal, with its frozen reference and route. */
/**
 * The route to the goal's base screen excludes the interaction's own inputs:
 * those are replayed *from* the base as steps, not to reach it.
 */
function routeToBase(s: { route: RouteStep[]; interaction: InteractionStep[] }): RouteStep[] {
  return s.interaction.length ? s.route.slice(0, s.route.length - s.interaction.length) : s.route;
}

export async function addLastSnapToCampaign(): Promise<void> {
  const s = store.getState();
  const matrix = s.progress?.matrix;
  const checkpoint = goalCheckpoint(s);
  if (!matrix || !checkpoint || !s.referenceDeviceId) {
    store.setState({ error: "capture a reference screen first — there is nothing to queue yet" });
    return;
  }
  try {
    await addCampaignGoal({
      checkpoint,
      referenceDir: matrix.reference.dir,
      referenceLabel: s.referenceLabel,
      referenceDeviceId: s.referenceDeviceId,
      route:
        s.route.length || s.referenceAppId
          ? { appId: s.referenceAppId || undefined, steps: routeToBase(s) }
          : undefined,
      interaction: s.interaction.length ? s.interaction : undefined,
      targets: s.targets,
    });
  } catch (err) {
    store.setState({ error: String(err) });
  }
}

export async function removeGoal(id: string): Promise<void> {
  await removeCampaignGoal(id).catch((err: unknown) => store.setState({ error: String(err) }));
}

export async function setGoalDeepLink(id: string, deepLink: string): Promise<void> {
  await setCampaignDeepLink(id, deepLink).catch((err: unknown) => store.setState({ error: String(err) }));
}

export async function startCampaign(): Promise<void> {
  const { convergeOptions } = store.getState();
  await runCampaign(convergeOptions).catch((err: unknown) => store.setState({ error: String(err) }));
}

export async function haltCampaign(): Promise<void> {
  await stopCampaign().catch((err: unknown) => store.setState({ error: String(err) }));
}

export async function refreshGoal(id: string): Promise<void> {
  store.setState({ error: null });
  await refreshCampaignReference(id).catch((err: unknown) => store.setState({ error: String(err) }));
}
export const useReferenceAppId = () => store((s) => s.referenceAppId);
export const useParityConfig = () => store((s) => s.config);

export const useRecordingInteraction = () => store((s) => s.recordingInteraction);
export const useInteraction = () => store((s) => s.interaction);

/** Captures run one at a time, in the order the inputs were sent. */
let captureQueue: Promise<void> = Promise.resolve();

/** Called for every input dispatched to the reference in live mode. */
export function recordRouteStep(step: RouteStep): void {
  store.setState((s) => ({ route: [...s.route, step] }));
  const s = store.getState();
  if (!s.recordingInteraction) return;
  // Each input after a capture is a step of the interaction being recorded,
  // and the screen it leaves is captured on every device as its own checkpoint.
  const base = s.snaps[s.snaps.length - 1];
  if (!base) return;
  const index = s.interaction.length + 1;
  const checkpoint = `${base}/${index}`;
  store.setState((prev) => ({ interaction: [...prev.interaction, { input: step, checkpoint }] }));
  captureQueue = captureQueue.then(() => snapParityNow(checkpoint, false, { keepInteraction: true }));
}

export function setRecordingInteraction(on: boolean): void {
  store.setState({ recordingInteraction: on, ...(on ? {} : {}) });
}

/** A fresh launch starts a fresh route. */
export function resetRoute(): void {
  store.setState({ route: [] });
}

export function setReferenceAppId(appId: string): void {
  store.setState({ referenceAppId: appId });
}

export async function loadParityConfigIntoStore(): Promise<void> {
  try {
    store.setState({ config: await getParityConfig() });
  } catch (err) {
    store.setState({ error: String(err) });
  }
}

export async function saveRecipe(recipe: TargetRecipe): Promise<void> {
  try {
    store.setState({ config: await putParityRecipe(recipe) });
  } catch (err) {
    store.setState({ error: String(err) });
  }
}

export async function removeRecipe(label: string): Promise<void> {
  try {
    store.setState({ config: await deleteParityRecipe(label) });
  } catch (err) {
    store.setState({ error: String(err) });
  }
}
export const useConvergeRunning = () => store((s) => s.converges.some((c) => c.running));

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
export async function snapParityNow(
  name: string,
  reset = false,
  opts: { keepInteraction?: boolean } = {},
): Promise<void> {
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
      // A fresh base screen starts a fresh interaction; a step capture keeps it.
      ...(opts.keepInteraction ? {} : { interaction: [] }),
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
/** The base screen of the current interaction, or the last snap when there is none. */
function goalCheckpoint(s: { snaps: string[]; interaction: InteractionStep[] }): string | undefined {
  if (s.interaction.length) return s.interaction[0].checkpoint.replace(/\/\d+$/, "");
  return s.snaps[s.snaps.length - 1];
}

export async function convergeOnLastSnap(): Promise<void> {
  const s = store.getState();
  const matrix = s.progress?.matrix;
  const checkpoint = goalCheckpoint(s);
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
      route:
        s.route.length || s.referenceAppId
          ? { appId: s.referenceAppId || undefined, steps: routeToBase(s) }
          : undefined,
      interaction: s.interaction.length ? s.interaction : undefined,
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

export async function acceptConverged(label: string, goalId?: string): Promise<void> {
  await acceptConvergeTarget(label, goalId).catch((err: unknown) => {
    store.setState({ error: String(err) });
  });
}

/** The diff passed; a person looked and says no. The note goes to the agent. */
export async function rejectConverged(label: string, note: string, goalId?: string): Promise<void> {
  await rejectConvergeTarget(label, note, goalId).catch((err: unknown) => {
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
  void getConvergeState().then((converges) => {
    if (converges) store.setState({ converges });
  });
  void getCampaign().then((campaign) => store.setState({ campaign })).catch(() => {});
  const offCampaign = listen<CampaignProgress>("parity_campaign", (campaign) => {
    store.setState({ campaign, error: campaign.error ?? null });
  });
  const offProgress = listen<ParityProgress>("parity_progress", (progress) => {
    store.setState({ progress, error: progress.error ?? null });
  });
  const offConverge = listen<ConvergeProgress[]>("parity_converge", (converges) => {
    store.setState({ converges });
  });
  return () => {
    offProgress();
    offConverge();
    offCampaign();
  };
}
