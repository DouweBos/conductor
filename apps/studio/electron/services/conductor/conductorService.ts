import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  AppFingerprint,
  CaptureElement,
  CaptureUiResult,
  CommandResult,
  DeviceInfo,
  Platform,
} from "../../../app/lib/types";
import { appState } from "../../state";
import { resolveConductor } from "../maestro/maestroService";
import { recordCapture } from "../scenegraph/sceneGraphService";
import { run } from "../util/exec";

async function runConductor(args: string[], timeout = 60_000) {
  const resolved = await resolveConductor();
  if (!resolved) {
    throw new Error(
      "Bundled conductor CLI is missing. Run `pnpm prepare-conductor` in apps/studio, or pick a different version in Settings.",
    );
  }
  return run(resolved.bin, [...resolved.prefixArgs, ...args], { timeout, env: resolved.env });
}

/** Argument that targets a specific device (also keys the conductor session). */
function deviceArgs(deviceId: string): string[] {
  return deviceId ? ["--device", deviceId] : [];
}

export async function listDevices(): Promise<DeviceInfo[]> {
  const res = await runConductor(["list-devices", "--json"], 20_000);
  if (res.code !== 0) {
    throw new Error(res.stderr.trim() || "conductor list-devices failed");
  }
  const parsed = safeJson<unknown>(res.stdout);
  // The CLI splits booted devices from bootable ones; Studio shows both.
  const rows = Array.isArray(parsed)
    ? parsed
    : [
        ...((parsed as { devices?: unknown[] })?.devices ?? []),
        ...((parsed as { availableDevices?: unknown[] })?.availableDevices ?? []),
      ];
  const seen = new Set<string>();
  const devices = rows
    .map(normalizeDevice)
    .filter((d): d is DeviceInfo => d !== null)
    .filter((d) => !seen.has(d.id) && seen.add(d.id));

  // Mark what another agent has claimed, so you don't pick a device mid-test.
  const pool = await devicePoolStatus();
  const own = String(process.pid);
  for (const device of devices) {
    const holder = pool[device.id];
    if (holder) device.reservedBy = holder === own ? "this app" : `PID ${holder}`;
  }
  return devices;
}

function normalizeDevice(raw: unknown): DeviceInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = String(r.id ?? r.udid ?? r.serial ?? r.deviceId ?? "");
  if (!id) return null;
  const platform = normalizePlatform(String(r.platform ?? r.os ?? ""));
  const rawState = String(r.state ?? r.status ?? "unknown").toLowerCase();
  const state = rawState.includes("boot") || rawState.includes("running")
    ? "booted"
    : rawState.includes("shut") || rawState.includes("available")
      ? "shutdown"
      : "unknown";
  const formFactor = r.formFactor === "tv" || r.formFactor === "handset" ? r.formFactor : undefined;
  return {
    id,
    name: String(r.name ?? r.model ?? id),
    platform,
    state,
    ...(formFactor ? { formFactor } : {}),
  };
}

function normalizePlatform(value: string): Platform {
  const v = value.toLowerCase();
  if (v.includes("android")) return "android";
  if (v.includes("tv")) return "tvos";
  if (v.includes("web")) return "web";
  return "ios";
}

/** Display names are only worth one lookup per device — they don't change. */
const appNameCache = new Map<string, Record<string, string>>();

function deriveAppName(appId: string): string {
  // com.plexapp.plex → Plex; https://app.plex.tv/ → app.plex.tv
  if (/^https?:\/\//i.test(appId)) {
    try {
      return new URL(appId).host;
    } catch {
      return appId;
    }
  }
  const last = appId.split(".").filter(Boolean).pop() ?? appId;
  return last.charAt(0).toUpperCase() + last.slice(1);
}

async function appNamesFor(deviceId: string): Promise<Record<string, string>> {
  const cached = appNameCache.get(deviceId);
  if (cached) return cached;
  let names: Record<string, string> = {};
  try {
    const res = await runConductor(["list-apps", ...deviceArgs(deviceId), "--json"], 30_000);
    if (res.code === 0) {
      const parsed = safeJson<{ appNames?: Record<string, string> }>(res.stdout);
      names = parsed?.appNames ?? {};
    }
  } catch {
    // names are cosmetic — fall back to deriving one from the id
  }
  appNameCache.set(deviceId, names);
  return names;
}

/** Identify the app in the foreground: bundle/package id, name, and platform. */
export async function appFingerprint(
  deviceId: string,
  platform?: Platform,
): Promise<AppFingerprint | null> {
  const res = await runConductor(["foreground-app", ...deviceArgs(deviceId), "--json"], 20_000);
  if (res.code !== 0) return null;
  const parsed = safeJson<{ status?: string; message?: string }>(res.stdout);
  const appId = parsed?.status === "ok" ? (parsed.message ?? "").trim() : "";
  if (!appId) return null;

  const resolvedPlatform =
    platform ?? (await listDevices().catch(() => [])).find((d) => d.id === deviceId)?.platform ?? "ios";
  const appName = (await appNamesFor(deviceId))[appId] ?? deriveAppName(appId);
  return {
    appId,
    appName,
    platform: resolvedPlatform,
    key: `${resolvedPlatform}-${appId}`.replace(/[^A-Za-z0-9._-]+/g, "_"),
  };
}

/**
 * Reserve a device in conductor's shared pool so a second agent can't drive it
 * mid-test. The claim is owned by this process, not by the CLI invocation —
 * conductor releases a claim whose owner has gone away, and the CLI exits
 * immediately, so without this the reservation would evaporate at once.
 */
export async function acquireDevice(deviceId: string): Promise<boolean> {
  const res = await runConductor(
    ["device-pool", "--acquire", "--device", deviceId, "--owner", String(process.pid), "--json"],
    20_000,
  );
  return res.code === 0;
}

export async function releaseDevice(deviceId: string): Promise<void> {
  await runConductor(["device-pool", "--release", deviceId, "--json"], 20_000).catch(() => {});
}

/** Who holds each device right now, by device id. */
export async function devicePoolStatus(): Promise<Record<string, string | null>> {
  try {
    const res = await runConductor(["device-pool", "--list", "--json"], 20_000);
    const parsed = safeJson<{ devices?: { deviceId: string; free: boolean; acquiredBy?: string }[] }>(
      res.stdout,
    );
    const out: Record<string, string | null> = {};
    for (const entry of parsed?.devices ?? []) {
      out[entry.deviceId] = entry.free ? null : (entry.acquiredBy ?? "another agent");
    }
    return out;
  } catch {
    return {};
  }
}

/** Boot a simulator/emulator so you don't have to leave Studio to get a device. */
export async function startDevice(platform: Platform, deviceId?: string): Promise<string> {
  const args = ["start-device", "--platform", platform, ...(deviceId ? ["--device", deviceId] : [])];
  const res = await runConductor(args, 300_000);
  if (res.code !== 0) throw new Error(res.stderr.trim() || "conductor start-device failed");
  return res.stdout.trim();
}

/** Install a local build (.app/.ipa/.apk) on the device. */
export async function installApp(deviceId: string, appPath: string): Promise<string> {
  const res = await runConductor(["install-app", appPath, ...deviceArgs(deviceId)], 300_000);
  if (res.code !== 0) throw new Error(res.stderr.trim() || "conductor install-app failed");
  return res.stdout.trim();
}

export async function captureUi(deviceId: string): Promise<CaptureUiResult> {
  // Route the bundle through a file: it embeds a base64 screenshot, so on stdout
  // any driver log line lands in the middle of multi-MB JSON and breaks parsing.
  const out = path.join(tmpdir(), `conductor-capture-${randomUUID()}.json`);
  let bundle: CaptureBundle | null = null;
  try {
    const res = await runConductor(
      ["capture-ui", "--output", out, ...deviceArgs(deviceId), "--json"],
      45_000,
    );
    if (res.code !== 0) {
      throw new Error(res.stderr.trim() || res.stdout.trim() || "conductor capture-ui failed");
    }
    bundle = safeJson<CaptureBundle>(await readFile(out, "utf8"));
  } finally {
    await rm(out, { force: true });
  }
  if (!bundle) throw new Error("capture-ui returned no parseable bundle");
  const result = mapBundle(deviceId, bundle);
  // Grow the scene graph from what we observe; consume the pending action so it
  // labels the transition edge into this screen.
  const action = appState.lastAction;
  appState.lastAction = null;
  const app = await appFingerprint(deviceId, bundle.device?.platform).catch(() => null);
  if (app) appState.currentApp = app;
  void recordCapture(result, action, app);
  return result;
}

interface CaptureBundle {
  device?: { width?: number; height?: number; platform?: Platform };
  screenshot?: { encoding?: string; data?: string };
  a11ySnapshot?: A11yEntry[];
  hierarchy?: { axElement?: unknown; elements?: unknown };
}

interface A11yEntry {
  nodeId?: string;
  ref: string;
}

/**
 * The inspector tree is the platform view hierarchy, not the flat a11y snapshot:
 * the snapshot only holds nodes a screen reader stops on, so a container with an
 * accessibility identifier — exactly what selectors target — was missing from
 * Studio while `assert-visible` on it passed.
 *
 * `@eN` refs still come from the snapshot, joined on the `nodeId` dot-path both
 * sides carry. Nodes without one are marked `a11y: false`, which is what keeps
 * the device overlay and the scene-graph signature to the a11y elements alone.
 */
function mapBundle(deviceId: string, bundle: CaptureBundle): CaptureUiResult {
  const width = bundle.device?.width ?? 0;
  const height = bundle.device?.height ?? 0;
  const screenshot = bundle.screenshot?.data
    ? `data:image/${bundle.screenshot.encoding ?? "png"};base64,${bundle.screenshot.data}`
    : undefined;

  const refs = new Map<string, string>();
  for (const entry of bundle.a11ySnapshot ?? []) {
    if (entry.nodeId !== undefined) refs.set(entry.nodeId, entry.ref);
  }

  const roots = hierarchyRoots(bundle.hierarchy);
  const children = prune(roots.map((node) => toElement(node, refs)));
  const root: CaptureElement = { ref: "root", role: "Screen", text: "Screen", a11y: true, children };
  return { deviceId, width, height, screenshot, root };
}

/**
 * Drop nodes that carry no identity — no id, no text, no a11y — by splicing
 * their children up. A native hierarchy is mostly single-child layout wrappers,
 * so without this the tree is hundreds of rows named after nothing but their
 * own path. A wrapper that branches is kept: it's the only thing grouping its
 * children.
 */
function prune(elements: CaptureElement[]): CaptureElement[] {
  const out: CaptureElement[] = [];
  for (const el of elements) {
    const children = prune(el.children ?? []);
    if (el.a11y || el.identifier || el.text || children.length > 1) {
      out.push({ ...el, children });
    } else {
      out.push(...children);
    }
  }
  return out;
}

/** capture-ui names the tree per platform: `axElement` on iOS/tvOS, `elements` elsewhere. */
function hierarchyRoots(hierarchy: CaptureBundle["hierarchy"]): Record<string, unknown>[] {
  const tree = hierarchy?.axElement ?? hierarchy?.elements;
  if (Array.isArray(tree)) return tree.filter(isNode);
  return isNode(tree) ? [tree] : [];
}

function isNode(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

/**
 * One enriched hierarchy node, in whichever platform's shape. The a11y builder
 * gives every platform `nodeId`, so the field probing is only about names:
 * iOS has `identifier`/`label`, Android `resourceId`/`text`, web `testId`/`name`.
 */
function toElement(node: Record<string, unknown>, refs: Map<string, string>): CaptureElement {
  const nodeId = String(node.nodeId ?? "");
  const ref = refs.get(nodeId);
  const el: CaptureElement = {
    // Non-a11y nodes have no `@eN`; the node path is stable within a capture,
    // which is all a ref is used for here.
    ref: ref ?? `#${nodeId}`,
    a11y: ref !== undefined,
    // iOS carries no `role` on the hierarchy node — only the snapshot entry has
    // one, derived from the traits. Read the traits directly instead.
    role: text(node.role) || roleTrait(node.traits) || text(node.class) || undefined,
    focused: isFocused(node) || undefined,
    text: text(node.accessibilityLabel) || text(node.label) || text(node.name) ||
      text(node.title) || text(node.text) || text(node.contentDescription) ||
      text(node.value) || undefined,
    identifier: text(node.accessibilityIdentifier) || text(node.identifier) ||
      text(node.resourceId) || text(node.testId) || undefined,
    bounds: boundsOf(node),
  };
  const children = (node.children as unknown[]) ?? [];
  el.children = children.filter(isNode).map((child) => toElement(child, refs));
  return el;
}

/**
 * `traits` is `[type?, ...states]`, so the first entry is a state whenever the
 * element type has no mapping — which is how a plain container ended up
 * labelled "disabled" or "focused" as though that were its role.
 */
const STATE_TRAITS = new Set(["selected", "disabled", "focused"]);

function roleTrait(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.map(text).find((trait) => trait && !STATE_TRAITS.has(trait)) ?? "";
}

/** iOS says `hasFocus`, web says `focused`, Android buries it in `state`. */
function isFocused(node: Record<string, unknown>): boolean {
  if (node.hasFocus === true || node.focused === true) return true;
  const state = node.state as Record<string, unknown> | undefined;
  return state?.focused === true;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** iOS reports `frame: {X,Y,Width,Height}`, Android `bounds: {x1,y1,x2,y2}`, web `bounds`. */
function boundsOf(node: Record<string, unknown>): CaptureElement["bounds"] {
  const frame = node.frame as Record<string, number> | undefined;
  if (frame) {
    return {
      x: frame.X ?? frame.x ?? 0,
      y: frame.Y ?? frame.y ?? 0,
      width: frame.Width ?? frame.width ?? 0,
      height: frame.Height ?? frame.height ?? 0,
    };
  }
  const bounds = node.bounds as Record<string, number> | undefined;
  if (!bounds) return undefined;
  if (bounds.x1 !== undefined) {
    return {
      x: bounds.x1,
      y: bounds.y1 ?? 0,
      width: (bounds.x2 ?? 0) - bounds.x1,
      height: (bounds.y2 ?? 0) - (bounds.y1 ?? 0),
    };
  }
  return {
    x: bounds.x ?? 0,
    y: bounds.y ?? 0,
    width: bounds.width ?? 0,
    height: bounds.height ?? 0,
  };
}

/** x/y are normalized 0..1 relative to the device screen. */
export async function tap(deviceId: string, x: number, y: number): Promise<void> {
  // Pass the fraction through: conductor resolves 0–1 coordinates against the
  // device's point size, which the video stream's pixel dimensions are not.
  const at = `${round(x)},${round(y)}`;
  const res = await runConductor(["tap-on", "--at", at, ...deviceArgs(deviceId)], 20_000);
  if (res.code !== 0) throw new Error(res.stderr.trim() || "tap failed");
  appState.lastAction = `tapOn: point ${at}`;
}

function round(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

export async function swipe(
  deviceId: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): Promise<void> {
  // swipe accepts 0–1 normalized coordinates directly.
  const res = await runConductor(
    ["swipe", "--start", `${round(x1)},${round(y1)}`, "--end", `${round(x2)},${round(y2)}`, ...deviceArgs(deviceId)],
    20_000,
  );
  if (res.code !== 0) throw new Error(res.stderr.trim() || "swipe failed");
  appState.lastAction = `swipe ${x1},${y1} → ${x2},${y2}`;
}

/**
 * Press a hardware or remote key — `press-key`. This is how a tvOS device is
 * driven at all: it's focus-based, so there is nothing to tap.
 *
 * Deliberately no long-press option. `press-key --long-press` exists on the
 * CLI, but a flow's `pressKey` step takes a bare key (flow-runner.ts) and
 * Maestro's own `pressKey` is scalar-only — so a held press could be performed
 * but never recorded faithfully, and the flow would replay as a short press.
 */
export async function pressKey(deviceId: string, key: string): Promise<void> {
  const res = await runConductor(["press-key", key, ...deviceArgs(deviceId)], 20_000);
  if (res.code !== 0) throw new Error(res.stderr.trim() || `press-key ${key} failed`);
  appState.lastAction = `pressKey: ${key}`;
}

export async function inputText(deviceId: string, text: string): Promise<void> {
  const res = await runConductor(["input-text", text, ...deviceArgs(deviceId)], 20_000);
  if (res.code !== 0) throw new Error(res.stderr.trim() || "input-text failed");
  appState.lastAction = `inputText: "${text.slice(0, 24)}"`;
}

/**
 * Run a single arbitrary conductor command line (REPL). The command string is
 * split on whitespace respecting simple quotes.
 */
export async function runCommandLine(command: string, deviceId: string): Promise<CommandResult> {
  const args = tokenize(command);
  if (args.length === 0) return { ok: false, engine: "conductor", output: "Empty command" };
  const res = await runConductor([...args, ...deviceArgs(deviceId)], 60_000);
  return {
    ok: res.code === 0,
    engine: "conductor",
    output: (res.stdout + (res.stderr ? `\n${res.stderr}` : "")).trim(),
  };
}

function tokenize(input: string): string[] {
  const matches = input.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return matches.map((t) => t.replace(/^['"]|['"]$/g, ""));
}

function safeJson<T>(text: string): T | null {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    // Tolerate log chatter around the payload: parse the widest brace-delimited
    // span instead of giving up on the whole string.
    const start = trimmed.search(/[[{]/);
    const end = Math.max(trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]"));
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as T;
    } catch {
      return null;
    }
  }
}
