export const HELP = `  take-screenshot [<element>] [--output <path>] [--full-page] [--display <panel>]
                                       Take screenshot (--full-page: web only, capture entire scrollable page)
    --display <cover|inner|id>        Which display to capture (default: whichever panel
                                       is live). An unknown value lists the device's displays
    <element>                         Crop to the element matched by text (positional)
    --id <id>                         Crop to the element matched by accessibility id
    --text <text>                     Crop to the element matched by text only (not id)
    --index <n>                       Pick the nth match (0-based)
    --margin <px>                     Extra pixels around the crop (default 8) to capture shadows
    --focused                         Match only focused elements
    --enabled / --no-enabled          Match by enabled state
    --checked / --no-checked          Match by checked state
    --selected / --no-selected        Match by selected state
    --below <text>                    Match element below the given reference
    --above <text>                    Match element above the given reference
    --left-of <text>                  Match element left of the given reference
    --right-of <text>                 Match element right of the given reference`;

import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { runDirect, type AnyDriver } from '../runner.js';
import { printSuccess, printError, OutputOptions } from '../output.js';
import { listDisplays } from '../drivers/devicectl.js';
import { pickCaptureDisplay } from '../drivers/ios-displays.js';
import { IOSDriver } from '../drivers/ios.js';
import { AndroidDriver } from '../drivers/android.js';
import { WebDriver } from '../drivers/web.js';
import { VegaDriver } from '../drivers/vega.js';
import { RokuDriver } from '../drivers/roku.js';
import { waitForIOSElement, waitForAndroidElement, waitForWebElement } from '../drivers/wait.js';
import { makeIOSDirectResolver } from '../drivers/direct-ios-selector.js';
import { cropPng, readPngDimensions } from '../png-crop.js';

const exec = promisify(execFile);

const DEFAULT_MARGIN_PX = 8;

export interface ScreenshotSelectorFlags {
  id?: string;
  text?: string;
  index?: number;
  margin?: number;
  focused?: boolean;
  enabled?: boolean;
  checked?: boolean;
  selected?: boolean;
  below?: string;
  above?: string;
  leftOf?: string;
  rightOf?: string;
  /** Panel to capture on a multi-display device: cover, inner, or a display id. */
  display?: string;
}

export interface Capture {
  buffer: Buffer;
  /** True when the image came from a panel other than the driver's own screen. */
  redirected: boolean;
  /**
   * Pixels per point of the captured panel, when we know it. Only set for a
   * redirected capture, where `deviceInfo()` describes the wrong panel.
   */
  scale?: number;
  /**
   * False when the captured panel is powered off. The view hierarchy always
   * describes the live panel, so cropping against a dark one is meaningless.
   */
  live?: boolean;
}

/**
 * Grab the screen, pointing at the right panel on a multi-display device.
 *
 * The driver always screenshots `XCUIScreen.main`, which on a foldable is the
 * cover panel — powered off, and so a black image, whenever the device is
 * unfolded. When the device reports more than one integrated panel we capture
 * the live one through simctl instead. Ordinary devices keep the driver path.
 */
export async function captureScreen(
  driver: AnyDriver,
  opts: { fullPage?: boolean },
  displayOverride?: string
): Promise<Capture> {
  if (!(driver instanceof IOSDriver)) {
    if (displayOverride) {
      throw new Error('--display is iOS-only; other platforms expose a single screen');
    }
    return { buffer: await driver.screenshot(opts), redirected: false };
  }

  const deviceId = driver.deviceId;
  if (!deviceId) {
    if (displayOverride) throw new Error('--display needs a device to query for its displays');
    return { buffer: await driver.screenshot(opts), redirected: false };
  }

  const displays = await listDisplays(deviceId).catch(() => []);
  if (!displays.length) {
    if (displayOverride) throw new Error("could not read this device's displays");
    return { buffer: await driver.screenshot(opts), redirected: false };
  }

  const choice = pickCaptureDisplay(displays, displayOverride);
  if (choice.error) throw new Error(choice.error);

  const primary = displays.find((d) => d.primary);
  // Nothing to redirect: the driver already captures the primary panel.
  if (choice.displayId === null || (primary && choice.displayId === primary.displayId)) {
    const live = choice.displayId === null || primary?.active !== false;
    return { buffer: await driver.screenshot(opts), redirected: false, live };
  }

  const file = path.join(os.tmpdir(), `conductor-shot-${Date.now()}.png`);
  try {
    await exec('xcrun', [
      'simctl',
      'io',
      deviceId,
      'screenshot',
      '--display',
      String(choice.displayId),
      file,
    ]);
    const panel = displays.find((d) => d.displayId === choice.displayId);
    return {
      buffer: await fs.readFile(file),
      redirected: true,
      scale: panel?.pointScale,
      live: panel?.active,
    };
  } catch (err) {
    throw new Error(
      `could not capture display ${choice.displayId}: ${err instanceof Error ? err.message : String(err)}`
    );
  } finally {
    await fs.unlink(file).catch(() => {});
  }
}

/**
 * The size of the coordinate space the view hierarchy reports, in its own
 * units, for an iOS capture.
 *
 * `deviceInfo()` describes `XCUIScreen.main`, which is the wrong panel for a
 * redirected capture: on an unfolded foldable the hierarchy is in the inner
 * panel's points while deviceInfo still reports the cover's. Fall back to the
 * captured image divided by that panel's own scale, which is exact.
 */
export function iosHierarchySize(
  capture: Pick<Capture, 'redirected' | 'scale'>,
  png: { width: number; height: number },
  deviceInfo: { widthPoints: number; heightPoints: number }
): { width: number; height: number } {
  if (capture.redirected && capture.scale) {
    return { width: png.width / capture.scale, height: png.height / capture.scale };
  }
  return { width: deviceInfo.widthPoints, height: deviceInfo.heightPoints };
}

/**
 * Map element bounds onto screenshot pixels. The margin is in the same logical
 * units as the bounds (points on iOS, pixels on Android/Web — what `inspect`
 * prints), so it scales alongside them.
 */
export function cropRect(
  bounds: { x: number; y: number; width: number; height: number },
  hierarchy: { width: number; height: number },
  png: { width: number; height: number },
  margin: number
): { x: number; y: number; width: number; height: number } {
  const scaleX = hierarchy.width > 0 ? png.width / hierarchy.width : 1;
  const scaleY = hierarchy.height > 0 ? png.height / hierarchy.height : 1;
  const marginX = margin * scaleX;
  const marginY = margin * scaleY;
  return {
    x: Math.round(bounds.x * scaleX - marginX),
    y: Math.round(bounds.y * scaleY - marginY),
    width: Math.round(bounds.width * scaleX + marginX * 2),
    height: Math.round(bounds.height * scaleY + marginY * 2),
  };
}

export async function screenshot(
  outputPath?: string,
  opts: OutputOptions = {},
  sessionName = 'default',
  fullPage = false,
  query = '',
  flags: ScreenshotSelectorFlags = {}
): Promise<number> {
  const timestamp = Date.now();
  const defaultName = `screenshot-${timestamp}.png`;
  const resolvedPath = outputPath
    ? path.resolve(outputPath)
    : path.resolve(process.cwd(), defaultName);

  const hasSelector = !!(query || flags.id || flags.text);

  const sel = hasSelector
    ? {
        ...(flags.text ? { text: flags.text } : flags.id ? { id: flags.id } : { query }),
        ...(flags.index !== undefined && { index: flags.index }),
        ...(flags.focused !== undefined && { focused: flags.focused }),
        ...(flags.enabled !== undefined && { enabled: flags.enabled }),
        ...(flags.checked !== undefined && { checked: flags.checked }),
        ...(flags.selected !== undefined && { selected: flags.selected }),
        ...(flags.below && { below: { query: flags.below } }),
        ...(flags.above && { above: { query: flags.above } }),
        ...(flags.leftOf && { leftOf: { query: flags.leftOf } }),
        ...(flags.rightOf && { rightOf: { query: flags.rightOf } }),
      }
    : null;

  const label = flags.text
    ? `text="${flags.text}"`
    : flags.id
      ? `id="${flags.id}"`
      : query
        ? `"${query}"`
        : '';
  const margin = flags.margin ?? DEFAULT_MARGIN_PX;

  const result = await runDirect(async (driver) => {
    const {
      buffer: buf,
      redirected,
      scale,
      live,
    } = await captureScreen(driver, { fullPage }, flags.display);
    let out = buf;

    if (sel && live === false) {
      throw new Error(
        `cannot crop to ${label} on this display: it is powered off, and the view ` +
          'hierarchy describes whichever panel is live. Drop --display to capture ' +
          'the live panel, or fold the device so this one takes over.'
      );
    }

    if (sel) {
      let el;
      let hierarchyW: number;
      let hierarchyH: number;
      if (driver instanceof IOSDriver) {
        // The root axElement returned by the driver is a synthetic wrapper
        // around the foreground app + status bars and has frame=.zero, so
        // reading scale from it would always collapse to 1× and crop the
        // wrong region on retina/4K screens. Use deviceInfo, which reports
        // both points (AX space) and pixels (screenshot space) — except for a
        // redirected capture, where deviceInfo describes XCUIScreen.main and
        // not the panel we captured, so derive the points from its own scale.
        const size = iosHierarchySize(
          { redirected, scale },
          readPngDimensions(buf),
          await driver.deviceInfo()
        );
        hierarchyW = size.width;
        hierarchyH = size.height;
        el = await waitForIOSElement(
          (o) => driver.viewHierarchy(false, [], { cache: o?.cached }).then((x) => x.axElement),
          sel,
          undefined,
          undefined,
          makeIOSDirectResolver(driver, sel)
        );
      } else if (driver instanceof WebDriver) {
        const info = await driver.deviceInfo();
        hierarchyW = info.widthPixels;
        hierarchyH = info.heightPixels;
        el = await waitForWebElement(() => driver.viewHierarchy(), sel);
      } else if (
        driver instanceof AndroidDriver ||
        driver instanceof VegaDriver ||
        driver instanceof RokuDriver
      ) {
        // Vega and Roku emit uiautomator-style XML, so they reuse the Android resolver.
        const xml = await driver.viewHierarchy();
        // Android XML root bounds: derive from the first parseable <node bounds="[0,0][W,H]">
        const m = xml.match(/<node[^>]*bounds="\[0,0\]\[(\d+),(\d+)\]"/);
        hierarchyW = m ? +m[1] : 0;
        hierarchyH = m ? +m[2] : 0;
        el = await waitForAndroidElement(() => driver.viewHierarchy(), sel);
      } else {
        throw new Error('selector cropping is not supported for this driver');
      }

      const { width: pngW, height: pngH } = readPngDimensions(buf);
      const rect = cropRect(
        el.bounds,
        { width: hierarchyW, height: hierarchyH },
        { width: pngW, height: pngH },
        margin
      );

      if (
        rect.x + rect.width <= 0 ||
        rect.y + rect.height <= 0 ||
        rect.x >= pngW ||
        rect.y >= pngH
      ) {
        throw new Error(
          `element ${label} bounds [${rect.x},${rect.y} ${rect.width}x${rect.height}] are outside the screenshot (${pngW}x${pngH})`
        );
      }

      out = cropPng(buf, rect);
    }

    await fs.writeFile(resolvedPath, out);
  }, sessionName);

  if (result.success) {
    const suffix = sel ? ` (${label})` : '';
    printSuccess(`screenshot saved to ${resolvedPath}${suffix}`, opts);
    return 0;
  } else {
    printError(`screenshot — failed\n${result.stderr}`, opts);
    return 1;
  }
}
