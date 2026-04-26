export const HELP = `  list-apps                           List installed app IDs / package names`;

import { spawnCommand, detectFirstDevice } from '../runner.js';
import { resolveAndroidTool, androidSpawnEnv } from '../android/sdk.js';
import { getSession } from '../session.js';
import { printData, printError, OutputOptions } from '../output.js';
import { detectPlatform } from '../drivers/bootstrap.js';

async function resolveDeviceId(sessionName: string): Promise<string | undefined> {
  if (sessionName !== 'default') return sessionName;
  const session = await getSession(sessionName);
  return session.deviceId ?? (await detectFirstDevice());
}

export async function listApps(opts: OutputOptions = {}, sessionName = 'default'): Promise<number> {
  const deviceId = await resolveDeviceId(sessionName);
  if (!deviceId) {
    printError('No device found. Connect a device or start a simulator first.', opts);
    return 1;
  }

  const platform = await detectPlatform(deviceId);

  let appIds: string[];

  if (platform === 'web') {
    printError(
      'list-apps is not supported on web. Use foreground-app to get the current URL.',
      opts
    );
    return 1;
  } else if (platform === 'ios' || platform === 'tvos') {
    const result = await spawnCommand('bash', [
      '-c',
      `xcrun simctl listapps ${deviceId} | plutil -convert json - -o -`,
    ]);
    if (!result.success) {
      printError(`list-apps failed: ${result.stderr}`, opts);
      return 1;
    }
    try {
      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      appIds = Object.keys(parsed).sort();
    } catch {
      printError('Failed to parse app list from simctl', opts);
      return 1;
    }
  } else {
    const result = await spawnCommand(
      resolveAndroidTool('adb'),
      ['-s', deviceId, 'shell', 'pm', 'list', 'packages'],
      { env: androidSpawnEnv() }
    );
    if (!result.success) {
      printError(`list-apps failed: ${result.stderr}`, opts);
      return 1;
    }
    appIds = result.stdout
      .split('\n')
      .map((l) => l.trim().replace(/^package:/, ''))
      .filter(Boolean)
      .sort();
  }

  if (opts.json) {
    printData({ status: 'ok', apps: appIds }, opts);
  } else {
    for (const id of appIds) console.log(id);
  }
  return 0;
}
