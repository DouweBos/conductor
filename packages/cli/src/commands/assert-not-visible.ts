import { getDriver } from '../runner.js';
import { printSuccess, printError, OutputOptions } from '../output.js';
import { IOSDriver } from '../drivers/ios.js';
import { AndroidDriver } from '../drivers/android.js';
import { ElementSelector } from '../drivers/element-resolver.js';
import { waitUntilIOSElementGone, waitUntilAndroidElementGone } from '../drivers/wait.js';

export async function assertNotVisible(
  element: string,
  opts: OutputOptions = {},
  sessionName = 'default',
  flags: {
    id?: string;
    text?: string;
    index?: number;
    timeout?: number;
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
  if (!element && !flags.id && !flags.text) {
    printError('assert-not-visible requires <element> or --id <id>', opts);
    return 1;
  }

  const sel: ElementSelector = {
    ...(flags.text ? { text: flags.text } : flags.id ? { id: flags.id } : { query: element }),
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
  const label = flags.text
    ? `text="${flags.text}"`
    : flags.id
      ? `id="${flags.id}"`
      : `"${element}"`;

  try {
    const driver = await getDriver(sessionName);

    if (driver instanceof IOSDriver) {
      await waitUntilIOSElementGone(
        () => driver.viewHierarchy().then((h) => h.axElement),
        sel,
        flags.timeout
      );
    } else if (driver instanceof AndroidDriver) {
      await waitUntilAndroidElementGone(() => driver.viewHierarchy(), sel, flags.timeout);
    }

    printSuccess(`assert-not-visible ${label} — element not found`, opts);
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    printError(`assert-not-visible ${label} — ${msg}`, opts);
    return 1;
  }
}
