import { WebSocket } from "ws";

import type { DeviceStreamInfo, Platform, VideoConfig } from "../../../app/lib/types";
import { broadcastToRenderers } from "../../broadcast";
import { appState } from "../../state";
import { resolveConductor } from "../maestro/maestroService";
import { run } from "../util/exec";

export interface DeviceStreamSession {
  deviceId: string;
  platform: Platform;
  url: string;
  streamPort: number;
  codec: string;
  width: number;
  height: number;
  ws: WebSocket | null;
  /** Last config frame, replayed to renderers that subscribe after it arrived. */
  config: VideoConfig | null;
}

interface StreamServerResult {
  device?: string;
  platform?: string;
  streamPort?: number;
  url?: string;
  codec?: string;
}

export async function startDeviceStream(
  deviceId: string,
  platform: Platform,
): Promise<DeviceStreamInfo> {
  // Reuse an existing live session.
  const existing = appState.deviceStreams.get(deviceId);
  if (existing?.ws && existing.ws.readyState === WebSocket.OPEN) {
    return toInfo(existing);
  }

  const resolved = await resolveConductor();
  if (!resolved) throw new Error("Conductor CLI not found — cannot start the device stream.");

  const res = await run(
    resolved.bin,
    [...resolved.prefixArgs, "stream-server", "--device", deviceId, "--json"],
    // A cold daemon has to boot the driver first, which outlasts a short timeout.
    { timeout: 180_000 },
  );
  if (res.code !== 0) {
    throw new Error(res.stderr.trim() || "conductor stream-server failed");
  }
  const info = parseStreamServer(res.stdout);
  const url = info.url ?? `ws://127.0.0.1:${info.streamPort}/stream?device=${encodeURIComponent(deviceId)}&platform=${platform}`;
  if (!info.streamPort) throw new Error("stream-server did not report a streamPort (capture backend missing?)");

  const session: DeviceStreamSession = {
    deviceId,
    platform,
    url,
    streamPort: info.streamPort,
    codec: info.codec ?? "h264",
    width: 0,
    height: 0,
    ws: null,
    config: null,
  };
  appState.deviceStreams.set(deviceId, session);
  connect(session);
  return toInfo(session);
}

function connect(session: DeviceStreamSession): void {
  const ws = new WebSocket(session.url);
  session.ws = ws;
  ws.binaryType = "nodebuffer";

  ws.on("message", (data: Buffer, isBinary: boolean) => {
    if (!isBinary) {
      handleConfig(session, data.toString("utf8"));
      return;
    }
    const bytes = new Uint8Array(data);
    broadcastToRenderers(`device_video_frame:${session.deviceId}`, {
      data: bytes,
      keyFrame: isAnnexBKeyframe(bytes),
      timestamp: Date.now(),
    });
  });

  ws.on("close", () => {
    if (session.ws === ws) session.ws = null;
    broadcastToRenderers(`device_video_error:${session.deviceId}`, "Video stream closed.");
  });
  ws.on("error", (err: Error) => {
    broadcastToRenderers(`device_video_error:${session.deviceId}`, err.message);
  });
}

function handleConfig(session: DeviceStreamSession, text: string): void {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (raw.t && raw.t !== "config") return; // notices etc.
    const config: VideoConfig = {
      codec: String(raw.codec ?? session.codec),
      width: Number(raw.width ?? 0),
      height: Number(raw.height ?? 0),
      rotation: Number(raw.rotation ?? 0),
      codecString: raw.codecString ? String(raw.codecString) : undefined,
      avcC: raw.avcC ? String(raw.avcC) : undefined,
      sps: raw.sps ? String(raw.sps) : undefined,
      pps: raw.pps ? String(raw.pps) : undefined,
    };
    session.width = config.width;
    session.height = config.height;
    session.config = config;
    broadcastToRenderers(`device_video_config:${session.deviceId}`, config);
  } catch {
    // ignore malformed config
  }
}

/** Detect an IDR (type 5) NAL in an Annex B access unit. */
function isAnnexBKeyframe(bytes: Uint8Array): boolean {
  for (let i = 0; i + 4 < bytes.length; i++) {
    const startShort = bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1;
    const startLong =
      bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 0 && bytes[i + 3] === 1;
    if (startShort || startLong) {
      const nalStart = startLong ? i + 4 : i + 3;
      const nalType = bytes[nalStart] & 0x1f;
      if (nalType === 5) return true;
      if (nalType === 1) return false;
    }
  }
  return false;
}

/** The cached config for a live stream, for renderers that missed the broadcast. */
export function getDeviceStreamConfig(deviceId: string): VideoConfig | null {
  return appState.deviceStreams.get(deviceId)?.config ?? null;
}

export function stopDeviceStream(deviceId: string): void {
  const session = appState.deviceStreams.get(deviceId);
  if (session?.ws) {
    try {
      session.ws.close();
    } catch {
      // ignore
    }
  }
  appState.deviceStreams.delete(deviceId);
}

export function disposeAllDeviceStreams(): void {
  for (const id of [...appState.deviceStreams.keys()]) {
    stopDeviceStream(id);
  }
}

function parseStreamServer(stdout: string): StreamServerResult {
  const trimmed = stdout.trim();
  const start = trimmed.search(/\{/);
  if (start < 0) return {};
  try {
    return JSON.parse(trimmed.slice(start)) as StreamServerResult;
  } catch {
    return {};
  }
}

function toInfo(session: DeviceStreamSession): DeviceStreamInfo {
  return {
    deviceId: session.deviceId,
    platform: session.platform,
    url: session.url,
    streamPort: session.streamPort,
    codec: session.codec,
  };
}
