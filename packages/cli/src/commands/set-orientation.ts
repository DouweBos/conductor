export const HELP = `  set-orientation <portrait|landscape> Set device orientation`;

import { runDirect } from '../runner.js';
import { printSuccess, printError, OutputOptions } from '../output.js';

const VALID = ['portrait', 'landscape'];

export async function setOrientation(
  orientation: string,
  opts: OutputOptions = {},
  sessionName = 'default'
): Promise<number> {
  if (!VALID.includes(orientation.toLowerCase())) {
    printError(`set-orientation must be one of: ${VALID.join(', ')}`, opts);
    return 1;
  }

  const result = await runDirect(async (driver) => {
    await driver.setOrientation(orientation.toLowerCase());
  }, sessionName);

  if (result.success) {
    printSuccess(`set-orientation ${orientation} — done`, opts);
    return 0;
  } else {
    printError(`set-orientation ${orientation} — failed\n${result.stderr}`, opts);
    return 1;
  }
}
