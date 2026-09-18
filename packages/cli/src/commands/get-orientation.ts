export const HELP = `  get-orientation                      Print the device's current orientation`;

import { detectFirstDevice } from '../runner.js';
import { getSession } from '../session.js';
import { printSuccess, printError, printData, OutputOptions } from '../output.js';
import { detectPlatform } from '../drivers/bootstrap.js';
import { getOrientation as devicectlGetOrientation } from '../drivers/devicectl.js';

async function resolveDeviceId(sessionName: string): Promise<string | undefined> {
  if (sessionName !== 'default') return sessionName;
  const session = await getSession(sessionName);
  return session.deviceId ?? (await detectFirstDevice());
}

export async function getOrientation(
  opts: OutputOptions = {},
  sessionName = 'default'
): Promise<number> {
  const deviceId = await resolveDeviceId(sessionName);
  if (!deviceId) {
    printError('No device found. Connect a device or start a simulator first.', opts);
    return 1;
  }
  const platform = await detectPlatform(deviceId);
  if (platform !== 'ios') {
    printError('get-orientation is iOS-only (simulators and physical devices)', opts);
    return 1;
  }

  try {
    const orientation = await devicectlGetOrientation(deviceId);
    if (opts.json) printData({ orientation }, opts);
    else printSuccess(`orientation: ${orientation}`, opts);
    return 0;
  } catch (err) {
    printError(
      `get-orientation — failed\n${err instanceof Error ? err.message : String(err)}`,
      opts
    );
    return 1;
  }
}
