import { runDirect } from '../runner.js';
import { printSuccess, printError, OutputOptions } from '../output.js';

export async function openLink(
  url: string,
  opts: OutputOptions = {},
  sessionName = 'default'
): Promise<number> {
  if (!url) {
    printError('open-link requires <url>', opts);
    return 1;
  }

  const result = await runDirect(async (driver) => {
    await driver.openLink(url);
  }, sessionName);

  if (result.success) {
    printSuccess(`open-link ${url} — done`, opts);
    return 0;
  } else {
    printError(`open-link ${url} — failed\n${result.stderr}`, opts);
    return 1;
  }
}
