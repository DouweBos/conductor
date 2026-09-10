export const HELP = `  parity record <flow> --out <dir>     Walk a flow and capture every checkpoint as a reference run
  parity compare <flow> --reference <dir>
                                       Walk the same flow against the candidate build and diff it
  parity diff <ref-dir> <cand-dir>     Diff two recorded runs (no device needed)
    --out <dir>                       Where to write the candidate run (record/compare)
    --label <text>                    Name this run in the report
    --json-report <path>              Write the JSON report here (default: <run>/parity.json)
    --html <path.html>                Write a side-by-side HTML report (compare/diff)
    --frame-tolerance <pt>            Position drift allowed before 'moved'/'resized' (default 8)
    --pixel-threshold <0-1>           Pixel difference allowed before a 'pixel' finding (default 0.1)
    --min-overlap <0-1>               Frame overlap needed to pair elements by position (default 0.5)
    --ignore-case                     Compare labels case-insensitively
    --ignore-role                     Pair elements without requiring roles to agree
                                       (automatic when the two runs are on different platforms)
    --ignore <kinds>                  Comma-separated finding kinds to drop entirely
    --blocking <kinds>                Comma-separated finding kinds that fail a checkpoint
                                       (default missing,text,value,checkpoint-missing,geometry)
    --strict                          Every finding kind blocks
    --env KEY=VALUE                   Inject env var into the flow (repeatable)`;

import fs from 'fs';
import path from 'path';
import { getDriver } from '../runner.js';
import { parseFlowFile, executeFlow } from '../drivers/flow-runner.js';
import { printSuccess, printError, printData, OutputOptions } from '../output.js';
import { compareRuns, CompareOptions, ParityReport } from '../parity/compare.js';
import { ALL_KINDS, DiffOptions, FindingKind } from '../parity/diff.js';
import { renderText, writeHtml } from '../parity/report.js';
import { RunRole, RunWriter, setActiveRun } from '../parity/store.js';

export interface ParityFlags {
  out?: string;
  reference?: string;
  label?: string;
  report?: string;
  html?: string;
  frameTolerance?: number;
  pixelThreshold?: number;
  minOverlap?: number;
  ignoreCase?: boolean;
  ignoreRole?: boolean;
  ignore?: string;
  blocking?: string;
  strict?: boolean;
}

/** Parse a comma-separated list of finding kinds, rejecting unknown ones early. */
export function parseKinds(raw: string | undefined, flagName: string): FindingKind[] | undefined {
  if (raw === undefined) return undefined;
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const unknown = parts.filter((p) => !ALL_KINDS.includes(p as FindingKind));
  if (unknown.length) {
    throw new Error(
      `${flagName}: unknown finding kind${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')}. ` +
        `Known kinds: ${ALL_KINDS.join(', ')}`
    );
  }
  return parts as FindingKind[];
}

function diffOptionsFrom(flags: ParityFlags): Partial<DiffOptions> {
  const opts: Partial<DiffOptions> = {
    frameTolerance: flags.frameTolerance,
    pixelThreshold: flags.pixelThreshold,
    minOverlap: flags.minOverlap,
    ignoreCase: flags.ignoreCase,
    ignoreRole: flags.ignoreRole,
    ignore: parseKinds(flags.ignore, '--ignore'),
    blocking: parseKinds(flags.blocking, '--blocking'),
  };
  if (flags.strict) opts.blocking = [...ALL_KINDS];
  return opts;
}

// ── Recording a run ──────────────────────────────────────────────────────────

/** Walk `flow`, capturing every `checkpoint` step into a run directory. */
async function walk(
  flowFile: string,
  outDir: string,
  role: RunRole,
  sessionName: string,
  opts: OutputOptions,
  flags: ParityFlags,
  env: Record<string, string>
): Promise<{ dir: string; checkpoints: number }> {
  const resolvedFlow = path.resolve(process.cwd(), flowFile);
  const dir = path.resolve(outDir);
  const driver = await getDriver(sessionName);
  const flow = await parseFlowFile(resolvedFlow, env);

  const writer = new RunWriter(dir, {
    role,
    deviceId: sessionName,
    flow: resolvedFlow,
    label: flags.label,
    appId: flow.appId,
  });

  setActiveRun(writer);
  try {
    await executeFlow(flow, driver, { cwd: path.dirname(resolvedFlow), env });
  } finally {
    setActiveRun(null);
    writer.finish();
  }

  if (writer.checkpointCount === 0) {
    printError(
      `parity — the flow completed but recorded no checkpoints. ` +
        `Add \`- checkpoint: <name>\` steps to ${path.basename(resolvedFlow)} at the points you want compared.`,
      opts
    );
  }
  return { dir, checkpoints: writer.checkpointCount };
}

export async function parityRecord(
  flowFile: string,
  opts: OutputOptions = {},
  sessionName = 'default',
  flags: ParityFlags = {},
  env: Record<string, string> = {}
): Promise<number> {
  if (!flowFile) {
    printError('parity record requires <flow>', opts);
    return 1;
  }
  if (!flags.out) {
    printError('parity record requires --out <dir>', opts);
    return 1;
  }
  try {
    const { dir, checkpoints } = await walk(
      flowFile,
      flags.out,
      'reference',
      sessionName,
      opts,
      flags,
      env
    );
    if (opts.json) printData({ status: 'ok', dir, checkpoints }, opts);
    else printSuccess(`parity record — ${checkpoints} checkpoint(s) written to ${dir}`, opts);
    return checkpoints === 0 ? 1 : 0;
  } catch (err) {
    printError(`parity record — failed\n${message(err)}`, opts);
    return 1;
  }
}

// ── Comparing ────────────────────────────────────────────────────────────────

export async function parityCompare(
  flowFile: string,
  opts: OutputOptions = {},
  sessionName = 'default',
  flags: ParityFlags = {},
  env: Record<string, string> = {}
): Promise<number> {
  if (!flowFile) {
    printError('parity compare requires <flow>', opts);
    return 1;
  }
  if (!flags.reference) {
    printError('parity compare requires --reference <dir> (a run from `parity record`)', opts);
    return 1;
  }
  if (!fs.existsSync(path.resolve(flags.reference))) {
    printError(`parity compare — reference run not found: ${path.resolve(flags.reference)}`, opts);
    return 1;
  }

  // Default the candidate run alongside the reference so a bare `compare` still
  // leaves both halves on disk to re-diff later.
  const outDir =
    flags.out ?? path.join(path.dirname(path.resolve(flags.reference)), defaultCandidateName());

  try {
    const { dir, checkpoints } = await walk(
      flowFile,
      outDir,
      'candidate',
      sessionName,
      opts,
      flags,
      env
    );
    if (checkpoints === 0) return 1;
    return emit(compareRuns(flags.reference, dir, diffOptionsFrom(flags)), opts, flags);
  } catch (err) {
    printError(`parity compare — failed\n${message(err)}`, opts);
    return 1;
  }
}

export async function parityDiff(
  referenceDir: string,
  candidateDir: string,
  opts: OutputOptions = {},
  flags: ParityFlags = {}
): Promise<number> {
  if (!referenceDir || !candidateDir) {
    printError('parity diff requires <reference-dir> <candidate-dir>', opts);
    return 1;
  }
  try {
    const options: CompareOptions = diffOptionsFrom(flags);
    return emit(compareRuns(referenceDir, candidateDir, options), opts, flags);
  } catch (err) {
    printError(`parity diff — failed\n${message(err)}`, opts);
    return 1;
  }
}

/** Write the artifacts, print the verdict, and turn it into an exit code. */
function emit(report: ParityReport, opts: OutputOptions, flags: ParityFlags): number {
  const written: string[] = [];

  // The JSON report always lands next to the candidate run, so a failing gate
  // leaves a machine-readable record behind without needing an extra flag.
  const jsonPath = path.resolve(flags.report ?? path.join(report.candidate.dir, 'parity.json'));
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2) + '\n');
  written.push(jsonPath);

  if (flags.html) written.push(writeHtml(report, flags.html));

  if (opts.json) {
    printData({ status: report.passed ? 'ok' : 'error', report, written }, opts);
  } else {
    console.log(renderText(report));
    for (const f of written) console.log(`\nreport: ${f}`);
    if (report.passed) {
      printSuccess(`parity — candidate matches the reference`, opts);
    } else {
      printError(`parity — ${report.summary.failed} checkpoint(s) differ from the reference`, opts);
    }
  }
  return report.passed ? 0 : 1;
}

function defaultCandidateName(): string {
  return `candidate-${new Date().toISOString().replace(/[:.]/g, '-')}`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
