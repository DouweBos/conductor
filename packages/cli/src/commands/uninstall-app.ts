export const HELP = `  uninstall-app <appId>                Uninstall app from device`;

import { runDirect } from '../runner.js';
import { printSuccess, printError, OutputOptions } from '../output.js';
import { IOSDriver } from '../drivers/ios.js';
import { AndroidDriver } from '../drivers/android.js';
import { WebDriver } from '../drivers/web.js';

export async function uninstallApp(
  appId: string,
  opts: OutputOptions = {},
  sessionName = 'default'
): Promise<number> {
  if (!appId) {
    printError('uninstall-app requires <appId>', opts);
    return 1;
  }

  const result = await runDirect(async (driver) => {
    if (driver instanceof IOSDriver) {
      await driver.uninstallApp(appId);
    } else if (driver instanceof WebDriver) {
      throw new Error('uninstall-app is not supported on web');
    } else if (driver instanceof AndroidDriver) {
      await driver.uninstallApp(appId);
    }
  }, sessionName);

  if (result.success) {
    printSuccess(`uninstall-app "${appId}" — done`, opts);
    return 0;
  } else {
    printError(`uninstall-app "${appId}" — failed\n${result.stderr}`, opts);
    return 1;
  }
}
