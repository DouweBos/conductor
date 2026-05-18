export const HELP = `  run-sequence [--file path.json]      Run a sequence of conductor commands serially against one session
                                       JSON shape: {"steps":[{"cmd":"tap-on","args":["Login"]}, ...]}
                                       Reads stdin when --file is omitted. Stops on first non-zero exit.`;

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { printError, printData, OutputOptions } from '../output.js';

interface Step {
  cmd: string;
  args?: string[];
  /** Per-step flags (--key value). Useful to pass --id, --text, etc. */
  flags?: Record<string, string | boolean | number>;
}

interface SequenceInput {
  steps: Step[];
}

interface StepResult {
  cmd: string;
  args: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
}

function flagsToArgs(flags: Record<string, string | boolean | number> | undefined): string[] {
  if (!flags) return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(flags)) {
    if (value === false) continue;
    out.push(`--${key}`);
    if (value !== true) out.push(String(value));
  }
  return out;
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => {
      buf += chunk;
    });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
  });
}

export async function runSequence(
  filePath: string | undefined,
  opts: OutputOptions = {},
  sessionName = 'default'
): Promise<number> {
  let raw: string;
  if (filePath) {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
      printError(`run-sequence: file not found: ${resolved}`, opts);
      return 1;
    }
    raw = fs.readFileSync(resolved, 'utf-8');
  } else {
    raw = await readStdin();
  }

  let parsed: SequenceInput;
  try {
    parsed = JSON.parse(raw) as SequenceInput;
  } catch (err) {
    printError(
      `run-sequence: invalid JSON\n${err instanceof Error ? err.message : String(err)}`,
      opts
    );
    return 1;
  }

  if (!parsed.steps || !Array.isArray(parsed.steps)) {
    printError('run-sequence: input must be {"steps":[...]}', opts);
    return 1;
  }

  const results: StepResult[] = [];
  const conductorBin = process.argv[1] ?? 'conductor';
  const deviceArgs = sessionName !== 'default' ? ['--device', sessionName] : [];

  for (let i = 0; i < parsed.steps.length; i++) {
    const step = parsed.steps[i];
    const args = [step.cmd, ...(step.args ?? []), ...flagsToArgs(step.flags), ...deviceArgs];
    if (!opts.json) {
      console.log(`[${i + 1}/${parsed.steps.length}] conductor ${args.join(' ')}`);
    }
    const result = await runStep(conductorBin, args);
    results.push({
      cmd: step.cmd,
      args: step.args ?? [],
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    });
    if (!opts.json && result.stdout) process.stdout.write(result.stdout);
    if (!opts.json && result.stderr) process.stderr.write(result.stderr);
    if (result.exitCode !== 0) {
      if (opts.json) {
        printData({ ok: false, completed: i, total: parsed.steps.length, results }, opts);
      } else {
        printError(
          `run-sequence aborted at step ${i + 1}/${parsed.steps.length} (${step.cmd}, exit ${result.exitCode})`,
          opts
        );
      }
      return result.exitCode;
    }
  }

  if (opts.json) {
    printData(
      { ok: true, completed: parsed.steps.length, total: parsed.steps.length, results },
      opts
    );
  } else {
    console.log(`run-sequence — completed ${parsed.steps.length} step(s)`);
  }
  return 0;
}

interface StepRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runStep(bin: string, args: string[]): Promise<StepRunResult> {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [bin, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (c: Buffer) => {
      stdout += c.toString();
    });
    proc.stderr.on('data', (c: Buffer) => {
      stderr += c.toString();
    });
    proc.on('close', (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
    proc.on('error', (err) => {
      resolve({ exitCode: 1, stdout: '', stderr: err.message });
    });
  });
}
