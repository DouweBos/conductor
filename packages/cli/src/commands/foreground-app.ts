export const HELP = `  foreground-app                      Print bundle ID / package of the foreground app`;

import { getDriver, spawnCommand, detectFirstDevice } from '../runner.js';
import { printSuccess, printError, OutputOptions } from '../output.js';
import { IOSDriver } from '../drivers/ios.js';
import { AndroidDriver } from '../drivers/android.js';

async function resolveDeviceId(sessionName: string): Promise<string | undefined> {
  if (sessionName !== 'default') return sessionName;
  return detectFirstDevice();
}

async function getInstalledAppIds(deviceId: string): Promise<string[]> {
  const result = await spawnCommand('bash', [
    '-c',
    `xcrun simctl listapps ${deviceId} | plutil -convert json - -o -`,
  ]);
  if (!result.success) return [];
  try {
    return Object.keys(JSON.parse(result.stdout) as Record<string, unknown>);
  } catch {
    return [];
  }
}

export async function foregroundApp(
  opts: OutputOptions = {},
  sessionName = 'default'
): Promise<number> {
  try {
    const driver = await getDriver(sessionName);
    let appId: string;

    if (driver instanceof IOSDriver) {
      const deviceId = await resolveDeviceId(sessionName);
      const appIds = deviceId ? await getInstalledAppIds(deviceId) : [];
      appId = await driver.runningApp(appIds);
    } else if (driver instanceof AndroidDriver) {
      appId = await driver.getForegroundApp();
    } else {
      throw new Error('Unsupported driver');
    }

    printSuccess(appId, opts);
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    printError(`foreground-app failed\n${msg}`, opts);
    return 1;
  }
}
