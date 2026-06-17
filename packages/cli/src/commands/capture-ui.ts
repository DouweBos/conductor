export const HELP = `  capture-ui [--output <path.json>]    Capture screenshot + hierarchy + a11y snapshot as a JSON bundle (for Argus UI panel)`;

import fs from 'fs/promises';
import path from 'path';
import { getDriver } from '../runner.js';
import { printError, printSuccess, OutputOptions } from '../output.js';
import { IOSDriver } from '../drivers/ios.js';
import { AndroidDriver } from '../drivers/android.js';
import { WebDriver } from '../drivers/web.js';
import {
  buildIOSA11y,
  buildAndroidA11y,
  buildWebA11y,
  A11ySnapshotEntry,
} from '../drivers/a11y.js';
import { buildStoredSnapshot, saveSnapshot } from '../snapshot-store.js';

export interface CaptureBundle {
  version: 1;
  capturedAt: string;
  device: {
    platform: 'ios' | 'android' | 'web' | 'tvos';
    deviceId: string;
    width: number;
    height: number;
  };
  screenshot: {
    kind: 'composite';
    encoding: 'png';
    data: string; // base64
  };
  hierarchy: unknown;
  a11ySnapshot: A11ySnapshotEntry[];
  capabilities: {
    perViewPixels: false;
    depthData: false;
  };
}

export async function captureUI(
  outputPath: string | undefined,
  opts: OutputOptions = {},
  sessionName = 'default'
): Promise<number> {
  try {
    // capture-ui always emits a JSON bundle (screenshot is embedded as base64).
    // Reject non-JSON output paths up front so a `.png`/`.jpg` mistake doesn't
    // silently produce an image-named file full of JSON. Use take-screenshot
    // for an actual image.
    if (outputPath) {
      const ext = path.extname(outputPath).toLowerCase();
      if (ext && ext !== '.json') {
        printError(
          `capture-ui — \`--output\` must be a .json path (got "${ext}"). ` +
            `capture-ui writes a JSON bundle (screenshot + hierarchy + a11y snapshot), not an image. ` +
            `Use \`take-screenshot\` to save an image file.`,
          opts
        );
        return 1;
      }
    }

    const driver = await getDriver(sessionName);
    const capturedAt = new Date().toISOString();

    let platform: CaptureBundle['device']['platform'];
    let width = 0;
    let height = 0;
    let hierarchy: unknown;
    let a11ySnapshot: A11ySnapshotEntry[];
    let screenshotBuf: Buffer;

    if (driver instanceof IOSDriver) {
      platform = driver.platform; // 'ios' | 'tvos'
      const [info, vh, shot] = await Promise.all([
        driver.deviceInfo(),
        driver.viewHierarchy(false),
        driver.screenshot(),
      ]);
      width = info.widthPoints;
      height = info.heightPoints;
      const built = buildIOSA11y(vh.axElement);
      hierarchy = { axElement: built.hierarchy, depth: vh.depth };
      a11ySnapshot = built.a11ySnapshot;
      screenshotBuf = shot;
    } else if (driver instanceof WebDriver) {
      platform = 'web';
      const [info, vh, shot] = await Promise.all([
        driver.deviceInfo(),
        driver.viewHierarchy(),
        driver.screenshot(),
      ]);
      width = info.widthPixels;
      height = info.heightPixels;
      const built = buildWebA11y(vh);
      hierarchy = { ...vh, elements: built.hierarchy };
      a11ySnapshot = built.a11ySnapshot;
      screenshotBuf = shot;
    } else if (driver instanceof AndroidDriver) {
      platform = 'android';
      const [info, xml, shot] = await Promise.all([
        driver.deviceInfo(),
        driver.viewHierarchy(),
        driver.screenshot(),
      ]);
      width = info.widthPixels;
      height = info.heightPixels;
      const built = buildAndroidA11y(xml);
      hierarchy = { xml, elements: built.hierarchy };
      a11ySnapshot = built.a11ySnapshot;
      screenshotBuf = shot;
    } else {
      throw new Error('Unknown driver type');
    }

    const bundle: CaptureBundle = {
      version: 1,
      capturedAt,
      device: {
        platform,
        deviceId: sessionName,
        width,
        height,
      },
      screenshot: {
        kind: 'composite',
        encoding: 'png',
        data: screenshotBuf.toString('base64'),
      },
      hierarchy,
      a11ySnapshot,
      capabilities: { perViewPixels: false, depthData: false },
    };

    // Persist `@eN` refs so `tap-on @e3` can act on this capture without a
    // re-query. Keyed by session — see snapshot-store.ts.
    await saveSnapshot(
      sessionName,
      buildStoredSnapshot(a11ySnapshot, { deviceId: sessionName, platform })
    );

    const json = JSON.stringify(bundle);

    if (outputPath) {
      const resolved = path.resolve(outputPath);
      await fs.writeFile(resolved, json);
      if (opts.json) {
        console.log(
          JSON.stringify({
            status: 'ok',
            path: resolved,
            bytes: Buffer.byteLength(json, 'utf-8'),
          })
        );
      } else {
        printSuccess(`capture-ui saved to ${resolved}`, opts);
      }
    } else {
      // Stdout: raw JSON bundle (no pretty-printing — screenshot is huge).
      process.stdout.write(json);
      if (!opts.json) process.stdout.write('\n');
    }
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    printError(`capture-ui — failed\n${msg}`, opts);
    return 1;
  }
}
