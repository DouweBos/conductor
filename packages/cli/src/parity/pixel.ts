/**
 * Screenshot comparison for a parity checkpoint.
 *
 * Corroborating evidence, not the verdict — see the note at the top of diff.ts.
 * Screenshots of different sizes are compared after scaling the candidate onto
 * the reference with nearest-neighbour sampling: exact enough for "is this the
 * same screen", and it keeps a 2x/3x device pair comparable instead of skipped.
 */
import fs from 'fs';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import type { PixelResult } from './diff.js';

/** Nearest-neighbour resample to `width`×`height`. */
function resize(src: PNG, width: number, height: number): PNG {
  const out = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    const sy = Math.min(src.height - 1, Math.floor((y * src.height) / height));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(src.width - 1, Math.floor((x * src.width) / width));
      const from = (sy * src.width + sx) << 2;
      const to = (y * width + x) << 2;
      out.data[to] = src.data[from];
      out.data[to + 1] = src.data[from + 1];
      out.data[to + 2] = src.data[from + 2];
      out.data[to + 3] = src.data[from + 3];
    }
  }
  return out;
}

export interface PixelCompareOptions {
  /** Ratio above which a diff image is written. */
  threshold: number;
  /** Where to write the diff image, when one is warranted. */
  diffPath: string;
}

export function comparePng(
  referencePath: string,
  candidatePath: string,
  opts: PixelCompareOptions
): PixelResult {
  let expected: PNG;
  let actual: PNG;
  try {
    expected = PNG.sync.read(fs.readFileSync(referencePath));
    actual = PNG.sync.read(fs.readFileSync(candidatePath));
  } catch (err) {
    return {
      diffPixels: 0,
      ratio: 0,
      skipped: `could not read screenshots: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const { width, height } = expected;
  if (width === 0 || height === 0) {
    return { diffPixels: 0, ratio: 0, skipped: 'reference screenshot is empty' };
  }

  const scaled =
    actual.width !== width || actual.height !== height ? resize(actual, width, height) : actual;

  const diff = new PNG({ width, height });
  const diffPixels = pixelmatch(expected.data, scaled.data, diff.data, width, height, {
    threshold: 0.1,
  });
  const ratio = diffPixels / (width * height);

  if (ratio > opts.threshold) {
    fs.writeFileSync(opts.diffPath, PNG.sync.write(diff));
    return { diffPixels, ratio, diffPath: opts.diffPath };
  }
  return { diffPixels, ratio };
}
