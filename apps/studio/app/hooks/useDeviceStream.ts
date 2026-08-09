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
 * `device_video_frame:{id}` (per access unit). We decode in Annex B mode (no
 * decoder `description`), which works because conductor re-prepends SPS/PPS
 * ahead of every keyframe.
 */
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
        const bytes = payload.data instanceof Uint8Array ? payload.data : new Uint8Array(payload.data);
        decoder.decode(
          new EncodedVideoChunk({
            type: payload.keyFrame ? "key" : "delta",
            timestamp: payload.timestamp,
            data: bytes,
          }),
        );
      } catch (err) {
        setState((s) => ({ ...s, error: err instanceof Error ? err.message : String(err) }));
      }
    };

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
      unlistenConfig();
      unlistenFrame();
      decoderRef.current?.close();
      decoderRef.current = null;
      setState({ connected: false, width: 0, height: 0, error: null });
    };
  }, [deviceId, canvasRef]);

  return state;
}
