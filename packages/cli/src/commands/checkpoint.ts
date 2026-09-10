export const HELP = `  checkpoint <name>                    Capture the current screen into the active parity run
    --run <dir>                       Write into this run directory instead of the active one`;

import { getDriver } from '../runner.js';
import { printSuccess, printError, printData, OutputOptions } from '../output.js';
import { captureScreen } from '../parity/capture.js';
import { PARITY_RUN_ENV, resolveActiveRun } from '../parity/store.js';

/**
 * Ad-hoc checkpoint capture, for journeys driven command-by-command rather than
 * from a flow file. Needs a run to write into: either `--run <dir>`, or
 * `CONDUCTOR_PARITY_RUN` pointing at one.
 */
export async function checkpoint(
  name: string,
  opts: OutputOptions = {},
  sessionName = 'default',
  flags: { run?: string } = {}
): Promise<number> {
  if (!name) {
    printError('checkpoint requires <name>', opts);
    return 1;
  }

  let run;
  try {
    run = resolveActiveRun(flags.run);
  } catch (err) {
    printError(`checkpoint — ${err instanceof Error ? err.message : String(err)}`, opts);
    return 1;
  }

  if (!run) {
    printError(
      `checkpoint — no parity run is recording. Pass \`--run <dir>\`, or set ${PARITY_RUN_ENV} ` +
        `to a run directory, or drive the journey with \`conductor parity record\`.`,
      opts
    );
    return 1;
  }

  try {
    const driver = await getDriver(sessionName);
    const capture = await captureScreen(driver);
    const record = run.add(name, capture);
    run.finish();
    if (opts.json) {
      printData({ status: 'ok', run: run.dir, ...record }, opts);
    } else {
      printSuccess(`checkpoint "${name}" — captured to ${run.dir}`, opts);
    }
    return 0;
  } catch (err) {
    printError(
      `checkpoint "${name}" — failed\n${err instanceof Error ? err.message : String(err)}`,
      opts
    );
    return 1;
  }
}
