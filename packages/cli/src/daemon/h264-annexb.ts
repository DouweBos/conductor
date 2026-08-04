/**
 * H.264 Annex B streaming parser (daemon side).
 *
 * Splits the raw Annex B byte stream from the capture backend into access units,
 * extracts SPS/PPS to build the stream config, and preserves each access unit
 * **in Annex B form** (start codes intact) for forwarding to subscribers — the
 * wire contract is "config + a sequence of Annex B access units, keyframe-led".
 *
 * Ported from Argus's electron/services/simulator/h264-parser.ts; the SPS
 * bit-reader is identical, but access units are emitted as Annex B rather than
 * converted to AVCC length-prefix (that conversion is left to WebCodecs clients).
 */

import { type VideoConfig } from './video-protocol.js';

const NAL_SLICE = 1;
const NAL_IDR = 5;
const NAL_SPS = 7;
const NAL_PPS = 8;

// ── Exp-Golomb reader (minimal, for SPS parsing) ────────────────────────────

class ExpGolombReader {
  private byteOffset = 0;
  private bitOffset = 0;
  constructor(private readonly data: Uint8Array) {}

  private readBit(): number {
    if (this.byteOffset >= this.data.length) return 0;
    const bit = (this.data[this.byteOffset] >> (7 - this.bitOffset)) & 1;
    this.bitOffset++;
    if (this.bitOffset === 8) {
      this.bitOffset = 0;
      this.byteOffset++;
    }
    return bit;
  }

  readBits(n: number): number {
    let val = 0;
    for (let i = 0; i < n; i++) val = (val << 1) | this.readBit();
    return val;
  }

  readUE(): number {
    let zeros = 0;
    while (this.readBit() === 0 && zeros < 31) zeros++;
    if (zeros === 0) return 0;
    return (1 << zeros) - 1 + this.readBits(zeros);
  }

  readSE(): number {
    const val = this.readUE();
    return val % 2 === 0 ? -(val >> 1) : (val + 1) >> 1;
  }
}

interface SpsInfo {
  profileIdc: number;
  constraintFlags: number;
  levelIdc: number;
  width: number;
  height: number;
}

/** Parse the SPS fields needed for config. `body` is the NAL after the header byte. */
function parseSps(body: Uint8Array): SpsInfo {
  const r = new ExpGolombReader(body);
  const profileIdc = r.readBits(8);
  const constraintFlags = r.readBits(8);
  const levelIdc = r.readBits(8);
  r.readUE(); // seq_parameter_set_id

  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134].includes(profileIdc)) {
    const chromaFormatIdc = r.readUE();
    if (chromaFormatIdc === 3) r.readBits(1);
    r.readUE(); // bit_depth_luma_minus8
    r.readUE(); // bit_depth_chroma_minus8
    r.readBits(1); // qpprime_y_zero_transform_bypass_flag
    if (r.readBits(1)) {
      const count = chromaFormatIdc !== 3 ? 8 : 12;
      for (let i = 0; i < count; i++) {
        if (r.readBits(1)) {
          const size = i < 6 ? 16 : 64;
          let lastScale = 8;
          let nextScale = 8;
          for (let j = 0; j < size; j++) {
            if (nextScale !== 0) nextScale = (lastScale + r.readSE() + 256) % 256;
            lastScale = nextScale === 0 ? lastScale : nextScale;
          }
        }
      }
    }
  }

  r.readUE(); // log2_max_frame_num_minus4
  const picOrderCntType = r.readUE();
  if (picOrderCntType === 0) {
    r.readUE();
  } else if (picOrderCntType === 1) {
    r.readBits(1);
    r.readSE();
    r.readSE();
    const n = r.readUE();
    for (let i = 0; i < n; i++) r.readSE();
  }

  r.readUE(); // max_num_ref_frames
  r.readBits(1); // gaps_in_frame_num_value_allowed_flag

  const picWidthInMbsMinus1 = r.readUE();
  const picHeightInMapUnitsMinus1 = r.readUE();
  const frameMbsOnlyFlag = r.readBits(1);

  let width = (picWidthInMbsMinus1 + 1) * 16;
  let height = (2 - frameMbsOnlyFlag) * (picHeightInMapUnitsMinus1 + 1) * 16;

  if (!frameMbsOnlyFlag) r.readBits(1);
  r.readBits(1); // direct_8x8_inference_flag

  if (r.readBits(1)) {
    // frame_cropping_flag — 4:2:0 crop units are 2px
    const cl = r.readUE();
    const cr = r.readUE();
    const ct = r.readUE();
    const cb = r.readUE();
    width -= (cl + cr) * 2;
    height -= (ct + cb) * 2;
  }

  return { profileIdc, constraintFlags, levelIdc, width, height };
}

function buildCodecString(info: SpsInfo): string {
  const pp = info.profileIdc.toString(16).padStart(2, '0');
  const cc = info.constraintFlags.toString(16).padStart(2, '0');
  const ll = info.levelIdc.toString(16).padStart(2, '0');
  return `avc1.${pp}${cc}${ll}`;
}

/** AVCDecoderConfigurationRecord from raw SPS/PPS NAL bodies (with NAL header byte). */
function buildAvcC(sps: Uint8Array, pps: Uint8Array): Buffer {
  const buf = Buffer.alloc(11 + sps.length + pps.length);
  buf[0] = 1; // configurationVersion
  buf[1] = sps[1]; // profile
  buf[2] = sps[2]; // compatibility
  buf[3] = sps[3]; // level
  buf[4] = 0xff; // lengthSizeMinusOne = 3
  buf[5] = 0xe1; // numOfSPS = 1
  buf.writeUInt16BE(sps.length, 6);
  Buffer.from(sps).copy(buf, 8);
  const off = 8 + sps.length;
  buf[off] = 1; // numOfPPS
  buf.writeUInt16BE(pps.length, off + 1);
  Buffer.from(pps).copy(buf, off + 3);
  return buf;
}

/** Find the next Annex B start code (00 00 01 or 00 00 00 01). */
function findStartCode(buf: Uint8Array, offset: number): { index: number; length: number } | null {
  for (let i = offset; i < buf.length - 2; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0) {
      if (buf[i + 2] === 1) return { index: i, length: 3 };
      if (buf[i + 2] === 0 && i + 3 < buf.length && buf[i + 3] === 1)
        return { index: i, length: 4 };
    }
  }
  return null;
}

export interface H264Callbacks {
  onConfig: (config: VideoConfig) => void;
  /** One access unit, in Annex B form (start codes intact). */
  onFrame: (annexB: Buffer, keyFrame: boolean) => void;
}

/**
 * Streaming Annex B parser. Feed raw capture bytes with push(); emits config
 * once SPS+PPS are seen, then one Annex B access unit per VCL frame.
 */
export class H264AnnexBParser {
  private buffer: Buffer = Buffer.alloc(0);
  private sps: Buffer | null = null;
  private pps: Buffer | null = null;
  private config: VideoConfig | null = null;
  // NALs (each Annex-B, start-code prefixed) buffered for the current access unit.
  private au: Buffer[] = [];
  private auIsKey = false;
  private readonly fps: number;

  constructor(
    private readonly cbs: H264Callbacks,
    fps = 30
  ) {
    this.fps = fps;
  }

  reset(): void {
    this.buffer = Buffer.alloc(0);
    this.sps = null;
    this.pps = null;
    this.config = null;
    this.au = [];
    this.auIsKey = false;
  }

  push(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    this.processBuffer();
  }

  private processBuffer(): void {
    let sc = findStartCode(this.buffer, 0);
    if (!sc) return;

    while (true) {
      const next = findStartCode(this.buffer, sc.index + sc.length);
      if (!next) break; // incomplete NAL — wait for more data

      const nal = this.buffer.subarray(sc.index + sc.length, next.index);
      // Keep the whole unit including start code so subscribers get Annex B.
      const withStartCode = this.buffer.subarray(sc.index, next.index);
      this.processNal(nal, withStartCode);
      sc = next;
    }

    // Retain the trailing (unterminated) NAL for the next push.
    if (sc.index > 0) this.buffer = Buffer.from(this.buffer.subarray(sc.index));

    // Guard against unbounded growth on a stuck stream.
    if (this.buffer.length > 4 * 1024 * 1024) {
      this.buffer = Buffer.from(this.buffer.subarray(-1024 * 1024));
    }
  }

  private processNal(nal: Buffer, withStartCode: Buffer): void {
    if (nal.length === 0) return;
    const nalType = nal[0] & 0x1f;

    if (nalType === NAL_SPS) {
      this.sps = Buffer.from(nal);
      this.emitConfigIfReady();
      return;
    }
    if (nalType === NAL_PPS) {
      this.pps = Buffer.from(nal);
      this.emitConfigIfReady();
      return;
    }

    if (nalType === NAL_IDR || nalType === NAL_SLICE) {
      // Flush any previously buffered AU before starting this VCL frame.
      if (this.au.length > 0) this.emitAccessUnit();
      this.auIsKey = nalType === NAL_IDR;
      this.au.push(Buffer.from(withStartCode));
      this.emitAccessUnit();
      return;
    }

    // SEI / AUD / other — attach to the current access unit.
    this.au.push(Buffer.from(withStartCode));
  }

  private emitAccessUnit(): void {
    if (this.au.length === 0) return;
    if (!this.config) {
      // Can't decode without config yet — drop until SPS/PPS arrive.
      this.au = [];
      this.auIsKey = false;
      return;
    }
    const data = this.au.length === 1 ? this.au[0] : Buffer.concat(this.au);
    this.cbs.onFrame(data, this.auIsKey);
    this.au = [];
    this.auIsKey = false;
  }

  private emitConfigIfReady(): void {
    if (this.config || !this.sps || !this.pps) return;
    const info = parseSps(this.sps.subarray(1));
    this.config = {
      codec: 'h264',
      width: info.width,
      height: info.height,
      rotation: 0,
      fps: this.fps,
      codecString: buildCodecString(info),
      sps: this.sps,
      pps: this.pps,
      avcC: buildAvcC(this.sps, this.pps),
    };
    this.cbs.onConfig(this.config);
  }
}
