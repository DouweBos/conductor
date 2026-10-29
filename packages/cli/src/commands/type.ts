export const HELP = `  input-text <text>                    Type text into focused field
    --replace                          macOS: replace the field's contents instead of inserting`;

import { MacDriver } from '../drivers/macos.js';
import { runDirect } from '../runner.js';
import { printSuccess, printError, OutputOptions } from '../output.js';

export async function typeText(
  text: string,
  opts: OutputOptions = {},
  sessionName = 'default',
  flags: { replace?: boolean } = {}
): Promise<number> {
  if (text === undefined || text === '') {
    printError('input-text requires <text>', opts);
    return 1;
  }

  const result = await runDirect(async (driver) => {
    if (flags.replace) {
      if (!(driver instanceof MacDriver)) throw new Error('--replace is macOS-only');
      await driver.replaceText(text);
    } else {
      await driver.inputText(text);
    }
  }, sessionName);

  if (result.success) {
    printSuccess(`type "${text}" — done`, opts);
    return 0;
  } else {
    printError(`type "${text}" — failed\n${result.stderr}`, opts);
    return 1;
  }
}
