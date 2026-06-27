export const HELP = `  list-options [command|param]         List valid values for enumerated parameters
    (e.g. \`list-options press-key\`, \`list-options direction\`, or no arg for all)`;

import { printData, printError, OutputOptions } from '../output.js';
import { EnumParam, findEnumParams, commandsWithEnums } from '../enum-options.js';

function renderParam(p: EnumParam): string {
  const lines: string[] = [];
  lines.push(`${p.command} ${p.param}`);
  lines.push(`  ${p.description}`);
  for (const v of p.values) {
    lines.push(v.description ? `    ${v.value}  —  ${v.description}` : `    ${v.value}`);
  }
  if (p.note) lines.push(`  note: ${p.note}`);
  return lines.join('\n');
}

/**
 * List valid values for enumerated parameters. With no query, lists every
 * enumerated parameter. With a query, filters by command name, parameter name,
 * or value.
 */
export function listOptions(query: string | undefined, opts: OutputOptions = {}): number {
  const matches = findEnumParams(query);

  if (matches.length === 0) {
    const available = commandsWithEnums().join(', ');
    printError(
      `No enumerated parameters match "${query}". Commands with options: ${available}`,
      opts
    );
    return 1;
  }

  if (opts.json) {
    printData(
      matches.map((p) => ({
        command: p.command,
        param: p.param,
        description: p.description,
        values: p.values.map((v) => v.value),
        note: p.note ?? null,
      })),
      opts
    );
    return 0;
  }

  console.log(matches.map(renderParam).join('\n\n'));
  return 0;
}
