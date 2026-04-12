export const HELP = `  stop-app [<appId>]                  Stop app`;

import { runDirect } from '../runner.js';
import { getSession } from '../session.js';
import { printSuccess, printError, OutputOptions } from '../output.js';
import { IOSDriver } from '../drivers/ios.js';
import { AndroidDriver } from '../drivers/android.js';
import { WebDriver } from '../drivers/web.js';

export async function stopApp(
  appId?: string,
  opts: OutputOptions = {},
  sessionName = 'default'
): Promise<number> {
  const session = await getSession(sessionName);
  const resolvedAppId = appId ?? session.appId;

  if (!resolvedAppId) {
    printError('stop-app: no appId provided and no active session. Run launch-app first.', opts);
    return 1;
  }

  const result = await runDirect(async (driver) => {
    if (driver instanceof IOSDriver) {
      await driver.terminateApp(resolvedAppId);
    } else if (driver instanceof WebDriver) {
      await driver.terminateApp();
    } else if (driver instanceof AndroidDriver) {
      await driver.stopApp(resolvedAppId);
    }
  }, sessionName);

  if (result.success) {
    printSuccess(`stop-app "${resolvedAppId}" — done`, opts);
    return 0;
  } else {
    printError(`stop-app "${resolvedAppId}" — failed\n${result.stderr}`, opts);
    return 1;
  }
}
