import { runDirect } from '../runner.js';
import { updateSession } from '../session.js';
import { printSuccess, printError, OutputOptions } from '../output.js';
import { IOSDriver } from '../drivers/ios.js';
import { AndroidDriver } from '../drivers/android.js';

export async function launchApp(
  appId: string,
  deviceId?: string,
  opts: OutputOptions = {},
  sessionName = 'default',
  flags: {
    clearState?: boolean;
    clearKeychain?: boolean;
    stopApp?: boolean;
    launchArgs?: Record<string, string>;
  } = {}
): Promise<number> {
  if (!appId) {
    printError('launch-app requires <appId>', opts);
    return 1;
  }

  await updateSession({ appId, ...(deviceId ? { deviceId } : {}) }, sessionName);

  const result = await runDirect(async (driver) => {
    if (flags.clearKeychain) await driver.clearKeychain();
    if (flags.clearState) await driver.clearAppState(appId);

    const shouldStop = flags.stopApp ?? true;
    if (shouldStop) {
      if (driver instanceof IOSDriver) await driver.terminateApp(appId);
      else if (driver instanceof AndroidDriver) await driver.stopApp(appId);
    }

    if (driver instanceof IOSDriver) {
      await driver.launchApp(appId, flags.launchArgs);
    } else if (driver instanceof AndroidDriver) {
      await driver.launchApp(appId, flags.launchArgs);
    }
  }, sessionName);

  if (result.success) {
    printSuccess(`launch-app "${appId}" — done`, opts);
    return 0;
  } else {
    printError(`launch-app "${appId}" — failed\n${result.stderr}`, opts);
    return 1;
  }
}
