export const HELP = `  set-permissions <perm=value>...      Grant/deny app permissions (e.g. camera=allow photos=deny)
    [<appId>]                         Target app (defaults to the active session's app)
    perm=value                        Repeatable. value is allow|deny|unset; perm may be "all"
                                      (e.g. all=allow camera=deny)`;

import { runDirect } from '../runner.js';
import { getSession } from '../session.js';
import { printSuccess, printError, OutputOptions } from '../output.js';

export async function setPermissions(
  args: string[],
  opts: OutputOptions = {},
  sessionName = 'default'
): Promise<number> {
  // Split positional args into an optional appId (no '=') and perm=value pairs.
  const pairs: string[] = [];
  let appIdArg: string | undefined;
  for (const a of args) {
    if (a.includes('=')) pairs.push(a);
    else if (appIdArg === undefined) appIdArg = a;
  }

  if (pairs.length === 0) {
    printError('set-permissions requires at least one perm=value (e.g. camera=allow)', opts);
    return 1;
  }

  const permissions: Record<string, string> = {};
  for (const p of pairs) {
    const idx = p.indexOf('=');
    const key = p.slice(0, idx).trim();
    const value = p.slice(idx + 1).trim();
    if (key) permissions[key] = value;
  }

  const session = await getSession(sessionName);
  const appId = appIdArg ?? session.appId;
  if (!appId) {
    printError(
      'set-permissions: no appId provided and no active session. Run launch-app first.',
      opts
    );
    return 1;
  }

  const summary = Object.entries(permissions)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');

  const result = await runDirect(async (driver) => {
    await driver.setPermissions(appId, permissions);
  }, sessionName);

  if (result.success) {
    printSuccess(`set-permissions "${appId}" ${summary} — done`, opts);
    return 0;
  } else {
    printError(`set-permissions "${appId}" ${summary} — failed\n${result.stderr}`, opts);
    return 1;
  }
}
