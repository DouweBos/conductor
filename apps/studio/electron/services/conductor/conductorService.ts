import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
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
      "Conductor CLI not found. Install it globally, set CONDUCTOR_BIN, or build packages/cli.",
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
  return rows
    .map(normalizeDevice)
    .filter((d): d is DeviceInfo => d !== null)
    .filter((d) => !seen.has(d.id) && seen.add(d.id));
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
  return {
    id,
    name: String(r.name ?? r.model ?? id),
    platform,
    state,
  };
}

function normalizePlatform(value: string): Platform {
  const v = value.toLowerCase();
  if (v.includes("android")) return "android";
  if (v.includes("tv")) return "tvos";
  if (v.includes("web")) return "web";
  return "ios";
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
  void recordCapture(result, action);
  return result;
}

interface CaptureBundle {
  device?: { width?: number; height?: number };
  screenshot?: { encoding?: string; data?: string };
  a11ySnapshot?: A11yEntry[];
  hierarchy?: { axElement?: unknown };
}

interface A11yEntry {
  nodeId?: string;
  ref: string;
  label?: string;
  value?: string;
  role?: string;
  hint?: string;
  /** Conductor reports frames as x/y/w/h in device points. */
  frame?: { x?: number; y?: number; w?: number; h?: number };
}

function mapBundle(deviceId: string, bundle: CaptureBundle): CaptureUiResult {
  const width = bundle.device?.width ?? 0;
  const height = bundle.device?.height ?? 0;
  const screenshot = bundle.screenshot?.data
    ? `data:image/${bundle.screenshot.encoding ?? "png"};base64,${bundle.screenshot.data}`
    : undefined;
  const root: CaptureElement = { ref: "root", role: "Screen", text: "Screen", children: [] };
  const ids = indexIdentifiers(bundle.hierarchy?.axElement);
  const elements = (bundle.a11ySnapshot ?? []).map(toElement);
  // The flat snapshot carries no accessibility id, so borrow it from the full
  // hierarchy by frame — it's what selectors should prefer over text.
  for (const el of elements) {
    if (el.bounds) el.identifier = ids.get(frameKey(el.bounds)) || undefined;
  }
  nest(root, elements);
  return { deviceId, width, height, screenshot, root };
}

function toElement(e: A11yEntry): CaptureElement & { nodeId: string } {
  return {
    nodeId: e.nodeId ?? "",
    ref: e.ref,
    role: e.role || undefined,
    text: e.label || e.value || e.hint || undefined,
    bounds: e.frame
      ? { x: e.frame.x ?? 0, y: e.frame.y ?? 0, width: e.frame.w ?? 0, height: e.frame.h ?? 0 }
      : undefined,
    children: [],
  };
}

function frameKey(b: { x: number; y: number; width: number; height: number }): string {
  return `${Math.round(b.x)},${Math.round(b.y)},${Math.round(b.width)},${Math.round(b.height)}`;
}

/** Map frame -> accessibility identifier, walking the platform view hierarchy. */
function indexIdentifiers(node: unknown, into = new Map<string, string>()): Map<string, string> {
  if (!node || typeof node !== "object") return into;
  const n = node as Record<string, unknown>;
  const id = String(n.identifier ?? n.resourceId ?? n["resource-id"] ?? "").trim();
  const frame = n.frame as Record<string, number> | undefined;
  if (id && frame) {
    const x = frame.X ?? frame.x ?? 0;
    const y = frame.Y ?? frame.y ?? 0;
    const width = frame.Width ?? frame.width ?? 0;
    const height = frame.Height ?? frame.height ?? 0;
    const key = frameKey({ x, y, width, height });
    if (!into.has(key)) into.set(key, id);
  }
  for (const child of (n.children as unknown[]) ?? []) indexIdentifiers(child, into);
  return into;
}

/**
 * Rebuild the hierarchy from the flat snapshot: `nodeId` is a dot-path of child
 * indices, so the nearest ancestor already in the map is an element's parent.
 */
function nest(root: CaptureElement, elements: (CaptureElement & { nodeId: string })[]): void {
  const byPath = new Map<string, CaptureElement>();
  for (const el of elements) {
    const { nodeId, ...node } = el;
    let parent = root;
    const parts = nodeId.split(".");
    for (let i = parts.length - 1; i > 0; i--) {
      const found = byPath.get(parts.slice(0, i).join("."));
      if (found) {
        parent = found;
        break;
      }
    }
    parent.children!.push(node);
    if (nodeId) byPath.set(nodeId, node);
  }
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
