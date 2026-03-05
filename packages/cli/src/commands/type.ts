import { runDirect } from '../runner.js';
import { printSuccess, printError, OutputOptions } from '../output.js';

export async function typeText(
  text: string,
  opts: OutputOptions = {},
  sessionName = 'default'
): Promise<number> {
  if (text === undefined || text === '') {
    printError('type requires <text>', opts);
    return 1;
  }

  const result = await runDirect(async (driver) => {
    await driver.inputText(text);
  }, sessionName);

  if (result.success) {
    printSuccess(`type "${text}" — done`, opts);
    return 0;
  } else {
    printError(`type "${text}" — failed\n${result.stderr}`, opts);
    return 1;
  }
}
