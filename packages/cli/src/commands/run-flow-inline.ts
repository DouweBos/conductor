import { runInlineFlow } from '../runner.js';
import { printSuccess, printError, OutputOptions } from '../output.js';

/** run-flow-inline: Execute inline Maestro YAML commands natively via the flow runner. */
export async function runFlowInline(
  yaml: string,
  opts: OutputOptions = {},
  sessionName = 'default',
  benchmark = false
): Promise<number> {
  if (!yaml) {
    printError('run-flow-inline requires <yaml>', opts);
    return 1;
  }

  const result = await runInlineFlow(yaml, sessionName, benchmark);

  if (result.success) {
    printSuccess('run-flow-inline — done', opts);
    if (!opts.json && result.stdout.trim()) {
      console.log(result.stdout.trim());
    }
    return 0;
  } else {
    const detail = result.stderr.trim() || result.stdout.trim();
    printError(`run-flow-inline — failed\n${detail}`, opts);
    return 1;
  }
}
