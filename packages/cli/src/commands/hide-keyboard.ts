export const HELP = `  hide-keyboard                       Dismiss the on-screen keyboard`;

import { runDirect } from '../runner.js';
import { printSuccess, printError, OutputOptions } from '../output.js';
import { IOSDriver } from '../drivers/ios.js';
import { AndroidDriver } from '../drivers/android.js';
import { WebDriver } from '../drivers/web.js';

export async function hideKeyboard(
  opts: OutputOptions = {},
  sessionName = 'default'
): Promise<number> {
  const result = await runDirect(async (driver) => {
    if (driver instanceof IOSDriver) {
      await driver.pressKey('return').catch(() => {
        /* no keyboard visible */
      });
    } else if (driver instanceof WebDriver) {
      // No virtual keyboard on web — no-op
    } else if (driver instanceof AndroidDriver) {
      await driver.pressKeyEvent(111); // KEYCODE_ESCAPE
    }
  }, sessionName);

  if (result.success) {
    printSuccess('hide-keyboard — done', opts);
    return 0;
  } else {
    printError(`hide-keyboard — failed\n${result.stderr}`, opts);
    return 1;
  }
}
