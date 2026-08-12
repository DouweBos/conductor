export const HELP = `  install-app <path>                   Install .app / .ipa / .apk onto device`;

import { spawnCommand, detectFirstDevice } from '../runner.js';
import { resolveAndroidTool, androidSpawnEnv } from '../android/sdk.js';
import { getSession } from '../session.js';
import { printSuccess, printError, OutputOptions } from '../output.js';
import { detectPlatform, detectDeviceKind } from '../drivers/bootstrap.js';
import { installApp as installPhysicalApp } from '../drivers/devicectl.js';
import { VegaCli } from '../drivers/vega/cli.js';

async function resolveDeviceId(sessionName: string): Promise<string | undefined> {
  if (sessionName !== 'default') return sessionName;
  const session = await getSession(sessionName);
  return session.deviceId ?? (await detectFirstDevice());
}

export async function installApp(
  appPath: string,
  opts: OutputOptions = {},
  sessionName = 'default'
): Promise<number> {
  if (!appPath) {
    printError('install-app requires <path> to a .app, .ipa, or .apk', opts);
    return 1;
  }

  const deviceId = await resolveDeviceId(sessionName);
  if (!deviceId) {
    printError('No device found. Connect a device or start a simulator first.', opts);
    return 1;
  }

  const platform = await detectPlatform(deviceId);

  if (platform === 'web') {
    printError('install-app is not supported on web. Use launch-app with a URL instead.', opts);
    return 1;
  } else if (platform === 'roku') {
    printError(
      'install-app is not supported on roku — sideload the channel through the ' +
        "device's developer web server (http://<device-ip>).",
      opts
    );
    return 1;
  } else if (platform === 'vega') {
    // Vega installs a `.vpkg` through Amazon's CLI; strip the `vega:` id prefix.
    try {
      await new VegaCli(deviceId.replace(/^vega:/, '')).installApp(appPath);
    } catch (e) {
      printError(`install-app failed: ${e instanceof Error ? e.message : String(e)}`, opts);
      return 1;
    }
  } else if (platform === 'ios' || platform === 'tvos') {
    if ((await detectDeviceKind(deviceId)) === 'physical') {
      try {
        await installPhysicalApp(deviceId, appPath);
      } catch (e) {
        printError(`install-app failed: ${e instanceof Error ? e.message : String(e)}`, opts);
        return 1;
      }
    } else {
      const result = await spawnCommand('xcrun', ['simctl', 'install', deviceId, appPath]);
      if (!result.success) {
        printError(`install-app failed: ${result.stderr}`, opts);
        return 1;
      }
    }
  } else {
    const result = await spawnCommand(
      resolveAndroidTool('adb'),
      ['-s', deviceId, 'install', '-r', '-t', '-g', appPath],
      { env: androidSpawnEnv() }
    );
    if (!result.success) {
      printError(`install-app failed: ${result.stderr}`, opts);
      return 1;
    }
  }

  printSuccess(`install-app "${appPath}" — done`, opts);
  return 0;
}
