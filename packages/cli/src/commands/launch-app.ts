export const HELP = `  launch-app <appId>                  Launch app (saves to session)
    --clear-state                     DESTRUCTIVE: wipe app data AND signed-in state before launching.
                                      On iOS this uninstall+reinstalls the app, which also drops the
                                      app's keychain items — the user will be signed out and you
                                      cannot undo it without their credentials. Do not use to reset
                                      focus or navigation state; relaunch without this flag instead.
    --clear-keychain                  DESTRUCTIVE: wipe the device keychain before launching. Signs
                                      the user out of every app on the simulator. Cannot be undone
                                      without re-entering credentials.
    --restart                         Kill and relaunch the app if it is already running. Without
                                      this, launch-app fails when the app is already running — check
                                      foreground-app first and keep using the running app instead.
    --no-stop-app                     Do not stop the app before launching (resume instead of restart)
    --argument key=value              Set launch argument (repeatable)
                                      macOS: "--argument flag" with no value passes "--flag"
    --inject                          iOS simulator only: inject the in-process control library
                                      (DYLD_INSERT_LIBRARIES) so native-* inspection commands work`;

import { runDirect, spawnCommand, type AnyDriver } from '../runner.js';
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
import { MacDriver, macAppPid } from '../drivers/macos.js';

/** Whether appId is already running; undefined when the platform can't tell. */
export async function isAppRunning(driver: AnyDriver, appId: string): Promise<boolean | undefined> {
  if (driver instanceof MacDriver) return (await macAppPid(appId)) !== undefined;
  if (driver instanceof IOSDriver) {
    if (!driver.isPhysical && driver.deviceId) {
      // launchctl lists suspended/background apps too, unlike XCUITest's foreground state.
      const res = await spawnCommand('xcrun', [
        'simctl',
        'spawn',
        driver.deviceId,
        'launchctl',
        'list',
      ]);
      if (!res.success) return undefined;
      // Exited apps can linger with a "-" pid column.
      return res.stdout
        .split('\n')
        .some((l) => /^\d+\s/.test(l) && l.includes(`UIKitApplication:${appId}[`));
    }
    return (await driver.runningApp([appId])) === appId;
  }
  if (driver instanceof AndroidDriver) return driver.isAppRunning(appId);
  if (driver instanceof VegaDriver || driver instanceof RokuDriver) {
    return (await driver.getForegroundApp()) === appId;
  }
  return undefined;
}

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
    restart?: boolean;
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
    // Agents tend to re-run launch-app assuming it's a no-op; it actually kills the app.
    const explicitRelaunch =
      flags.restart || flags.clearState || flags.clearKeychain || flags.stopApp === false;
    if (!explicitRelaunch && (await isAppRunning(driver, appId).catch(() => undefined))) {
      throw new Error(
        `"${appId}" is already running. launch-app would kill it and lose its current state. ` +
          'Keep working with the running app, or pass --restart to deliberately kill and relaunch it.'
      );
    }

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
        if (driver.platform === 'macos' || driver.platform === 'watchos') {
          throw new Error(`--inject is not supported on ${driver.platform}`);
        }
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
