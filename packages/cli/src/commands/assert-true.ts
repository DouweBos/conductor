export const HELP = `  assert-true <expr>                   Assert a JavaScript expression evaluates truthy (exit 1 if not)
    --env KEY=VALUE                   Expose an env var to the expression (repeatable)`;

import { executeScript } from '../drivers/js-engine.js';
import { printSuccess, printError, OutputOptions } from '../output.js';

export async function assertTrue(
  expr: string,
  opts: OutputOptions = {},
  env: Record<string, string> = {}
): Promise<number> {
  if (!expr) {
    printError('assert-true requires a JavaScript expression', opts);
    return 1;
  }

  const output: Record<string, unknown> = {};
  try {
    // Evaluate in the same sandbox the flow runner uses for assertTrue, so
    // expressions behave identically whether run inline or inside a flow.
    await executeScript(`output.__assertTrue = !!(${expr});`, env, output, 'assert-true');
  } catch (e) {
    printError(`assert-true failed to evaluate: ${expr}\n${(e as Error).message}`, opts);
    return 1;
  }

  if (output['__assertTrue']) {
    printSuccess(`assert-true "${expr}" — passed`, opts);
    return 0;
  }
  printError(`assert-true "${expr}" — failed`, opts);
  return 1;
}
