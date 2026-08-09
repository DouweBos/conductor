import { type RefObject, useEffect, useRef, useState } from "react";

import { listen } from "../lib/events";
import { getDeviceStreamConfig } from "../lib/ipc";
import type { VideoConfig, VideoFrame as FramePayload } from "../lib/types";

export interface DeviceStreamState {
  connected: boolean;
  width: number;
  height: number;
  error: string | null;
}

/**
 * Decode the conductor daemon's H.264 Annex B feed onto a canvas via WebCodecs.
 * The main process forwards `device_video_config:{id}` (once) and
 * `device_video_frame:{id}` (per access unit). The daemon sends bare IDR access
 * units — the parameter sets arrive only in the config frame — so we re-attach
 * SPS/PPS to every keyframe and decode in Annex B mode (no `description`).
 */

const START_CODE = new Uint8Array([0, 0, 0, 1]);

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** SPS/PPS as an Annex B prefix, to lead every keyframe. */
function parameterSets(config: VideoConfig): Uint8Array | null {
  if (!config.sps || !config.pps) return null;
  const sps = base64ToBytes(config.sps);
  const pps = base64ToBytes(config.pps);
  const out = new Uint8Array(START_CODE.length * 2 + sps.length + pps.length);
  let at = 0;
  for (const part of [START_CODE, sps, START_CODE, pps]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function withPrefix(prefix: Uint8Array | null, bytes: Uint8Array): Uint8Array {
  if (!prefix) return bytes;
  const out = new Uint8Array(prefix.length + bytes.length);
  out.set(prefix, 0);
  out.set(bytes, prefix.length);
  return out;
}
export function useDeviceStream(
  deviceId: string | null,
  canvasRef: RefObject<HTMLCanvasElement | null>,
): DeviceStreamState {
  const [state, setState] = useState<DeviceStreamState>({
    connected: false,
    width: 0,
    height: 0,
    error: null,
  });
  const decoderRef = useRef<VideoDecoder | null>(null);
  const sawKeyRef = useRef(false);
  const paramSetsRef = useRef<Uint8Array | null>(null);

  useEffect(() => {
    if (!deviceId) return;
    sawKeyRef.current = false;

    if (typeof VideoDecoder === "undefined") {
      setState((s) => ({ ...s, error: "WebCodecs is unavailable in this runtime." }));
      return;
    }

    const drawFrame = (frame: VideoFrame) => {
      const canvas = canvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext("2d");
        if (ctx) ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
      }
      frame.close();
    };

    const setupDecoder = (config: VideoConfig) => {
      decoderRef.current?.close();
      const decoder = new VideoDecoder({
        output: drawFrame,
        error: (err) => setState((s) => ({ ...s, error: err.message })),
      });
      decoder.configure({
        codec: config.codecString || "avc1.640028",
        optimizeForLatency: true,
      });
      decoderRef.current = decoder;
      paramSetsRef.current = parameterSets(config);
      sawKeyRef.current = false;
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = config.width;
        canvas.height = config.height;
      }
      setState({ connected: true, width: config.width, height: config.height, error: null });
    };

    const onFrame = (payload: FramePayload) => {
      const decoder = decoderRef.current;
      if (!decoder || decoder.state !== "configured") return;
      if (payload.keyFrame) sawKeyRef.current = true;
      if (!sawKeyRef.current) return; // wait for the first IDR
      // Drop deltas when the decoder falls behind — an unbounded queue is how
      // the renderer runs out of memory on a fast stream.
      if (!payload.keyFrame && decoder.decodeQueueSize > 8) return;
      try {
        const raw = payload.data instanceof Uint8Array ? payload.data : new Uint8Array(payload.data);
        const bytes = payload.keyFrame ? withPrefix(paramSetsRef.current, raw) : raw;
        decoder.decode(
          new EncodedVideoChunk({
            type: payload.keyFrame ? "key" : "delta",
            timestamp: payload.timestamp * 1000, // the field is microseconds
            data: bytes,
          }),
        );
      } catch (err) {
        setState((s) => ({ ...s, error: err instanceof Error ? err.message : String(err) }));
      }
    };

    const unlistenError = listen<string>(`device_video_error:${deviceId}`, (message) =>
      setState((s) => ({ ...s, error: message })),
    );
    const unlistenConfig = listen<VideoConfig>(`device_video_config:${deviceId}`, setupDecoder);
    const unlistenFrame = listen<FramePayload>(`device_video_frame:${deviceId}`, onFrame);

    // The stream's single config frame arrives before this hook mounts whenever
    // the daemon is already up, so pull the cached one instead of waiting.
    let cancelled = false;
    void getDeviceStreamConfig(deviceId)
      .then((config) => {
        if (config && !cancelled && !decoderRef.current) setupDecoder(config);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState((s) => ({ ...s, error: err instanceof Error ? err.message : String(err) }));
        }
      });

    return () => {
      cancelled = true;
      unlistenError();
      unlistenConfig();
      unlistenFrame();
      decoderRef.current?.close();
      decoderRef.current = null;
      setState({ connected: false, width: 0, height: 0, error: null });
    };
  }, [deviceId, canvasRef]);

  return state;
}
