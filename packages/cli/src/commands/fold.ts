export const HELP = `  get-fold                             Print the hinge angle of a foldable device (iPhone Duo)
  set-fold <closed|book|open|0-180>    Fold, half-open, unfold, or set an exact hinge angle`;

import { detectFirstDevice } from '../runner.js';
import { getSession } from '../session.js';
import { printSuccess, printError, printData, OutputOptions } from '../output.js';
import { detectPlatform } from '../drivers/bootstrap.js';
import { FOLD_POSES, getFoldState, resolveFoldAngle, setFoldAngle } from '../drivers/ios-fold.js';

async function resolveDeviceId(sessionName: string): Promise<string | undefined> {
  if (sessionName !== 'default') return sessionName;
  const session = await getSession(sessionName);
  return session.deviceId ?? (await detectFirstDevice());
}

/** Fold control talks to the device directly, so no test driver is needed. */
async function foldableDeviceId(sessionName: string, opts: OutputOptions): Promise<string | null> {
  const deviceId = await resolveDeviceId(sessionName);
  if (!deviceId) {
    printError('No device found. Connect a device or start a simulator first.', opts);
    return null;
  }
  const platform = await detectPlatform(deviceId);
  if (platform !== 'ios') {
    printError(`fold control is iOS-only — foldable simulators such as the iPhone Duo`, opts);
    return null;
  }
  return deviceId;
}

export async function getFold(opts: OutputOptions = {}, sessionName = 'default'): Promise<number> {
  const deviceId = await foldableDeviceId(sessionName, opts);
  if (!deviceId) return 1;

  try {
    const state = await getFoldState(deviceId);
    if (opts.json) printData(state, opts);
    else printSuccess(`fold: ${state.pose} (${state.angle}°)`, opts);
    return 0;
  } catch (err) {
    printError(`get-fold — failed\n${err instanceof Error ? err.message : String(err)}`, opts);
    return 1;
  }
}

export async function setFold(
  value: string,
  opts: OutputOptions = {},
  sessionName = 'default'
): Promise<number> {
  const key = value.trim().toLowerCase();
  const angle = resolveFoldAngle(value);
  if (angle === null) {
    printError(
      `set-fold must be one of: ${Object.keys(FOLD_POSES).join(', ')}, or an angle from 0 to 180`,
      opts
    );
    return 1;
  }

  const deviceId = await foldableDeviceId(sessionName, opts);
  if (!deviceId) return 1;

  try {
    await setFoldAngle(deviceId, angle);
    printSuccess(`set-fold ${key in FOLD_POSES ? key : angle} (${angle}°) — done`, opts);
    return 0;
  } catch (err) {
    printError(
      `set-fold ${value} — failed\n${err instanceof Error ? err.message : String(err)}`,
      opts
    );
    return 1;
  }
}
