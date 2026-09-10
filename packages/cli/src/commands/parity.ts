export const HELP = `  parity record <flow> --out <dir>     Walk a flow and capture every checkpoint as a reference run
  parity compare <flow> --reference <dir>
                                       Walk the same flow against the candidate build and diff it
  parity diff <ref-dir> <cand-dir>     Diff two recorded runs (no device needed)
  parity matrix <ref-dir> <dir...>     Diff one reference against many recorded runs
    --target <label>=<device>          Walk this device as a named target (repeatable;
                                       turns compare into a parallel N-target run)
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

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { getDriver } from '../runner.js';
import { parseFlowFile, executeFlow } from '../drivers/flow-runner.js';
import { printSuccess, printError, printData, OutputOptions } from '../output.js';
import { compareRuns, CompareOptions, ParityReport } from '../parity/compare.js';
import { ALL_KINDS, DiffOptions, FindingKind } from '../parity/diff.js';
import { buildMatrix, ParityMatrix, renderMatrixText, TargetSpec } from '../parity/matrix.js';
import { renderText, writeHtml, writeMatrixHtml } from '../parity/report.js';
import { loadManifest, RunRole, RunWriter, setActiveRun } from '../parity/store.js';

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
  /** `--target label=deviceId`, repeatable. */
  target?: string | string[];
  role?: string;
}

/**
 * Parse `--target <label>=<deviceId>` into the fan-out plan.
 *
 * The label is what names the column in the matrix — "tvOS", "Android TV",
 * "VegaOS", "Lightning" — so it is required and must be unique. A device id
 * containing `=` is fine: only the first separator splits.
 */
export function parseTargets(raw: string | string[] | undefined): Array<{
  label: string;
  device: string;
}> {
  if (raw === undefined) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  const out: Array<{ label: string; device: string }> = [];
  for (const entry of list) {
    const at = entry.indexOf('=');
    if (at <= 0 || at === entry.length - 1) {
      throw new Error(
        `--target must be <label>=<device> (got "${entry}"), e.g. --target "Android TV"=emulator-5554`
      );
    }
    const label = entry.slice(0, at).trim();
    const device = entry.slice(at + 1).trim();
    if (!label || !device) throw new Error(`--target must be <label>=<device> (got "${entry}")`);
    if (out.some((t) => t.label === label)) {
      throw new Error(`--target label "${label}" is used twice; each target needs its own name`);
    }
    out.push({ label, device });
  }
  return out;
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
  if (flags.role && flags.role !== 'reference' && flags.role !== 'candidate') {
    printError(
      `parity record --role must be "reference" or "candidate" (got "${flags.role}")`,
      opts
    );
    return 1;
  }
  try {
    const { dir, checkpoints } = await walk(
      flowFile,
      flags.out,
      (flags.role as RunRole | undefined) ?? 'reference',
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

  let targets: Array<{ label: string; device: string }>;
  try {
    targets = parseTargets(flags.target);
  } catch (err) {
    printError(`parity compare — ${message(err)}`, opts);
    return 1;
  }
  if (targets.length > 0) {
    try {
      return await fanOut(flowFile, targets, flags.reference, opts, flags, env);
    } catch (err) {
      printError(`parity compare — failed\n${message(err)}`, opts);
      return 1;
    }
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

/**
 * Walk N targets and diff them all against one reference.
 *
 * Each target runs in its own child process: the `checkpoint` flow step writes
 * into a process-wide active run, so two flows sharing this process would write
 * into each other's. Separate processes also mean the targets genuinely run in
 * parallel, which is the point — four devices walking the same journey at once.
 */
async function fanOut(
  flowFile: string,
  targets: Array<{ label: string; device: string }>,
  referenceDir: string,
  opts: OutputOptions,
  flags: ParityFlags,
  env: Record<string, string>
): Promise<number> {
  const baseDir = flags.out
    ? path.resolve(flags.out)
    : path.join(path.dirname(path.resolve(referenceDir)), defaultCandidateName());

  const specs: TargetSpec[] = targets.map((t) => ({
    label: t.label,
    dir: path.join(baseDir, slugForLabel(t.label)),
  }));

  if (!opts.json) {
    console.log(`parity — walking ${targets.length} target(s) in parallel:`);
    for (const t of targets) console.log(`  ${t.label} → ${t.device}`);
  }

  const runs = await Promise.all(
    targets.map((t, i) =>
      recordTarget(flowFile, specs[i].dir, t, flags, env).then((r) => ({ ...r, target: t }))
    )
  );

  const failed = runs.filter((r) => r.exitCode !== 0);
  if (failed.length) {
    for (const f of failed) {
      printError(
        `parity — target "${f.target.label}" (${f.target.device}) failed to record:\n${f.output.trim()}`,
        opts
      );
    }
    // A target that never walked has nothing to compare; refusing to report a
    // matrix over a partial set keeps a green-looking grid from hiding a
    // device that never ran at all.
    return 1;
  }

  return emitMatrix(buildMatrix(referenceDir, specs, diffOptionsFrom(flags)), opts, flags);
}

function recordTarget(
  flowFile: string,
  outDir: string,
  target: { label: string; device: string },
  flags: ParityFlags,
  env: Record<string, string>
): Promise<{ exitCode: number; output: string }> {
  const args = [
    'parity',
    'record',
    flowFile,
    '--out',
    outDir,
    '--device',
    target.device,
    '--label',
    target.label,
    '--role',
    'candidate',
  ];
  for (const [k, v] of Object.entries(env)) args.push('--env', `${k}=${v}`);

  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [process.argv[1], ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let output = '';
    proc.stdout.on('data', (c: Buffer) => {
      output += c.toString();
    });
    proc.stderr.on('data', (c: Buffer) => {
      output += c.toString();
    });
    proc.on('close', (code) => resolve({ exitCode: code ?? 1, output }));
    proc.on('error', (err) => resolve({ exitCode: 1, output: err.message }));
  });
}

/** Filesystem-safe directory name for a target label. */
function slugForLabel(label: string): string {
  return (
    label
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'target'
  );
}

/** Offline: diff one reference against many already-recorded runs. */
export async function parityMatrix(
  referenceDir: string,
  candidateDirs: string[],
  opts: OutputOptions = {},
  flags: ParityFlags = {}
): Promise<number> {
  if (!referenceDir || candidateDirs.length === 0) {
    printError('parity matrix requires <reference-dir> <candidate-dir...>', opts);
    return 1;
  }
  try {
    // A run's own label names its column; fall back to the directory name so a
    // run recorded without --label still reads sensibly in the grid.
    const specs: TargetSpec[] = candidateDirs.map((dir) => {
      const resolved = path.resolve(dir);
      let label: string;
      try {
        label = loadManifest(resolved).label ?? path.basename(resolved);
      } catch {
        label = path.basename(resolved);
      }
      return { label, dir: resolved };
    });
    return emitMatrix(buildMatrix(referenceDir, specs, diffOptionsFrom(flags)), opts, flags);
  } catch (err) {
    printError(`parity matrix — failed\n${message(err)}`, opts);
    return 1;
  }
}

/** Write the matrix artifacts, print the grid, and turn it into an exit code. */
function emitMatrix(matrix: ParityMatrix, opts: OutputOptions, flags: ParityFlags): number {
  const written: string[] = [];
  const jsonPath = path.resolve(
    flags.report ?? path.join(path.dirname(matrix.targets[0].dir), 'parity-matrix.json')
  );
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(matrix, null, 2) + '\n');
  written.push(jsonPath);

  if (flags.html) written.push(writeMatrixHtml(matrix, flags.html));

  if (opts.json) {
    printData({ status: matrix.passed ? 'ok' : 'error', matrix, written }, opts);
  } else {
    console.log('');
    console.log(renderMatrixText(matrix));
    for (const f of written) console.log(`\nreport: ${f}`);
    if (matrix.passed) printSuccess('parity — every target matches the reference', opts);
    else
      printError(
        `parity — ${matrix.summary.targets - matrix.summary.targetsPassed} of ` +
          `${matrix.summary.targets} target(s) differ from the reference`,
        opts
      );
  }
  return matrix.passed ? 0 : 1;
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
