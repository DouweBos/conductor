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
 * Decode the conductor daemon's H.264 feed onto a canvas via WebCodecs. The
 * main process forwards `device_video_config:{id}` (once) and
 * `device_video_frame:{id}` (per access unit, rewritten to AVCC). The daemon
 * sends bare IDRs, so the parameter sets reach the decoder only through the
 * avcC `description` — same configuration Argus's device streams use.
 */

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Frame bytes survive IPC as a Uint8Array or, sometimes, a plain object. */
function toBytes(data: Uint8Array): Uint8Array {
  if (data instanceof Uint8Array) return data;
  return new Uint8Array(Object.values(data as unknown as Record<string, number>));
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
  // A decoder can only start — or resync after an error — on a keyframe.
  const awaitingKeyRef = useRef(true);

  useEffect(() => {
    if (!deviceId) return;
    awaitingKeyRef.current = true;

    if (typeof VideoDecoder === "undefined") {
      setState((s) => ({ ...s, error: "WebCodecs is unavailable in this runtime." }));
      return;
    }

    const drawFrame = (frame: VideoFrame) => {
      const canvas = canvasRef.current;
      if (canvas) {
        // The decoded size wins — it follows device rotation.
        if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
          canvas.width = frame.displayWidth;
          canvas.height = frame.displayHeight;
          setState((s) => ({ ...s, width: frame.displayWidth, height: frame.displayHeight }));
        }
        const ctx = canvas.getContext("2d");
        if (ctx) ctx.drawImage(frame, 0, 0);
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
        codedWidth: config.width,
        codedHeight: config.height,
        description: config.avcC ? base64ToBytes(config.avcC) : undefined,
        optimizeForLatency: true,
      });
      decoderRef.current = decoder;
      awaitingKeyRef.current = true;
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
      if (awaitingKeyRef.current) {
        if (!payload.keyFrame) return;
        awaitingKeyRef.current = false;
      }
      // Drop deltas when the decoder falls behind — an unbounded queue is how
      // the renderer runs out of memory on a fast stream.
      if (!payload.keyFrame && decoder.decodeQueueSize > 8) return;
      try {
        decoder.decode(
          new EncodedVideoChunk({
            type: payload.keyFrame ? "key" : "delta",
            timestamp: payload.timestamp * 1000, // the field is microseconds
            data: toBytes(payload.data),
          }),
        );
      } catch {
        awaitingKeyRef.current = true; // resync on the next keyframe
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
