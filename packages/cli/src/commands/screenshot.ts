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
): Promise<{ buffer: Buffer; redirected: boolean }> {
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
    return { buffer: await driver.screenshot(opts), redirected: false };
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
    return { buffer: await fs.readFile(file), redirected: true };
  } catch (err) {
    throw new Error(
      `could not capture display ${choice.displayId}: ${err instanceof Error ? err.message : String(err)}`
    );
  } finally {
    await fs.unlink(file).catch(() => {});
  }
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
    const { buffer: buf, redirected } = await captureScreen(driver, { fullPage }, flags.display);
    let out = buf;

    if (sel && redirected) {
      throw new Error(
        'cropping to an element is not supported on this display yet — the panel is ' +
          'rotated relative to the accessibility coordinate space. Re-run with ' +
          '--display cover, or fold the device, to crop against the main panel.'
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
        // both points (AX space) and pixels (screenshot space).
        const info = await driver.deviceInfo();
        hierarchyW = info.widthPoints;
        hierarchyH = info.heightPoints;
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
      const scaleX = hierarchyW > 0 ? pngW / hierarchyW : 1;
      const scaleY = hierarchyH > 0 ? pngH / hierarchyH : 1;

      // Margin is in the same logical units as the bounds (points on iOS,
      // pixels on Android/Web — same units the `inspect` command prints),
      // so scale it into screenshot pixels alongside the bounds.
      const marginX = margin * scaleX;
      const marginY = margin * scaleY;
      const rectX = Math.round(el.bounds.x * scaleX - marginX);
      const rectY = Math.round(el.bounds.y * scaleY - marginY);
      const rectW = Math.round(el.bounds.width * scaleX + marginX * 2);
      const rectH = Math.round(el.bounds.height * scaleY + marginY * 2);

      if (rectX + rectW <= 0 || rectY + rectH <= 0 || rectX >= pngW || rectY >= pngH) {
        throw new Error(
          `element ${label} bounds [${rectX},${rectY} ${rectW}x${rectH}] are outside the screenshot (${pngW}x${pngH})`
        );
      }

      out = cropPng(buf, { x: rectX, y: rectY, width: rectW, height: rectH });
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
