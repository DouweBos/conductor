export const HELP = `  window list                         macOS: list the target app's windows (title, frame, focused)
  window focus <title>                macOS: raise a window by title and make it the one conductor drives
                                       (screenshots, coordinates, hierarchy). \`window focus --clear\` follows the front window again`;

import { runDirect } from '../runner.js';
import { printSuccess, printError, printData, OutputOptions } from '../output.js';
import { MacDriver } from '../drivers/macos.js';

export type WindowArgs = { sub: 'list' } | { sub: 'focus'; title: string };

/** `list`, `focus <title…>`, or `focus --clear` (empty title) → args; a string is an error. */
export function parseWindowArgs(rest: string[], clear = false): WindowArgs | string {
  const [sub, ...words] = rest;
  if (sub === 'list') return { sub: 'list' };
  if (sub === 'focus') {
    const title = words.join(' ').trim();
    if (clear) return { sub: 'focus', title: '' };
    if (!title) return 'window focus requires a window title (see `window list`)';
    return { sub: 'focus', title };
  }
  return 'window expects "list" or "focus <title>"';
}

export async function windowCommand(
  rest: string[],
  flags: { clear?: boolean },
  opts: OutputOptions = {},
  sessionName = 'default'
): Promise<number> {
  const args = parseWindowArgs(rest, flags.clear);
  if (typeof args === 'string') {
    printError(args, opts);
    return 1;
  }

  let output: unknown;
  const result = await runDirect(async (driver) => {
    if (!(driver instanceof MacDriver)) throw new Error('window is macOS-only');
    output =
      args.sub === 'list'
        ? await driver.listWindows()
        : await driver.setWindow({ title: args.title });
  }, sessionName);

  const label = args.sub === 'list' ? 'window list' : `window focus "${args.title}"`;
  if (!result.success) {
    printError(`${label} — failed\n${result.stderr}`, opts);
    return 1;
  }
  if (opts.json) {
    printData(output, opts);
  } else if (args.sub === 'list') {
    const windows = output as MacWindowList;
    if (windows.length === 0) printSuccess('window list — no windows', opts);
    for (const w of windows) {
      const f = w.frame;
      const state = w.focused ? ' (driven)' : w.minimized ? ' (minimized)' : '';
      console.log(`"${w.title}"  ${f.width}x${f.height} at ${f.x},${f.y}${state}`);
    }
  } else {
    printSuccess(
      args.title ? `${label} — done` : 'window focus — following the front window',
      opts
    );
  }
  return 0;
}

type MacWindowList = Awaited<ReturnType<MacDriver['listWindows']>>;
