export const HELP = `  menu <path>                         macOS: click through the menu bar, e.g. "File > Export > PDF…"`;

import { runDirect } from '../runner.js';
import { printSuccess, printError, OutputOptions } from '../output.js';
import { MacDriver } from '../drivers/macos.js';

export async function menu(
  menuPath: string,
  opts: OutputOptions = {},
  sessionName = 'default'
): Promise<number> {
  const parts = menuPath
    .split('>')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    printError('menu requires a path, e.g. "File > Save"', opts);
    return 1;
  }

  const result = await runDirect(async (driver) => {
    if (!(driver instanceof MacDriver)) {
      throw new Error('menu is macOS-only — other platforms have no menu bar');
    }
    await driver.menu(parts);
  }, sessionName);

  const label = parts.join(' > ');
  if (result.success) {
    printSuccess(`menu ${label} — done`, opts);
    return 0;
  }
  printError(`menu ${label} — failed\n${result.stderr}`, opts);
  return 1;
}
