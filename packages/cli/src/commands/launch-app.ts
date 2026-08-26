export const HELP = `  launch-app <appId>                  Launch app (saves to session)
    --clear-state                     DESTRUCTIVE: wipe app data AND signed-in state before launching.
                                      On iOS this uninstall+reinstalls the app, which also drops the
                                      app's keychain items — the user will be signed out and you
                                      cannot undo it without their credentials. Do not use to reset
                                      focus or navigation state; relaunch without this flag instead.
    --clear-keychain                  DESTRUCTIVE: wipe the device keychain before launching. Signs
                                      the user out of every app on the simulator. Cannot be undone
                                      without re-entering credentials.
    --no-stop-app                     Do not stop the app before launching (resume instead of restart)
    --argument key=value              Set launch argument (repeatable)
    --inject                          iOS simulator only: inject the in-process control library
                                      (DYLD_INSERT_LIBRARIES) so native-* inspection commands work`;

import { runDirect } from '../runner.js';
import { updateSession } from '../session.js';
import { printSuccess, printError, OutputOptions } from '../output.js';
import { IOSDriver } from '../drivers/ios.js';
import { getInprocDylibPath } from '../drivers/bootstrap.js';
import { getInprocPort, InprocClient } from '../drivers/ios-inproc.js';
import fs from 'fs';
import { AndroidDriver } from '../drivers/android.js';
import { WebDriver } from '../drivers/web.js';
import { VegaDriver } from '../drivers/vega.js';
import { RokuDriver } from '../drivers/roku.js';

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
    inject?: boolean;
  } = {}
): Promise<number> {
  if (!appId) {
    printError('launch-app requires <appId>', opts);
    return 1;
  }

  await updateSession({ appId, ...(deviceId ? { deviceId } : {}) }, sessionName);

  if (flags.clearState || flags.clearKeychain) {
    process.stderr.write(
      'warning: --clear-state / --clear-keychain wipes app data AND signed-in state; ' +
        'the user will be signed out and cannot be recovered without their credentials.\n'
    );
  }

  let injectionNote = '';

  const result = await runDirect(async (driver) => {
    if (flags.clearKeychain) await driver.clearKeychain();
    if (flags.clearState) await driver.clearAppState(appId);

    const shouldStop = flags.stopApp ?? true;
    if (shouldStop) {
      if (driver instanceof IOSDriver) await driver.terminateApp(appId);
      else if (driver instanceof WebDriver) await driver.terminateApp();
      else if (driver instanceof VegaDriver || driver instanceof RokuDriver)
        await driver.terminateApp(appId);
      else if (driver instanceof AndroidDriver) await driver.stopApp(appId);
    }

    if (driver instanceof IOSDriver) {
      if (flags.inject) {
        const dylibPath = await getInprocDylibPath(driver.platform);
        if (!fs.existsSync(dylibPath)) {
          throw new Error(
            `--inject: in-process library not found at ${dylibPath}. ` +
              `Build it with packages/ios-inproc/tools/build-inproc-dylib.sh`
          );
        }
        const deviceId = driver.deviceId;
        if (!deviceId) throw new Error('--inject requires a resolved iOS simulator device');
        const inprocPort = getInprocPort(deviceId);
        await driver.launchApp(appId, flags.launchArgs, { dylibPath, inprocPort });
        const ready = await new InprocClient(inprocPort).waitUntilReady(10000);
        injectionNote = ready
          ? ` (in-process control ready on :${inprocPort})`
          : ` (warning: injected but in-process server did not answer on :${inprocPort})`;
      } else {
        await driver.launchApp(appId, flags.launchArgs);
      }
    } else if (driver instanceof WebDriver) {
      await driver.launchApp(appId);
    } else if (driver instanceof VegaDriver || driver instanceof RokuDriver) {
      await driver.launchApp(appId, flags.launchArgs);
    } else if (driver instanceof AndroidDriver) {
      await driver.launchApp(appId, flags.launchArgs);
    }
  }, sessionName);

  if (result.success) {
    printSuccess(`launch-app "${appId}" — done${injectionNote}`, opts);
    return 0;
  } else {
    printError(`launch-app "${appId}" — failed\n${result.stderr}`, opts);
    return 1;
  }
}
