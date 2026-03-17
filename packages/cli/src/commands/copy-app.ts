export const HELP = `  copy-app <bundleId>                 Copy an installed app between iOS simulators
    --from <id>                       Source device ID
    --to <id>                         Target device ID`;

import { spawnCommand } from '../runner.js';
import { printData, printError, OutputOptions } from '../output.js';
import { detectPlatform } from '../drivers/bootstrap.js';

export async function copyApp(
  bundleId: string,
  from: string,
  to: string,
  opts: OutputOptions = {}
): Promise<number> {
  if (!bundleId) {
    printError('Usage: conductor copy-app <bundleId> --from <id> --to <id>', opts);
    return 1;
  }
  if (!from || !to) {
    printError('Both --from and --to are required.', opts);
    return 1;
  }

  const [fromPlatform, toPlatform] = await Promise.all([detectPlatform(from), detectPlatform(to)]);

  if (fromPlatform !== 'ios') {
    printError(
      `--from device "${from}" is not an iOS simulator. copy-app only supports iOS.`,
      opts
    );
    return 1;
  }
  if (toPlatform !== 'ios') {
    printError(`--to device "${to}" is not an iOS simulator. copy-app only supports iOS.`, opts);
    return 1;
  }

  // Get the .app bundle path from the source simulator
  const getPath = await spawnCommand('xcrun', [
    'simctl',
    'get_app_container',
    from,
    bundleId,
    'app',
  ]);
  if (!getPath.success) {
    printError(`Failed to get app path from source device: ${getPath.stderr}`, opts);
    return 1;
  }

  const appPath = getPath.stdout.trim();

  // Install on target simulator
  const install = await spawnCommand('xcrun', ['simctl', 'install', to, appPath]);
  if (!install.success) {
    printError(`Failed to install app on target device: ${install.stderr}`, opts);
    return 1;
  }

  if (opts.json) {
    printData({ status: 'ok', bundleId, from, to, appPath }, opts);
  } else {
    console.log(`Copied ${bundleId} from ${from} to ${to}`);
  }
  return 0;
}
