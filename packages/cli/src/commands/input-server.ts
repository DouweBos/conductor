export const HELP = `  input-server                        Start (if needed) and print the streaming-input WebSocket for the device`;

import { inputServerInfo } from '../runner.js';
import { printError, printData, OutputOptions } from '../output.js';

/**
 * Ensure the device daemon + streaming-input socket are up and print the
 * loopback WebSocket URL the host IDE connects to for pointer/key/button
 * streaming. See docs/device-input-migration.md.
 */
export async function inputServer(
  opts: OutputOptions = {},
  sessionName = 'default'
): Promise<number> {
  try {
    const info = await inputServerInfo(sessionName);
    if (opts.json) {
      printData(info, opts);
    } else {
      console.log(`input server [${info.device}] (${info.platform}): ${info.url}`);
    }
    return 0;
  } catch (err) {
    printError(`input-server — ${err instanceof Error ? err.message : String(err)}`, opts);
    return 1;
  }
}
