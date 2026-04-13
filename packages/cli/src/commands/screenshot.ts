export const HELP = `  take-screenshot [--output <path>]    Take screenshot`;

import path from 'path';
import fs from 'fs/promises';
import { runDirect } from '../runner.js';
import { printSuccess, printError, OutputOptions } from '../output.js';

export async function screenshot(
  outputPath?: string,
  opts: OutputOptions = {},
  sessionName = 'default'
): Promise<number> {
  const timestamp = Date.now();
  const defaultName = `screenshot-${timestamp}.png`;
  const resolvedPath = outputPath
    ? path.resolve(outputPath)
    : path.resolve(process.cwd(), defaultName);

  const result = await runDirect(async (driver) => {
    const buf = await driver.screenshot();
    await fs.writeFile(resolvedPath, buf);
  }, sessionName);

  if (result.success) {
    printSuccess(`screenshot saved to ${resolvedPath}`, opts);
    return 0;
  } else {
    printError(`screenshot — failed\n${result.stderr}`, opts);
    return 1;
  }
}
