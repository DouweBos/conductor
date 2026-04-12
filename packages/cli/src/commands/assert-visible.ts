export const HELP = `  assert-visible <element>            Assert element is visible
    --id <id>                         Match by accessibility id instead of text
    --text <text>                     Match by text only (not id)
    --index <n>                       Pick the nth match (0-based)
    --timeout <ms>                    Max wait time in milliseconds
    --optional                        Do not fail if element is not found
    --focused                         Match only focused elements
    --enabled / --no-enabled          Match by enabled state
    --checked / --no-checked          Match by checked state
    --selected / --no-selected        Match by selected state
    --below <text>                    Match element below the given reference
    --above <text>                    Match element above the given reference
    --left-of <text>                  Match element left of the given reference
    --right-of <text>                 Match element right of the given reference`;

import { getDriver } from '../runner.js';
import { printSuccess, printError, OutputOptions } from '../output.js';
import { IOSDriver } from '../drivers/ios.js';
import { AndroidDriver } from '../drivers/android.js';
import { WebDriver } from '../drivers/web.js';
import {
  waitForIOSElement,
  waitForAndroidElement,
  waitForWebElement,
  OPTIONAL_TIMEOUT_MS,
} from '../drivers/wait.js';

export async function assertVisible(
  element: string,
  opts: OutputOptions = {},
  sessionName = 'default',
  flags: {
    id?: string;
    text?: string;
    index?: number;
    timeout?: number;
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
  if (!element && !flags.id && !flags.text) {
    printError('assert-visible requires <element> or --id <id>', opts);
    return 1;
  }

  const sel = {
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
  const timeoutMs = flags.timeout ?? (flags.optional ? OPTIONAL_TIMEOUT_MS : undefined);

  try {
    const driver = await getDriver(sessionName);

    const find = async () => {
      if (driver instanceof IOSDriver) {
        return waitForIOSElement(
          () => driver.viewHierarchy().then((h) => h.axElement),
          sel,
          timeoutMs
        );
      } else if (driver instanceof WebDriver) {
        return waitForWebElement(() => driver.viewHierarchy(), sel, timeoutMs);
      } else if (driver instanceof AndroidDriver) {
        return waitForAndroidElement(() => driver.viewHierarchy(), sel, timeoutMs);
      }
    };

    if (flags.optional) {
      await find().catch(() => {
        /* not found — acceptable */
      });
    } else {
      await find();
    }

    printSuccess(`assert-visible ${label} — element found`, opts);
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    printError(`assert-visible ${label} — ${msg}`, opts);
    return 1;
  }
}
