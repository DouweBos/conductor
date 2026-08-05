export const HELP = `  set-airplane-mode <on|off>           Enable/disable airplane mode (Android only)
  toggle-airplane-mode                 Flip airplane mode (Android only)`;

import { runDirect } from '../runner.js';
import { AndroidDriver } from '../drivers/android.js';
import { printSuccess, printError, OutputOptions } from '../output.js';

export async function setAirplaneMode(
  value: string,
  opts: OutputOptions = {},
  sessionName = 'default'
): Promise<number> {
  const v = value.toLowerCase();
  if (v !== 'on' && v !== 'off' && v !== 'enable' && v !== 'disable') {
    printError('set-airplane-mode requires <on|off>', opts);
    return 1;
  }
  const enabled = v === 'on' || v === 'enable';

  const result = await runDirect(async (driver) => {
    await driver.setAirplaneMode(enabled);
  }, sessionName);

  if (result.success) {
    printSuccess(`set-airplane-mode ${enabled ? 'on' : 'off'} — done`, opts);
    return 0;
  } else {
    printError(`set-airplane-mode ${enabled ? 'on' : 'off'} — failed\n${result.stderr}`, opts);
    return 1;
  }
}

export async function toggleAirplaneMode(
  opts: OutputOptions = {},
  sessionName = 'default'
): Promise<number> {
  const result = await runDirect(async (driver) => {
    if (!(driver instanceof AndroidDriver)) {
      throw new Error('toggle-airplane-mode is only supported on Android');
    }
    const current = await driver.getAirplaneMode();
    await driver.setAirplaneMode(!current);
  }, sessionName);

  if (result.success) {
    printSuccess('toggle-airplane-mode — done', opts);
    return 0;
  } else {
    printError(`toggle-airplane-mode — failed\n${result.stderr}`, opts);
    return 1;
  }
}
