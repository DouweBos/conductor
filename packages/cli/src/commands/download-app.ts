export const HELP = `  download-app <appId> --output <path>  Download installed app binary from device`;

import path from 'path';
import { spawnCommand, detectFirstDevice } from '../runner.js';
import { getSession } from '../session.js';
import { printData, printSuccess, printError, OutputOptions } from '../output.js';
import { detectPlatform } from '../drivers/bootstrap.js';

async function resolveDeviceId(sessionName: string): Promise<string | undefined> {
  if (sessionName !== 'default') return sessionName;
  const session = await getSession(sessionName);
  return session.deviceId ?? (await detectFirstDevice());
}

export async function downloadApp(
  appId: string,
  output: string | undefined,
  opts: OutputOptions = {},
  sessionName = 'default'
): Promise<number> {
  if (!appId) {
    printError('download-app requires <appId>', opts);
    return 1;
  }

  const deviceId = await resolveDeviceId(sessionName);
  if (!deviceId) {
    printError('No device found. Connect a device or start a simulator first.', opts);
    return 1;
  }

  const platform = await detectPlatform(deviceId);

  if (platform === 'web') {
    printError('download-app is not supported on web.', opts);
    return 1;
  }

  if (platform === 'ios' || platform === 'tvos') {
    // Get the .app bundle path from the simulator
    const getPath = await spawnCommand('xcrun', [
      'simctl',
      'get_app_container',
      deviceId,
      appId,
      'app',
    ]);
    if (!getPath.success) {
      printError(`Failed to locate app on device: ${getPath.stderr}`, opts);
      return 1;
    }

    const appPath = getPath.stdout.trim();
    const appName = path.basename(appPath);
    const dest = output ?? path.join(process.cwd(), appName);

    const copy = await spawnCommand('cp', ['-R', appPath, dest]);
    if (!copy.success) {
      printError(`Failed to copy app bundle: ${copy.stderr}`, opts);
      return 1;
    }

    if (opts.json) {
      printData({ status: 'ok', appId, path: dest }, opts);
    } else {
      printSuccess(`download-app "${appId}" → ${dest}`, opts);
    }
    return 0;
  } else {
    // Android: find the APK path, then pull it
    const pmPath = await spawnCommand('adb', ['-s', deviceId, 'shell', 'pm', 'path', appId]);
    if (!pmPath.success) {
      printError(`Failed to locate app on device: ${pmPath.stderr}`, opts);
      return 1;
    }

    // pm path output: "package:/data/app/.../base.apk"
    const apkPath = pmPath.stdout.trim().replace(/^package:/, '');
    if (!apkPath) {
      printError(`Could not resolve APK path for "${appId}"`, opts);
      return 1;
    }

    const dest = output ?? path.join(process.cwd(), `${appId}.apk`);

    const pull = await spawnCommand('adb', ['-s', deviceId, 'pull', apkPath, dest]);
    if (!pull.success) {
      printError(`Failed to pull APK: ${pull.stderr}`, opts);
      return 1;
    }

    if (opts.json) {
      printData({ status: 'ok', appId, path: dest }, opts);
    } else {
      printSuccess(`download-app "${appId}" → ${dest}`, opts);
    }
    return 0;
  }
}
