import { runDirect } from '../runner.js';
import { printSuccess, printError, OutputOptions } from '../output.js';
import { IOSDriver } from '../drivers/ios.js';
import { AndroidDriver } from '../drivers/android.js';
import { waitForIOSElement, waitForAndroidElement } from '../drivers/wait.js';
import { sleep } from '../utils.js';

export async function tap(
  query: string,
  opts: OutputOptions = {},
  sessionName = 'default',
  flags: {
    id?: string;
    text?: string;
    index?: number;
    longPress?: boolean;
    doubleTap?: boolean;
    optional?: boolean;
    focused?: boolean;
    enabled?: boolean;
    checked?: boolean;
    selected?: boolean;
    below?: string;
    above?: string;
    leftOf?: string;
    rightOf?: string;
  } = {}
): Promise<number> {
  if (!query && !flags.id && !flags.text) {
    printError('tap requires <element> or --id <id>', opts);
    return 1;
  }

  const sel = {
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
  };

  const label = flags.text ? `text="${flags.text}"` : flags.id ? `id="${flags.id}"` : `"${query}"`;

  const result = await runDirect(async (driver) => {
    let el;
    if (driver instanceof IOSDriver) {
      el = await waitForIOSElement(() => driver.viewHierarchy().then((h) => h.axElement), sel);
    } else if (driver instanceof AndroidDriver) {
      el = await waitForAndroidElement(() => driver.viewHierarchy(), sel);
    } else {
      return;
    }

    if (flags.longPress) {
      if (driver instanceof IOSDriver) {
        await driver.tap(el.centerX, el.centerY, 1.5);
      } else {
        await (driver as AndroidDriver).swipe(el.centerX, el.centerY, el.centerX, el.centerY, 1500);
      }
    } else if (flags.doubleTap) {
      await driver.tap(el.centerX, el.centerY);
      await sleep(100);
      await driver.tap(el.centerX, el.centerY);
    } else {
      await driver.tap(el.centerX, el.centerY);
    }
  }, sessionName);

  const verb = flags.longPress ? 'long-press' : flags.doubleTap ? 'double-tap' : 'tap';
  if (result.success) {
    printSuccess(`${verb} ${label} — done`, opts);
    return 0;
  } else if (flags.optional) {
    printSuccess(`${verb} ${label} — not found (optional)`, opts);
    return 0;
  } else {
    printError(`${verb} ${label} — failed\n${result.stderr}`, opts);
    return 1;
  }
}
