export const HELP = `  checkpoint <name>                    Capture the current screen into the active parity run
    --run <dir>                       Write into this run directory instead of the active one
                                       (created if it does not exist yet)
    --label <text>                    Name this run, when creating it
    --role <reference|candidate>      Role for a newly created run (default candidate)`;

import fs from 'fs';
import path from 'path';
import { getDriver } from '../runner.js';
import { printSuccess, printError, printData, OutputOptions } from '../output.js';
import { captureScreen } from '../parity/capture.js';
import { PARITY_RUN_ENV, resolveActiveRun, RunRole, RunWriter } from '../parity/store.js';

/**
 * Ad-hoc checkpoint capture, for journeys driven command-by-command rather than
 * from a flow file. Needs a run to write into: either `--run <dir>`, or
 * `CONDUCTOR_PARITY_RUN` pointing at one.
 */
export async function checkpoint(
  name: string,
  opts: OutputOptions = {},
  sessionName = 'default',
  flags: { run?: string; label?: string; role?: string } = {}
): Promise<number> {
  if (!name) {
    printError('checkpoint requires <name>', opts);
    return 1;
  }
  if (flags.role && flags.role !== 'reference' && flags.role !== 'candidate') {
    printError(`checkpoint --role must be "reference" or "candidate" (got "${flags.role}")`, opts);
    return 1;
  }

  // A `--run` directory that doesn't exist yet is created rather than refused.
  // Each round of a convergence loop captures into its own fresh directory —
  // one attempt, one run — so requiring the caller to pre-create it would mean
  // every caller reimplementing what RunWriter already does.
  if (flags.run && !fs.existsSync(path.join(path.resolve(flags.run), 'run.json'))) {
    try {
      new RunWriter(path.resolve(flags.run), {
        role: (flags.role as RunRole | undefined) ?? 'candidate',
        deviceId: sessionName,
        label: flags.label,
      }).finish();
    } catch (err) {
      printError(
        `checkpoint — could not create run at ${flags.run}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        opts
      );
      return 1;
    }
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
