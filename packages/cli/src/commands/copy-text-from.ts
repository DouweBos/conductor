export const HELP = `  copy-text-from <element>             Read an element's text; print it and copy to the device clipboard
    --id <id>                         Match by accessibility id instead of text
    --text <text>                     Match by text only (not id)
    --index <n>                       Pick the nth match (0-based)`;

import { runDirect } from '../runner.js';
import { printSuccess, printError, OutputOptions } from '../output.js';
import { IOSDriver } from '../drivers/ios.js';
import { AndroidDriver } from '../drivers/android.js';
import { WebDriver } from '../drivers/web.js';
import { VegaDriver } from '../drivers/vega.js';
import { waitForIOSElement, waitForAndroidElement, waitForWebElement } from '../drivers/wait.js';
import { makeIOSDirectResolver } from '../drivers/direct-ios-selector.js';

export async function copyTextFrom(
  query: string,
  opts: OutputOptions = {},
  sessionName = 'default',
  flags: { id?: string; text?: string; index?: number } = {}
): Promise<number> {
  if (!query && !flags.id && !flags.text) {
    printError('copy-text-from requires <element>, --id <id>, or --text <text>', opts);
    return 1;
  }

  const sel = {
    ...(flags.text ? { text: flags.text } : flags.id ? { id: flags.id } : { query }),
    ...(flags.index !== undefined && { index: flags.index }),
  };
  const label = flags.text ? `text="${flags.text}"` : flags.id ? `id="${flags.id}"` : `"${query}"`;

  let copied = '';
  const result = await runDirect(async (driver) => {
    let el: { text?: string };
    if (driver instanceof IOSDriver) {
      el = await waitForIOSElement(
        (o) => driver.viewHierarchy(false, [], { cache: o?.cached }).then((h) => h.axElement),
        sel,
        undefined,
        undefined,
        makeIOSDirectResolver(driver, sel)
      );
    } else if (driver instanceof WebDriver) {
      el = await waitForWebElement(() => driver.viewHierarchy(), sel);
    } else if (driver instanceof VegaDriver) {
      el = await waitForAndroidElement(() => driver.viewHierarchy(), sel);
    } else if (driver instanceof AndroidDriver) {
      el = await waitForAndroidElement(() => driver.viewHierarchy(), sel);
    } else {
      return;
    }

    copied = el.text ?? '';
    // Mirror Maestro's copyTextFrom by also landing the value on the device clipboard
    // where the platform supports it (iOS simulator). Best-effort — the text is the
    // primary output regardless.
    if (driver instanceof IOSDriver) {
      await driver.clipboardWrite(copied).catch(() => {});
    }
  }, sessionName);

  if (result.success) {
    // Print the raw text on stdout so callers can capture it (e.g. `$(conductor copy-text-from ...)`).
    process.stdout.write(copied + '\n');
    printSuccess(`copy-text-from ${label} — copied ${copied.length} chars`, opts);
    return 0;
  } else {
    printError(`copy-text-from ${label} — failed\n${result.stderr}`, opts);
    return 1;
  }
}
