export const HELP = `  take-screenshot [<element>] [--output <path>] [--full-page]
                                       Take screenshot (--full-page: web only, capture entire scrollable page)
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
import fs from 'fs/promises';
import { runDirect } from '../runner.js';
import { printSuccess, printError, OutputOptions } from '../output.js';
import { IOSDriver } from '../drivers/ios.js';
import { AndroidDriver } from '../drivers/android.js';
import { WebDriver } from '../drivers/web.js';
import { waitForIOSElement, waitForAndroidElement, waitForWebElement } from '../drivers/wait.js';
import { makeIOSDirectResolver } from '../drivers/direct-ios-selector.js';
import { cropPng, readPngDimensions } from '../png-crop.js';

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
    const buf = await driver.screenshot({ fullPage });
    let out = buf;

    if (sel) {
      let el;
      let hierarchyW: number;
      let hierarchyH: number;
      if (driver instanceof IOSDriver) {
        const h = await driver.viewHierarchy(false, [], { cache: false });
        hierarchyW = h.axElement.frame.Width;
        hierarchyH = h.axElement.frame.Height;
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
      } else if (driver instanceof AndroidDriver) {
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

      const rectX = Math.round(el.bounds.x * scaleX - margin);
      const rectY = Math.round(el.bounds.y * scaleY - margin);
      const rectW = Math.round(el.bounds.width * scaleX + margin * 2);
      const rectH = Math.round(el.bounds.height * scaleY + margin * 2);

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
