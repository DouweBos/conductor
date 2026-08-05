export const HELP = `  assert-screenshot <reference.png>    Visual regression: compare the screen to a reference image
    --threshold <0-1>                 Max fraction of differing pixels allowed (default 0.01)
    --update                          Write/overwrite the reference from the current screen and pass`;

import fs from 'fs';
import path from 'path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { runDirect } from '../runner.js';
import { printSuccess, printError, printData, OutputOptions } from '../output.js';

export async function assertScreenshot(
  reference: string,
  opts: OutputOptions = {},
  sessionName = 'default',
  flags: { threshold?: number; update?: boolean } = {}
): Promise<number> {
  if (!reference) {
    printError('assert-screenshot requires a reference image path', opts);
    return 1;
  }
  const refPath = path.resolve(process.cwd(), reference);
  const threshold = flags.threshold ?? 0.01;

  let shot: Buffer | undefined;
  const result = await runDirect(async (driver) => {
    shot = await driver.screenshot();
  }, sessionName);

  if (!result.success || !shot) {
    printError(`assert-screenshot — failed to capture screen\n${result.stderr}`, opts);
    return 1;
  }

  // Seed or refresh the baseline instead of comparing.
  if (flags.update || !fs.existsSync(refPath)) {
    fs.mkdirSync(path.dirname(refPath), { recursive: true });
    fs.writeFileSync(refPath, shot);
    const why = flags.update ? 'updated' : 'created (no baseline existed)';
    printSuccess(`assert-screenshot — reference ${why}: ${refPath}`, opts);
    return 0;
  }

  const actual = PNG.sync.read(shot);
  const expected = PNG.sync.read(fs.readFileSync(refPath));

  if (actual.width !== expected.width || actual.height !== expected.height) {
    printError(
      `assert-screenshot — size mismatch: screen ${actual.width}x${actual.height} vs ` +
        `reference ${expected.width}x${expected.height}`,
      opts
    );
    return 1;
  }

  const { width, height } = expected;
  const diff = new PNG({ width, height });
  const diffPixels = pixelmatch(expected.data, actual.data, diff.data, width, height, {
    threshold: 0.1,
  });
  const total = width * height;
  const ratio = diffPixels / total;

  if (ratio > threshold) {
    const diffPath = refPath.replace(/\.png$/i, '') + '.diff.png';
    fs.writeFileSync(diffPath, PNG.sync.write(diff));
    if (opts.json) printData({ passed: false, diffPixels, ratio, diffPath }, opts);
    else
      printError(
        `assert-screenshot — ${(ratio * 100).toFixed(2)}% differs (> ${(threshold * 100).toFixed(
          2
        )}% allowed); diff written to ${diffPath}`,
        opts
      );
    return 1;
  }

  if (opts.json) printData({ passed: true, diffPixels, ratio }, opts);
  else
    printSuccess(
      `assert-screenshot — matches (${(ratio * 100).toFixed(2)}% differ, within ${(
        threshold * 100
      ).toFixed(2)}%)`,
      opts
    );
  return 0;
}
