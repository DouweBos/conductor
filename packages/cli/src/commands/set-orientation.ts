export const HELP = `  set-orientation <orientation>        Set device orientation
                                       portrait | landscape (all platforms)
                                       portraitUpsideDown | landscapeLeft | landscapeRight |
                                       faceUp | faceDown (iOS only)`;

import { runDirect, detectFirstDevice } from '../runner.js';
import { getSession } from '../session.js';
import { printSuccess, printError, OutputOptions } from '../output.js';
import { detectPlatform } from '../drivers/bootstrap.js';
import {
  setOrientation as devicectlSetOrientation,
  getOrientation as devicectlGetOrientation,
} from '../drivers/devicectl.js';
import { setOrientationViaRelay } from '../drivers/ios-fold.js';

/** Accepted everywhere; other platforms handle these through their driver. */
const BASIC: Record<string, string> = {
  portrait: 'portrait',
  landscape: 'landscapeLeft',
};

/** iOS-only orientations, which the test driver has no concept of. */
const IOS_ONLY: Record<string, string> = {
  portraitupsidedown: 'portraitUpsideDown',
  landscapeleft: 'landscapeLeft',
  landscaperight: 'landscapeRight',
  faceup: 'faceUp',
  facedown: 'faceDown',
};

export async function setOrientation(
  orientation: string,
  opts: OutputOptions = {},
  sessionName = 'default'
): Promise<number> {
  const key = orientation.toLowerCase();
  const iosValue = BASIC[key] ?? IOS_ONLY[key];
  if (!iosValue) {
    printError(
      `set-orientation must be one of: ${[...Object.keys(BASIC), ...Object.values(IOS_ONLY)].join(', ')}`,
      opts
    );
    return 1;
  }

  const deviceId =
    sessionName !== 'default'
      ? sessionName
      : ((await getSession(sessionName)).deviceId ?? (await detectFirstDevice()));
  if (!deviceId) {
    printError('No device found. Connect a device or start a simulator first.', opts);
    return 1;
  }
  const platform = await detectPlatform(deviceId);

  // On iOS everything goes through devicectl: it covers the full set and needs
  // no test driver running. Other platforms keep using their driver.
  if (platform === 'ios') {
    try {
      await devicectlSetOrientation(deviceId, iosValue);
      // Foldables accept the call and ignore it — their pose machine owns
      // orientation — so confirm, and rotate through the relay if it didn't take.
      if ((await devicectlGetOrientation(deviceId).catch(() => null)) !== iosValue) {
        await setOrientationViaRelay(deviceId, iosValue);
      }
      printSuccess(`set-orientation ${iosValue} — done`, opts);
      return 0;
    } catch (err) {
      printError(
        `set-orientation ${orientation} — failed\n${err instanceof Error ? err.message : String(err)}`,
        opts
      );
      return 1;
    }
  }

  if (!BASIC[key]) {
    printError(`${iosValue} is iOS-only — use portrait or landscape on this platform`, opts);
    return 1;
  }

  const result = await runDirect(async (driver) => {
    await driver.setOrientation(key);
  }, sessionName);

  if (result.success) {
    printSuccess(`set-orientation ${key} — done`, opts);
    return 0;
  }
  printError(`set-orientation ${orientation} — failed\n${result.stderr}`, opts);
  return 1;
}
