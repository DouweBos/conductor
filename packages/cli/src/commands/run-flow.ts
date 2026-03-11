export const HELP = `  run-flow <file> [--device <id>]     Run a Maestro YAML flow file
    --env KEY=VALUE                   Inject env var (repeatable; overrides flow env block)
    --benchmark                       Print elapsed time for each command and total flow time`;

import path from 'path';
import { getDriver } from '../runner.js';
import { parseFlowFile, executeFlow } from '../drivers/flow-runner.js';
import { printSuccess, printError, OutputOptions } from '../output.js';

export async function runFlow(
  file: string,
  opts: OutputOptions = {},
  sessionName = 'default',
  env: Record<string, string> = {},
  benchmark = false
): Promise<number> {
  if (!file) {
    printError('run-flow requires <file>', opts);
    return 1;
  }

  const resolvedFile = path.resolve(process.cwd(), file);

  try {
    const driver = await getDriver(sessionName);
    const flow = await parseFlowFile(resolvedFile, env);
    await executeFlow(flow, driver, { cwd: path.dirname(resolvedFile), env, benchmark });
    printSuccess(`run-flow "${file}" — done`, opts);
    return 0;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    printError(`run-flow "${file}" — failed\n${detail}`, opts);
    return 1;
  }
}
