export const HELP = `  add-media <path>...                  Add image/video files to the device gallery (media-picker testing)`;

import path from 'path';
import fs from 'fs';
import { runDirect } from '../runner.js';
import { printSuccess, printError, OutputOptions } from '../output.js';

export async function addMedia(
  files: string[],
  opts: OutputOptions = {},
  sessionName = 'default'
): Promise<number> {
  if (files.length === 0) {
    printError('add-media requires at least one file path', opts);
    return 1;
  }

  const resolved = files.map((f) => path.resolve(process.cwd(), f));
  const missing = resolved.filter((f) => !fs.existsSync(f));
  if (missing.length > 0) {
    printError(`add-media: file(s) not found:\n${missing.join('\n')}`, opts);
    return 1;
  }

  const result = await runDirect(async (driver) => {
    for (const f of resolved) await driver.addMedia(f);
  }, sessionName);

  if (result.success) {
    printSuccess(`add-media — added ${resolved.length} file(s)`, opts);
    return 0;
  } else {
    printError(`add-media — failed\n${result.stderr}`, opts);
    return 1;
  }
}
