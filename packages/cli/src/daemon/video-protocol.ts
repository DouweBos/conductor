/**
 * Streaming device-video protocol (conductor ⇄ subscribers).
 *
 * The capture counterpart to input-protocol.ts. A persistent per-device
 * WebSocket carries a low-latency H.264 stream: on connect the server sends one
 * JSON `config` frame (codec + dimensions + SPS/PPS), then a sequence of
 * **binary** frames, each a single H.264 Annex B access unit (keyframe-led). One
 * capture feeds N subscribers (fan-out); a late joiner always gets the cached
 * config + a fresh keyframe immediately.
 *
 * Web devices advertise a different codec (JPEG over CDP screencast) in the same
 * `config` frame so clients pick a decoder from the wire, not the URL.
 *
 * See docs/device-video-stream.md for the design.
 */

export const VIDEO_PROTOCOL_VERSION = 1;

export type VideoPlatform = 'ios' | 'tvos' | 'android' | 'web';

/** Wire codec advertised in the config frame. */
export type VideoCodec = 'h264' | 'jpeg';

/**
 * First (and only JSON) frame the server sends. Everything after it on the
 * socket is binary: one access unit per message. `sps`/`pps`/`avcC` are
 * base64-encoded raw NAL bodies (no Annex B start codes) so a WebCodecs client
 * can build a VideoDecoderConfig without parsing the elementary stream itself.
 */
export interface VideoConfigFrame {
  t: 'config';
  protocol: number;
  device: string;
  platform: VideoPlatform;
  codec: VideoCodec;
  /** Coded pixel dimensions of the encoded stream. */
  width: number;
  height: number;
  /** Display rotation in degrees (0 for simulators; carried for parity with device streams). */
  rotation: number;
  /** Nominal capture frame rate. */
  fps: number;
  /** avc1.PPCCLL codec string (h264 only). */
  codecString?: string;
  /** base64 SPS NAL (with its 1-byte NAL header, no start code) — h264 only. */
  sps?: string;
  /** base64 PPS NAL — h264 only. */
  pps?: string;
  /** base64 AVCDecoderConfigurationRecord (SPS+PPS) — h264 only. */
  avcC?: string;
}

/** Non-fatal notice (e.g. capture backend restarted). */
export interface VideoNoticeFrame {
  t: 'notice';
  code: string;
  msg: string;
}

export type VideoServerFrame = VideoConfigFrame | VideoNoticeFrame;

/** In-daemon config (Buffers, not base64) — serialized to a VideoConfigFrame per-subscriber. */
export interface VideoConfig {
  codec: VideoCodec;
  width: number;
  height: number;
  rotation: number;
  fps: number;
  codecString?: string;
  sps?: Buffer;
  pps?: Buffer;
  avcC?: Buffer;
}

/** Serialize an in-daemon config into the JSON frame sent to a subscriber. */
export function toConfigFrame(
  cfg: VideoConfig,
  device: string,
  platform: VideoPlatform
): VideoConfigFrame {
  return {
    t: 'config',
    protocol: VIDEO_PROTOCOL_VERSION,
    device,
    platform,
    codec: cfg.codec,
    width: cfg.width,
    height: cfg.height,
    rotation: cfg.rotation,
    fps: cfg.fps,
    codecString: cfg.codecString,
    sps: cfg.sps ? cfg.sps.toString('base64') : undefined,
    pps: cfg.pps ? cfg.pps.toString('base64') : undefined,
    avcC: cfg.avcC ? cfg.avcC.toString('base64') : undefined,
  };
}
