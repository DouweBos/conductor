/**
 * Hermes sampling profiler over the Metro CDP connection.
 *
 * `Profiler.start` / `Profiler.stop` return a Chrome `.cpuprofile`, so the raw
 * file drops straight into Chrome DevTools (or `hermes-profile-transformer` for
 * a Chrome trace), while the ranked self/total table is what an agent reads.
 *
 * `start`/`stop` hand the CDP socket to a detached holder process rather than
 * closing it between the two commands: whether Hermes keeps sampling across a
 * dropped debugger session is not contractual, and a holder makes it moot.
 */

import { spawn } from 'child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { printError, printData, printSuccess, OutputOptions } from '../output.js';
import { detectPlatform } from '../drivers/bootstrap.js';
import { MetroCdpClient, resolveMetroPort } from '../drivers/metro-cdp.js';
import { round } from '../stats.js';

// ── cpuprofile analysis ───────────────────────────────────────────────────────

export interface CallFrame {
  functionName: string;
  scriptId?: string;
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
}

export interface ProfileNode {
  id: number;
  callFrame: CallFrame;
  hitCount?: number;
  children?: number[];
}

export interface CpuProfile {
  nodes: ProfileNode[];
  startTime: number;
  endTime: number;
  samples?: number[];
  timeDeltas?: number[];
}

export interface FunctionStat {
  name: string;
  location: string;
  selfMs: number;
  totalMs: number;
  selfPercent: number;
  samples: number;
}

export interface JsProfileSummary {
  durationMs: number;
  sampleCount: number;
  /** Nominal sampling interval, derived from the observed median delta. */
  medianSampleIntervalMs: number;
  top: FunctionStat[];
  /** Functions omitted from `top` — non-zero means the ranking is truncated. */
  omitted: number;
}

function shortFile(url: string | undefined): string {
  const u = url ?? '';
  return u.includes('/') ? u.slice(u.lastIndexOf('/') + 1) : u;
}

function frameKey(frame: CallFrame): string {
  const line = frame.lineNumber !== undefined ? `:${frame.lineNumber + 1}` : '';
  return `${frame.functionName || '(anonymous)'} ${shortFile(frame.url)}${line}`;
}

/**
 * Self time is the sample's own node; total time credits every function on the
 * stack once per sample, so a recursive function is not counted twice for the
 * same sample.
 */
export function analyzeCpuProfile(profile: CpuProfile, top: number): JsProfileSummary {
  const byId = new Map<number, ProfileNode>();
  const parentOf = new Map<number, number>();
  for (const node of profile.nodes) {
    byId.set(node.id, node);
    for (const child of node.children ?? []) parentOf.set(child, node.id);
  }

  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  const self = new Map<string, number>();
  const total = new Map<string, number>();
  const hits = new Map<string, number>();
  const label = new Map<string, CallFrame>();

  const add = (map: Map<string, number>, key: string, v: number): void => {
    map.set(key, (map.get(key) ?? 0) + v);
  };

  for (let i = 0; i < samples.length; i++) {
    const node = byId.get(samples[i]);
    if (!node) continue;
    const deltaUs = deltas[i] ?? 0;
    const key = frameKey(node.callFrame);
    label.set(key, node.callFrame);
    add(self, key, deltaUs);
    add(hits, key, 1);

    const seen = new Set<string>();
    let cursor: number | undefined = node.id;
    while (cursor !== undefined) {
      const cur = byId.get(cursor);
      if (!cur) break;
      const k = frameKey(cur.callFrame);
      label.set(k, cur.callFrame);
      if (!seen.has(k)) {
        seen.add(k);
        add(total, k, deltaUs);
      }
      cursor = parentOf.get(cursor);
    }
  }

  const totalUs = [...self.values()].reduce((a, b) => a + b, 0);
  const ranked: FunctionStat[] = [...self.entries()]
    .map(([key, selfUs]) => {
      const frame = label.get(key)!;
      const file = shortFile(frame.url) || '(unknown)';
      return {
        name: frame.functionName || '(anonymous)',
        location: frame.lineNumber !== undefined ? `${file}:${frame.lineNumber + 1}` : file,
        selfMs: round(selfUs / 1000),
        totalMs: round((total.get(key) ?? 0) / 1000),
        selfPercent: totalUs > 0 ? round((selfUs / totalUs) * 100) : 0,
        samples: hits.get(key) ?? 0,
      };
    })
    .sort((a, b) => b.selfMs - a.selfMs);

  const sortedDeltas = deltas.filter((d) => d > 0).sort((a, b) => a - b);
  return {
    durationMs: round((profile.endTime - profile.startTime) / 1000),
    sampleCount: samples.length,
    medianSampleIntervalMs:
      sortedDeltas.length > 0 ? round(sortedDeltas[Math.floor(sortedDeltas.length / 2)] / 1000) : 0,
    top: ranked.slice(0, top),
    omitted: Math.max(0, ranked.length - top),
  };
}

// ── CDP plumbing ──────────────────────────────────────────────────────────────

interface CdpOpts {
  port?: number;
  targetIndex?: number;
}

async function connect(sessionName: string, cdpOpts: CdpOpts): Promise<MetroCdpClient> {
  const platform = await detectPlatform(sessionName).catch(() => undefined);
  const deviceId = sessionName !== 'default' ? sessionName : undefined;
  const port = await resolveMetroPort({ port: cdpOpts.port, deviceId, platform });
  const client = new MetroCdpClient();
  await client.connect({ port, deviceId, platform, targetIndex: cdpOpts.targetIndex });
  return client;
}

async function startSampling(client: MetroCdpClient): Promise<void> {
  await client.send('Profiler.enable');
  await client.send('Profiler.start');
}

async function stopSampling(client: MetroCdpClient): Promise<CpuProfile> {
  const res = await client.send<{ profile: CpuProfile }>('Profiler.stop');
  if (!res?.profile?.nodes) {
    throw new Error(
      'Profiler.stop returned no profile — the runtime may not be Hermes, or sampling never started'
    );
  }
  return res.profile;
}

function defaultOut(): string {
  return path.join(os.tmpdir(), `js-${new Date().toISOString().replace(/[:.]/g, '-')}.cpuprofile`);
}

async function writeProfile(out: string, profile: CpuProfile): Promise<void> {
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, JSON.stringify(profile));
}

function printSummary(summary: JsProfileSummary, out: string): void {
  console.log(
    `profile js — ${summary.durationMs}ms, ${summary.sampleCount} samples ` +
      `(~${summary.medianSampleIntervalMs}ms apart)`
  );
  console.log(`  ${'self'.padStart(9)} ${'total'.padStart(9)}  ${'%'.padStart(5)}  function`);
  for (const f of summary.top) {
    console.log(
      `  ${`${f.selfMs}ms`.padStart(9)} ${`${f.totalMs}ms`.padStart(9)}  ` +
        `${f.selfPercent.toFixed(1).padStart(5)}  ${f.name}  ${f.location}`
    );
  }
  if (summary.omitted > 0) console.log(`  ... ${summary.omitted} more (raise --top)`);
  console.log(`\n  raw profile → ${out}`);
  console.log(
    '  open it in Chrome DevTools (Performance → Load profile), or convert with ' +
      '`npx hermes-profile-transformer`.'
  );
}

// ── Commands ──────────────────────────────────────────────────────────────────

export interface ProfileJsOptions extends CdpOpts {
  durationSec?: number;
  out?: string;
  top?: number;
}

export async function profileJsRecord(
  opts: OutputOptions,
  sessionName: string,
  jsOpts: ProfileJsOptions
): Promise<number> {
  const out = jsOpts.out ?? defaultOut();
  let client: MetroCdpClient | undefined;
  try {
    client = await connect(sessionName, jsOpts);
    await startSampling(client);
    await new Promise((r) => setTimeout(r, (jsOpts.durationSec ?? 10) * 1000));
    const profile = await stopSampling(client);
    await writeProfile(out, profile);
    const summary = analyzeCpuProfile(profile, jsOpts.top ?? 20);
    if (opts.json) printData({ status: 'ok', out, ...summary }, opts);
    else printSummary(summary, out);
    return 0;
  } catch (err) {
    printError(`profile js record — ${err instanceof Error ? err.message : String(err)}`, opts);
    return 1;
  } finally {
    client?.close();
  }
}

// ── start / stop via a detached holder ────────────────────────────────────────

function stateDir(): string {
  return path.join(os.homedir(), '.conductor', 'js-profiles');
}

interface HolderState {
  pid: number;
  session: string;
  out: string;
  startedAt: string;
}

const paths = (session: string): { state: string; stop: string; done: string } => ({
  state: path.join(stateDir(), `${session}.json`),
  stop: path.join(stateDir(), `${session}.stop`),
  done: path.join(stateDir(), `${session}.done`),
});

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

export async function profileJsStart(
  opts: OutputOptions,
  sessionName: string,
  jsOpts: ProfileJsOptions
): Promise<number> {
  const p = paths(sessionName);
  await fs.mkdir(stateDir(), { recursive: true });

  const existing = await readJson<HolderState>(p.state);
  if (existing) {
    printError(
      `profile js start — already sampling (holder pid ${existing.pid}, since ${existing.startedAt}). ` +
        'Run `conductor profile js stop` first.',
      opts
    );
    return 1;
  }

  const out = jsOpts.out ?? defaultOut();
  await fs.rm(p.stop, { force: true });
  await fs.rm(p.done, { force: true });

  const args = [process.argv[1], 'profile', 'js', '_hold', '--out', out];
  if (sessionName !== 'default') args.push('--device', sessionName);
  if (jsOpts.port !== undefined) args.push('--port', String(jsOpts.port));
  if (jsOpts.targetIndex !== undefined) args.push('--target', String(jsOpts.targetIndex));

  const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore' });
  child.unref();

  // The holder writes the state file once sampling is actually running, so a
  // failure to attach surfaces here rather than at `stop`.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const state = await readJson<HolderState>(p.state);
    if (state) {
      if (opts.json) printData({ status: 'ok', ...state }, opts);
      else printSuccess(`profile js start — sampling (holder pid ${state.pid})`, opts);
      return 0;
    }
    const done = await readJson<{ error?: string }>(p.done);
    if (done?.error) {
      printError(`profile js start — ${done.error}`, opts);
      await fs.rm(p.done, { force: true });
      return 1;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  printError('profile js start — holder did not report back within 15s', opts);
  return 1;
}

export async function profileJsStop(
  opts: OutputOptions,
  sessionName: string,
  jsOpts: ProfileJsOptions
): Promise<number> {
  const p = paths(sessionName);
  const state = await readJson<HolderState>(p.state);
  if (!state) {
    printError('profile js stop — not sampling (run `conductor profile js start` first)', opts);
    return 1;
  }

  await fs.writeFile(p.stop, '');
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const done = await readJson<{ error?: string; out?: string }>(p.done);
    if (done) {
      await fs.rm(p.done, { force: true });
      await fs.rm(p.state, { force: true });
      if (done.error) {
        printError(`profile js stop — ${done.error}`, opts);
        return 1;
      }
      const profile = await readJson<CpuProfile>(done.out!);
      if (!profile) {
        printError(`profile js stop — could not read ${done.out}`, opts);
        return 1;
      }
      const summary = analyzeCpuProfile(profile, jsOpts.top ?? 20);
      if (opts.json) printData({ status: 'ok', out: done.out, ...summary }, opts);
      else printSummary(summary, done.out!);
      return 0;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  printError('profile js stop — holder did not finish within 30s', opts);
  return 1;
}

/**
 * Internal: hold the CDP socket open for the duration of a start/stop pair.
 * Not part of the public CLI surface.
 */
export async function profileJsHold(
  sessionName: string,
  jsOpts: ProfileJsOptions
): Promise<number> {
  const p = paths(sessionName);
  await fs.mkdir(stateDir(), { recursive: true });
  const out = jsOpts.out ?? defaultOut();
  let client: MetroCdpClient | undefined;

  try {
    client = await connect(sessionName, jsOpts);
    await startSampling(client);
    await fs.writeFile(
      p.state,
      JSON.stringify(
        { pid: process.pid, session: sessionName, out, startedAt: new Date().toISOString() },
        null,
        2
      )
    );
  } catch (err) {
    await fs.writeFile(
      p.done,
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
    );
    client?.close();
    return 1;
  }

  // Safety valve: never hold a debugger session open indefinitely.
  const deadline = Date.now() + 15 * 60_000;
  let stopped = false;
  while (Date.now() < deadline) {
    const stopRequested = await fs
      .stat(p.stop)
      .then(() => true)
      .catch(() => false);
    if (stopRequested) {
      stopped = true;
      break;
    }
    if (!client.isConnected()) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  try {
    if (!client.isConnected()) throw new Error('the app disconnected from Metro while sampling');
    const profile = await stopSampling(client);
    await writeProfile(out, profile);
    await fs.writeFile(p.done, JSON.stringify({ out, stoppedByRequest: stopped }));
    return 0;
  } catch (err) {
    await fs.writeFile(
      p.done,
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
    );
    return 1;
  } finally {
    client?.close();
    await fs.rm(p.stop, { force: true });
    await fs.rm(p.state, { force: true });
  }
}
