export const HELP = `  clear-state [<appId>]                Clear app data/state`;

import { runDirect } from '../runner.js';
import { getSession } from '../session.js';
import { printSuccess, printError, OutputOptions } from '../output.js';

export async function clearState(
  appId?: string,
  opts: OutputOptions = {},
  sessionName = 'default'
): Promise<number> {
  const session = await getSession(sessionName);
  const resolvedAppId = appId ?? session.appId;

  if (!resolvedAppId) {
    printError('clear-state: no appId provided and no active session. Run launch-app first.', opts);
    return 1;
  }

  const result = await runDirect(async (driver) => {
    await driver.clearAppState(resolvedAppId);
  }, sessionName);

  if (result.success) {
    printSuccess(`clear-state "${resolvedAppId}" — done`, opts);
    return 0;
  } else {
    printError(`clear-state "${resolvedAppId}" — failed\n${result.stderr}`, opts);
    return 1;
  }
}
