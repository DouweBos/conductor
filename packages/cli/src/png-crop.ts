/**
 * Minimal PNG cropper — decodes 8-bit RGB / RGBA / grayscale / grayscale+alpha
 * PNGs, crops to a rect, re-encodes with filter type 0 (None).
 *
 * Used by `take-screenshot --id/--text/<query>` to return only the pixels
 * inside a resolved element's bounds.
 */
import zlib from 'zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface PngDimensions {
  width: number;
  height: number;
}

/** Read width/height from a PNG IHDR chunk. Throws if `buf` is not a PNG. */
export function readPngDimensions(buf: Buffer): PngDimensions {
  if (buf.length < 24 || !SIGNATURE.equals(buf.subarray(0, 8))) {
    throw new Error('not a PNG');
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

interface IHDR {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
}

function bytesPerPixel(colorType: number): number {
  switch (colorType) {
    case 0:
      return 1; // grayscale
    case 2:
      return 3; // RGB
    case 3:
      return 1; // palette (unsupported below)
    case 4:
      return 2; // grayscale + alpha
    case 6:
      return 4; // RGBA
    default:
      throw new Error(`unsupported PNG color type ${colorType}`);
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function unfilter(filtered: Buffer, w: number, h: number, bpp: number): Buffer {
  const stride = w * bpp;
  const out = Buffer.alloc(stride * h);
  let inOff = 0;
  for (let y = 0; y < h; y++) {
    const filter = filtered[inOff++];
    const rowOff = y * stride;
    for (let x = 0; x < stride; x++) {
      const raw = filtered[inOff++];
      const left = x >= bpp ? out[rowOff + x - bpp] : 0;
      const up = y > 0 ? out[rowOff - stride + x] : 0;
      const upLeft = x >= bpp && y > 0 ? out[rowOff - stride + x - bpp] : 0;
      let v: number;
      switch (filter) {
        case 0:
          v = raw;
          break;
        case 1:
          v = raw + left;
          break;
        case 2:
          v = raw + up;
          break;
        case 3:
          v = raw + ((left + up) >> 1);
          break;
        case 4:
          v = raw + paeth(left, up, upLeft);
          break;
        default:
          throw new Error(`unsupported PNG filter ${filter}`);
      }
      out[rowOff + x] = v & 0xff;
    }
  }
  return out;
}

function writeChunk(out: Buffer[], type: string, data: Buffer): void {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcInput = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput), 0);
  out.push(len, typeBuf, data, crc);
}

/**
 * Crop a PNG buffer to the given rect. Coordinates are in PNG pixel space;
 * `x`/`y`/`width`/`height` are clamped to the PNG canvas before cropping.
 * Throws if the rect lies fully outside the canvas.
 */
export function cropPng(
  buf: Buffer,
  rect: { x: number; y: number; width: number; height: number }
): Buffer {
  if (buf.length < 8 || !SIGNATURE.equals(buf.subarray(0, 8))) {
    throw new Error('not a PNG');
  }

  let off = 8;
  let ihdr: IHDR | null = null;
  const idatParts: Buffer[] = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    off += 4;
    const type = buf.subarray(off, off + 4).toString('ascii');
    off += 4;
    const data = buf.subarray(off, off + len);
    off += len;
    off += 4; // CRC

    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data.readUInt8(8),
        colorType: data.readUInt8(9),
      };
    } else if (type === 'IDAT') {
      idatParts.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }

  if (!ihdr) throw new Error('PNG missing IHDR');
  if (ihdr.bitDepth !== 8) {
    throw new Error(`unsupported PNG bit depth ${ihdr.bitDepth} (only 8 supported)`);
  }
  if (ihdr.colorType === 3) {
    throw new Error('palette PNGs are not supported for cropping');
  }
  const bpp = bytesPerPixel(ihdr.colorType);

  // Clamp crop rect to canvas bounds
  const cx = Math.max(0, Math.min(Math.floor(rect.x), ihdr.width));
  const cy = Math.max(0, Math.min(Math.floor(rect.y), ihdr.height));
  const cx2 = Math.max(0, Math.min(Math.floor(rect.x + rect.width), ihdr.width));
  const cy2 = Math.max(0, Math.min(Math.floor(rect.y + rect.height), ihdr.height));
  const cw = cx2 - cx;
  const ch = cy2 - cy;
  if (cw <= 0 || ch <= 0) {
    throw new Error('crop rect is outside the screenshot canvas');
  }

  const filtered = zlib.inflateSync(Buffer.concat(idatParts));
  const raw = unfilter(filtered, ihdr.width, ihdr.height, bpp);

  const srcStride = ihdr.width * bpp;
  const dstStride = cw * bpp;
  // New filtered scanlines with filter byte 0 (None) prefix.
  const filteredOut = Buffer.alloc(ch * (dstStride + 1));
  for (let y = 0; y < ch; y++) {
    filteredOut[y * (dstStride + 1)] = 0;
    raw.copy(
      filteredOut,
      y * (dstStride + 1) + 1,
      (cy + y) * srcStride + cx * bpp,
      (cy + y) * srcStride + cx * bpp + dstStride
    );
  }
  const idat = zlib.deflateSync(filteredOut);

  const chunks: Buffer[] = [SIGNATURE];
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(cw, 0);
  ihdrData.writeUInt32BE(ch, 4);
  ihdrData.writeUInt8(ihdr.bitDepth, 8);
  ihdrData.writeUInt8(ihdr.colorType, 9);
  ihdrData.writeUInt8(0, 10); // compression
  ihdrData.writeUInt8(0, 11); // filter method
  ihdrData.writeUInt8(0, 12); // interlace
  writeChunk(chunks, 'IHDR', ihdrData);
  writeChunk(chunks, 'IDAT', idat);
  writeChunk(chunks, 'IEND', Buffer.alloc(0));

  return Buffer.concat(chunks);
}
