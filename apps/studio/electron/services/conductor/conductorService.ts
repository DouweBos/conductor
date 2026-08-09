import type {
  CaptureElement,
  CaptureUiResult,
  CommandResult,
  DeviceInfo,
  Platform,
} from "../../../app/lib/types";
import { appState } from "../../state";
import { resolveConductor } from "../maestro/maestroService";
import { run } from "../util/exec";

async function runConductor(args: string[], timeout = 60_000) {
  const resolved = await resolveConductor();
  if (!resolved) {
    throw new Error(
      "Conductor CLI not found. Install it globally, set CONDUCTOR_BIN, or build packages/cli.",
    );
  }
  return run(resolved.bin, [...resolved.prefixArgs, ...args], { timeout });
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
  const rows = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { devices?: unknown[] })?.devices)
      ? (parsed as { devices: unknown[] }).devices
      : [];
  return rows.map(normalizeDevice).filter((d): d is DeviceInfo => d !== null);
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
    : rawState.includes("shut")
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
  const res = await runConductor(["capture-ui", ...deviceArgs(deviceId), "--json"], 45_000);
  if (res.code !== 0) {
    throw new Error(res.stderr.trim() || "conductor capture-ui failed");
  }
  const bundle = safeJson<CaptureBundle>(res.stdout);
  if (!bundle) throw new Error("capture-ui returned no parseable bundle");
  return mapBundle(deviceId, bundle);
}

interface CaptureBundle {
  device?: { width?: number; height?: number };
  screenshot?: { encoding?: string; data?: string };
  a11ySnapshot?: A11yEntry[];
}

interface A11yEntry {
  ref: string;
  label?: string;
  value?: string;
  role?: string;
  hint?: string;
  frame?: { x?: number; y?: number; width?: number; height?: number };
}

function mapBundle(deviceId: string, bundle: CaptureBundle): CaptureUiResult {
  const width = bundle.device?.width ?? 0;
  const height = bundle.device?.height ?? 0;
  const screenshot = bundle.screenshot?.data
    ? `data:image/${bundle.screenshot.encoding ?? "png"};base64,${bundle.screenshot.data}`
    : undefined;
  const children: CaptureElement[] = (bundle.a11ySnapshot ?? []).map((e) => ({
    ref: e.ref,
    role: e.role || undefined,
    text: e.label || e.value || e.hint || undefined,
    bounds: e.frame
      ? {
          x: e.frame.x ?? 0,
          y: e.frame.y ?? 0,
          width: e.frame.width ?? 0,
          height: e.frame.height ?? 0,
        }
      : undefined,
    children: [],
  }));
  return {
    deviceId,
    width,
    height,
    screenshot,
    root: { ref: "root", role: "Screen", text: "Screen", children },
  };
}

function dims(deviceId: string): { width: number; height: number } | null {
  const session = appState.deviceStreams.get(deviceId);
  if (session?.width && session?.height) {
    return { width: session.width, height: session.height };
  }
  return null;
}

/** x/y are normalized 0..1 relative to the device screen. */
export async function tap(deviceId: string, x: number, y: number): Promise<void> {
  const d = dims(deviceId);
  const at = d ? `${Math.round(x * d.width)},${Math.round(y * d.height)}` : `${x},${y}`;
  const res = await runConductor(["tap-on", "--at", at, ...deviceArgs(deviceId)], 20_000);
  if (res.code !== 0) throw new Error(res.stderr.trim() || "tap failed");
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
    ["swipe", "--start", `${x1},${y1}`, "--end", `${x2},${y2}`, ...deviceArgs(deviceId)],
    20_000,
  );
  if (res.code !== 0) throw new Error(res.stderr.trim() || "swipe failed");
}

export async function inputText(deviceId: string, text: string): Promise<void> {
  const res = await runConductor(["input-text", text, ...deviceArgs(deviceId)], 20_000);
  if (res.code !== 0) throw new Error(res.stderr.trim() || "input-text failed");
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
  // Tolerate leading log chatter by parsing the last JSON-looking chunk.
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const start = trimmed.search(/[[{]/);
    if (start > 0) {
      try {
        return JSON.parse(trimmed.slice(start)) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}
