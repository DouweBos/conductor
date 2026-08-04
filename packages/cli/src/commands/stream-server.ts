export const HELP = `  stream-server                       Start (if needed) and print the live video-stream WebSocket for the device`;

import { streamServerInfo } from '../runner.js';
import { printError, printData, OutputOptions } from '../output.js';

/**
 * Ensure the device daemon + streaming-video socket are up and print the
 * loopback WebSocket URL a viewer subscribes to for the live H.264 stream.
 * See docs/device-video-stream.md.
 */
export async function streamServer(
  opts: OutputOptions = {},
  sessionName = 'default'
): Promise<number> {
  try {
    const info = await streamServerInfo(sessionName);
    if (opts.json) {
      printData(info, opts);
    } else {
      console.log(`stream server [${info.device}] (${info.platform}, ${info.codec}): ${info.url}`);
    }
    return 0;
  } catch (err) {
    printError(`stream-server — ${err instanceof Error ? err.message : String(err)}`, opts);
    return 1;
  }
}
