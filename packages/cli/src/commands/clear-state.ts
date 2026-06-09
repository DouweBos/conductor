export const HELP = `  clear-state [<appId>]                DESTRUCTIVE: wipe app data and signed-in state.
                                       On iOS this uninstall+reinstalls the app, which also drops
                                       the app's keychain items — the user will be signed out and
                                       cannot be recovered without their credentials. Do not use to
                                       reset focus or navigation state.`;

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

  process.stderr.write(
    'warning: clear-state wipes app data AND signed-in state; the user will be signed out ' +
      'and cannot be recovered without their credentials.\n'
  );

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
