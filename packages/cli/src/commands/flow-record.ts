export const HELP = `  flow record start [--out path]       Start a YAML flow recording for this session
  flow record finish                   Close the active recording, print the file path
  flow record echo <text>              Insert a console.log step
  flow record status                   Show the active recording path (if any)`;

import { printSuccess, printError, printData, OutputOptions } from '../output.js';
import {
  startRecording,
  finishRecording,
  getActiveRecording,
  appendEcho,
} from '../drivers/flow-recorder.js';
import { getSession } from '../session.js';

export async function flowRecord(
  sub: string,
  rest: string[],
  opts: OutputOptions,
  sessionName: string,
  argv: Record<string, unknown>
): Promise<number> {
  if (sub === 'start') {
    const out = argv['out'] as string | undefined;
    const session = await getSession(sessionName);
    const target = await startRecording(sessionName, out, session.appId);
    if (opts.json) printData({ recordingPath: target }, opts);
    else printSuccess(`flow record start — writing to ${target}`, opts);
    return 0;
  }

  if (sub === 'finish') {
    const out = await finishRecording(sessionName);
    if (!out) {
      printError('flow record finish — no active recording for this session', opts);
      return 1;
    }
    if (opts.json) printData({ recordingPath: out }, opts);
    else printSuccess(`flow record finish — closed ${out}`, opts);
    return 0;
  }

  if (sub === 'echo') {
    const active = await getActiveRecording(sessionName);
    if (!active) {
      printError('flow record echo — no active recording (run `flow record start` first)', opts);
      return 1;
    }
    appendEcho(active, rest.join(' '));
    if (opts.json) printData({ ok: true }, opts);
    else printSuccess('flow record echo — appended', opts);
    return 0;
  }

  if (sub === 'status') {
    const active = await getActiveRecording(sessionName);
    if (opts.json) printData({ active }, opts);
    else console.log(active ? `recording: ${active}` : 'no active recording');
    return 0;
  }

  printError('Usage: conductor flow record <start|finish|echo|status>', opts);
  return 1;
}
