export const HELP = `  scroll-until-visible <element>      Scroll until element is visible
    --id <id>                         Match by accessibility id instead of text
    --text <text>                     Match by text only (not id)
    --direction <down|up|left|right>  Scroll direction (default: down)
    --timeout <ms>                    Max time in milliseconds (default: 30000)`;

import { getDriver } from '../runner.js';
import { printSuccess, printError, OutputOptions } from '../output.js';
import { IOSDriver } from '../drivers/ios.js';
import { AndroidDriver } from '../drivers/android.js';
import { WebDriver } from '../drivers/web.js';
import {
  findIOSElement,
  findAndroidElement,
  findWebElement,
  ElementSelector,
} from '../drivers/element-resolver.js';
import { Direction, swipeCoords } from '../utils.js';

export async function scrollUntilVisible(
  element: string,
  opts: OutputOptions = {},
  sessionName = 'default',
  flags: {
    id?: string;
    text?: string;
    index?: number;
    direction?: Direction;
    timeout?: number;
    focused?: boolean;
    enabled?: boolean;
    checked?: boolean;
    selected?: boolean;
  } = {}
): Promise<number> {
  if (!element && !flags.id && !flags.text) {
    printError('scroll-until-visible requires <element> or --id <id>', opts);
    return 1;
  }

  const sel: ElementSelector = {
    ...(flags.text ? { text: flags.text } : flags.id ? { id: flags.id } : { query: element }),
    ...(flags.index !== undefined && { index: flags.index }),
    ...(flags.focused !== undefined && { focused: flags.focused }),
    ...(flags.enabled !== undefined && { enabled: flags.enabled }),
    ...(flags.checked !== undefined && { checked: flags.checked }),
    ...(flags.selected !== undefined && { selected: flags.selected }),
  };
  const label = flags.text
    ? `text="${flags.text}"`
    : flags.id
      ? `id="${flags.id}"`
      : `"${element}"`;
  const direction: Direction = flags.direction ?? 'down';
  const timeoutMs = flags.timeout ?? 30000;
  const coords = swipeCoords(direction);

  try {
    const driver = await getDriver(sessionName);
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      try {
        if (driver instanceof IOSDriver) {
          const root = await driver.viewHierarchy().then((h) => h.axElement);
          if (findIOSElement(root, sel)) {
            printSuccess(`scroll-until-visible ${label} — found`, opts);
            return 0;
          }
          const info = await driver.deviceInfo();
          const { widthPoints: w, heightPoints: h } = info;
          await driver.swipe(
            coords.startX * w,
            coords.startY * h,
            coords.endX * w,
            coords.endY * h,
            0.5
          );
        } else if (driver instanceof WebDriver) {
          const hierarchy = await driver.viewHierarchy();
          if (findWebElement(hierarchy, sel)) {
            printSuccess(`scroll-until-visible ${label} — found`, opts);
            return 0;
          }
          const info = await driver.deviceInfo();
          const { widthPixels: w, heightPixels: h } = info;
          await driver.swipe(
            coords.startX * w,
            coords.startY * h,
            coords.endX * w,
            coords.endY * h,
            500
          );
        } else if (driver instanceof AndroidDriver) {
          const xml = await driver.viewHierarchy();
          if (findAndroidElement(xml, sel)) {
            printSuccess(`scroll-until-visible ${label} — found`, opts);
            return 0;
          }
          const info = await driver.deviceInfo();
          const { widthPixels: w, heightPixels: h } = info;
          await driver.swipe(
            coords.startX * w,
            coords.startY * h,
            coords.endX * w,
            coords.endY * h,
            500
          );
        }
      } catch {
        // hierarchy fetch failed — keep trying
      }
    }

    printError(`scroll-until-visible ${label} — element not found after ${timeoutMs}ms`, opts);
    return 1;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    printError(`scroll-until-visible ${label} — ${msg}`, opts);
    return 1;
  }
}
