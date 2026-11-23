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
import { MetroCdpClient, resolveMetroPort, targetAppId } from '../drivers/metro-cdp.js';
import { getSession } from '../session.js';
import {
  scriptFileName,
  SourceMapLookup,
  RawSourceMap,
  metroSourceMapUrl,
  shortSourcePath,
} from '../source-map.js';
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
  /** Raw frame position (bundle URL, 0-based line/column) for source-map lookup. */
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
  /** Original source `file:line`, when the bundle's source map was available. */
  source?: string;
  selfMs: number;
  totalMs: number;
  selfPercent: number;
  samples: number;
}

export interface JsNote {
  code: 'low-attribution';
  message: string;
  namedJsPercent?: number;
  gcPercent?: number;
  idlePercent?: number;
}

/**
 * Where the sampled time went before any function ranking is attempted.
 *
 * Hermes reports synthetic frames — `[root]` when the JS stack was empty at
 * sample time, `[GC Young Gen]` / `[GC Old Gen (Direct)]` for collections.
 * Those shares are trustworthy even when the per-function ranking is built on
 * single-digit hit counts, so they are reported separately rather than being
 * allowed to sit in the same table as real functions.
 */
export interface SampleAttribution {
  /** Share of sampled time in frames that name a JS function. */
  namedJsPercent: number;
  /** Share in Hermes GC frames. High here is a memory finding, not a CPU one. */
  gcPercent: number;
  /** Share in `[root]` — the JS stack was empty, i.e. JS was not running. */
  idlePercent: number;
}

export interface JsProfileSummary {
  durationMs: number;
  sampleCount: number;
  /** Nominal sampling interval, derived from the observed median delta. */
  medianSampleIntervalMs: number;
  attribution: SampleAttribution;
  top: FunctionStat[];
  /** Functions omitted from `top` — non-zero means the ranking is truncated. */
  omitted: number;
  notes: JsNote[];
}

/** Hermes marks its own frames with brackets; anything else is app code. */
function classifyFrame(name: string): 'gc' | 'idle' | 'named' {
  if (/^\[GC\b/i.test(name) || /garbage collector/i.test(name)) return 'gc';
  if (name === '[root]' || name === '(root)' || name === '(program)' || name === '(idle)') {
    return 'idle';
  }
  return name.startsWith('[') || name.startsWith('(') ? 'idle' : 'named';
}

const shortFile = scriptFileName;

function frameKey(frame: CallFrame): string {
  const line = frame.lineNumber !== undefined ? `:${frame.lineNumber + 1}` : '';
  const col = frame.columnNumber !== undefined ? `:${frame.columnNumber}` : '';
  return `${frame.functionName || '(anonymous)'} ${shortFile(frame.url)}${line}${col}`;
}

/**
 * Self time is the sample's own node; total time credits every function on the
 * stack once per sample, so a recursive function is not counted twice for the
 * same sample.
 */
export function analyzeCpuProfile(profile: CpuProfile, top: number): JsProfileSummary {
  return analyzeCpuProfiles([profile], top);
}

/**
 * Same as `analyzeCpuProfile` over several segments of one recording — the
 * sampler restarts after a dropped debugger session, and each restart is its
 * own profile. Gaps between segments are not credited to any function.
 */
export function analyzeCpuProfiles(profiles: CpuProfile[], top: number): JsProfileSummary {
  const self = new Map<string, number>();
  const total = new Map<string, number>();
  const hits = new Map<string, number>();
  const label = new Map<string, CallFrame>();
  const allDeltas: number[] = [];
  let sampleCount = 0;
  let durationUs = 0;

  const add = (map: Map<string, number>, key: string, v: number): void => {
    map.set(key, (map.get(key) ?? 0) + v);
  };

  for (const profile of profiles) {
    const byId = new Map<number, ProfileNode>();
    const parentOf = new Map<number, number>();
    for (const node of profile.nodes) {
      byId.set(node.id, node);
      for (const child of node.children ?? []) parentOf.set(child, node.id);
    }

    const samples = profile.samples ?? [];
    const deltas = profile.timeDeltas ?? [];
    sampleCount += samples.length;
    durationUs += profile.endTime - profile.startTime;
    allDeltas.push(...deltas);

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
  }

  const totalUs = [...self.values()].reduce((a, b) => a + b, 0);

  // Split before ranking: a top-30 list assembled from 5% of the samples is
  // noise dressed as a finding, and the reader cannot tell without this.
  const buckets = { gc: 0, idle: 0, named: 0 };
  for (const [key, us] of self.entries()) {
    buckets[classifyFrame(label.get(key)!.functionName || '(anonymous)')] += us;
  }
  const share = (v: number): number => (totalUs > 0 ? round((v / totalUs) * 100, 1) : 0);
  const attribution: SampleAttribution = {
    namedJsPercent: share(buckets.named),
    gcPercent: share(buckets.gc),
    idlePercent: share(buckets.idle),
  };

  const notes: JsNote[] = [];
  if (totalUs > 0 && attribution.namedJsPercent < 25) {
    notes.push({
      code: 'low-attribution',
      message:
        `Only ${attribution.namedJsPercent}% of sampled time landed in a named JS function ` +
        `(${attribution.idlePercent}% with an empty JS stack, ${attribution.gcPercent}% in GC). ` +
        `The ranking below is built on what little is left and should not be trusted. ` +
        `A large empty-stack share means the JS thread was idle when sampled — which is itself ` +
        `a result: the bottleneck is not JS. A large GC share is a memory finding; follow it ` +
        `with \`profile memory --track\` rather than a function ranking.`,
      namedJsPercent: attribution.namedJsPercent,
      gcPercent: attribution.gcPercent,
      idlePercent: attribution.idlePercent,
    });
  }

  const ranked: FunctionStat[] = [...self.entries()]
    .map(([key, selfUs]) => {
      const frame = label.get(key)!;
      const file = shortFile(frame.url) || '(unknown)';
      return {
        name: frame.functionName || '(anonymous)',
        location: frame.lineNumber !== undefined ? `${file}:${frame.lineNumber + 1}` : file,
        url: frame.url || undefined,
        lineNumber: frame.lineNumber,
        columnNumber: frame.columnNumber,
        selfMs: round(selfUs / 1000),
        totalMs: round((total.get(key) ?? 0) / 1000),
        selfPercent: totalUs > 0 ? round((selfUs / totalUs) * 100) : 0,
        samples: hits.get(key) ?? 0,
      };
    })
    .sort((a, b) => b.selfMs - a.selfMs);

  const sortedDeltas = allDeltas.filter((d) => d > 0).sort((a, b) => a - b);
  return {
    durationMs: round(durationUs / 1000),
    sampleCount,
    medianSampleIntervalMs:
      sortedDeltas.length > 0 ? round(sortedDeltas[Math.floor(sortedDeltas.length / 2)] / 1000) : 0,
    attribution,
    top: ranked.slice(0, top),
    omitted: Math.max(0, ranked.length - top),
    notes,
  };
}

// ── CDP plumbing ──────────────────────────────────────────────────────────────

export interface CdpOpts {
  port?: number;
  targetIndex?: number;
  /** Bundle/package id — required when several apps on one device share Metro. */
  appId?: string;
  /** Exact Metro page id. */
  pageId?: string;
  /** Re-attach to this Metro logical device (internal, used across reconnects). */
  logicalDeviceId?: string;
}

/**
 * Connect to the session device's Metro target. When the device has several
 * apps attached and no `--app` was given, fall back to the app conductor last
 * launched on this session rather than failing.
 */
export async function connectMetro(sessionName: string, cdpOpts: CdpOpts): Promise<MetroCdpClient> {
  const platform = await detectPlatform(sessionName).catch(() => undefined);
  const deviceId = sessionName !== 'default' ? sessionName : undefined;
  const port = await resolveMetroPort({ port: cdpOpts.port, deviceId, platform });
  const base = {
    port,
    deviceId: cdpOpts.logicalDeviceId ? undefined : deviceId,
    platform,
    targetIndex: cdpOpts.targetIndex,
    appId: cdpOpts.appId,
    pageId: cdpOpts.pageId,
    logicalDeviceId: cdpOpts.logicalDeviceId,
  };
  const client = new MetroCdpClient();
  try {
    await client.connect(base);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const sessionApp = await getSession(sessionName)
      .then((s) => s.appId)
      .catch(() => undefined);
    if (!cdpOpts.appId && sessionApp && /Several apps/.test(msg)) {
      await client.connect({ ...base, appId: sessionApp });
    } else throw err;
  }
  return client;
}

async function startSampling(client: MetroCdpClient): Promise<void> {
  // React Native's Fusebox CDP backend answers `Profiler.enable` with
  // -32601 Unsupported method, but implements `Profiler.start` perfectly well.
  // Enabling is a courtesy to backends that require it, never a precondition.
  await client.send('Profiler.enable').catch(() => undefined);
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

/**
 * Stitch segments into one profile for Chrome DevTools. Each segment's root
 * hangs off a new root; the gap between segments lands in the first delta of
 * the next one, so the timeline stays truthful.
 */
export function mergeCpuProfiles(profiles: CpuProfile[]): CpuProfile {
  if (profiles.length === 1) return profiles[0];
  const nodes: ProfileNode[] = [{ id: 1, callFrame: { functionName: '(root)' }, children: [] }];
  const samples: number[] = [];
  const timeDeltas: number[] = [];
  let offset = 1;
  let prevEnd: number | undefined;
  for (const p of profiles) {
    const maxId = p.nodes.reduce((m, n) => Math.max(m, n.id), 0);
    const childIds = new Set(p.nodes.flatMap((n) => n.children ?? []));
    for (const n of p.nodes) {
      nodes.push({ ...n, id: n.id + offset, children: (n.children ?? []).map((c) => c + offset) });
      if (!childIds.has(n.id)) nodes[0].children!.push(n.id + offset);
    }
    const ps = p.samples ?? [];
    const pd = p.timeDeltas ?? [];
    for (let i = 0; i < ps.length; i++) {
      samples.push(ps[i] + offset);
      const gap = i === 0 && prevEnd !== undefined ? Math.max(0, p.startTime - prevEnd) : 0;
      timeDeltas.push((pd[i] ?? 0) + gap);
    }
    prevEnd = p.endTime;
    offset += maxId;
  }
  return {
    nodes,
    startTime: profiles[0].startTime,
    endTime: profiles[profiles.length - 1].endTime,
    samples,
    timeDeltas,
  };
}

// ── Source maps ───────────────────────────────────────────────────────────────

/**
 * Map each function's bundle position to its original `file:line` using the
 * source map Metro serves next to the bundle. Best effort: any failure leaves
 * `source` unset. `cache` is updated with `url:line:col → file:line`.
 */
export async function symbolicateStats(
  stats: FunctionStat[],
  cache: Record<string, string | null> = {},
  timeoutMs = 60_000
): Promise<Record<string, string | null>> {
  const key = (f: FunctionStat): string => `${f.url}:${f.lineNumber}:${f.columnNumber}`;
  const pending = stats.filter(
    (f) => f.url && f.lineNumber !== undefined && cache[key(f)] === undefined
  );
  const urls = [...new Set(pending.map((f) => f.url!))];
  for (const url of urls) {
    const mapUrl = metroSourceMapUrl(url);
    let lookup: SourceMapLookup | undefined;
    if (mapUrl) {
      try {
        const res = await fetch(mapUrl, { signal: AbortSignal.timeout(timeoutMs) });
        if (res.ok) lookup = new SourceMapLookup((await res.json()) as RawSourceMap);
      } catch {
        // Metro gone or map too large: leave these unsymbolicated.
      }
    }
    // No map (Metro gone): leave uncached so a later run can retry.
    if (!lookup) continue;
    for (const f of pending.filter((p) => p.url === url)) {
      const pos = lookup.originalPositionFor(f.lineNumber! + 1, f.columnNumber ?? 0);
      cache[key(f)] = pos ? `${shortSourcePath(pos.source)}:${pos.line}` : null;
    }
  }
  for (const f of stats) {
    const v = f.url ? cache[key(f)] : undefined;
    if (v) f.source = v;
  }
  return cache;
}

export function printSummary(summary: JsProfileSummary, out: string, title = 'profile js'): void {
  console.log(
    `${title} — ${summary.durationMs}ms, ${summary.sampleCount} samples ` +
      `(~${summary.medianSampleIntervalMs}ms apart)`
  );
  const a = summary.attribution;
  console.log(
    `  sampled time:  ${a.namedJsPercent}% named JS  ${a.gcPercent}% GC  ` +
      `${a.idlePercent}% empty JS stack`
  );
  console.log(`\n  ${'self'.padStart(9)} ${'total'.padStart(9)}  ${'%'.padStart(5)}  function`);
  for (const f of summary.top) {
    console.log(
      `  ${`${f.selfMs}ms`.padStart(9)} ${`${f.totalMs}ms`.padStart(9)}  ` +
        `${f.selfPercent.toFixed(1).padStart(5)}  ${f.name}  ${f.source ?? f.location}`
    );
  }
  if (summary.omitted > 0) console.log(`  ... ${summary.omitted} more (raise --top)`);
  for (const note of summary.notes) console.log(`\n  note [${note.code}]: ${note.message}`);
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
  /** Map functions to original sources via Metro's source map (default on). */
  symbolicate?: boolean;
}

export async function profileJsRecord(
  opts: OutputOptions,
  sessionName: string,
  jsOpts: ProfileJsOptions
): Promise<number> {
  const out = jsOpts.out ?? defaultOut();
  let client: MetroCdpClient | undefined;
  try {
    client = await connectMetro(sessionName, jsOpts);
    await startSampling(client);
    await new Promise((r) => setTimeout(r, (jsOpts.durationSec ?? 10) * 1000));
    const profile = await stopSampling(client);
    await writeProfile(out, profile);
    const summary = analyzeCpuProfile(profile, jsOpts.top ?? 20);
    if (jsOpts.symbolicate !== false) await symbolicateStats(summary.top);
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

export interface HolderState {
  pid: number;
  session: string;
  out: string;
  startedAt: string;
  /** Host and runtime clocks at the moment sampling started, for lining up with commits. */
  startedAtHostMs?: number;
  startedAtRuntimeMs?: number;
  target?: PinnedTarget;
}

export interface PinnedTarget {
  port: number;
  pageId?: string;
  appId?: string;
  logicalDeviceId?: string;
  deviceName?: string;
  title?: string;
}

/** A stretch of the recording during which the debugger session was gone. */
export interface SamplingGap {
  /** Offset from the start of sampling. */
  atMs: number;
  durationMs: number;
  /**
   * `continued`: Hermes kept sampling through the drop and the samples were
   * recovered. `restarted`: they were lost and sampling started again.
   * `lost`: the app never came back.
   */
  resumed: 'continued' | 'restarted' | 'lost';
}

export interface HolderDone {
  error?: string;
  out?: string;
  /** Segment files, in order. One entry unless the session dropped mid-recording. */
  segments?: string[];
  gaps?: SamplingGap[];
  stoppedByRequest?: boolean;
  startedAtHostMs?: number;
  startedAtRuntimeMs?: number;
  target?: PinnedTarget;
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

/** The running holder for this session, if any. */
export async function activeJsHolder(sessionName: string): Promise<HolderState | null> {
  const state = await readJson<HolderState>(paths(sessionName).state);
  if (!state) return null;
  try {
    process.kill(state.pid, 0);
    return state;
  } catch {
    // Holder died without cleaning up (machine slept, killed): stale.
    await fs.rm(paths(sessionName).state, { force: true });
    return null;
  }
}

/** Spawn the holder and wait until Hermes is actually sampling. Throws on failure. */
export async function startJsHolder(
  sessionName: string,
  jsOpts: ProfileJsOptions
): Promise<HolderState> {
  const p = paths(sessionName);
  await fs.mkdir(stateDir(), { recursive: true });

  const existing = await activeJsHolder(sessionName);
  if (existing) {
    throw new Error(
      `already sampling (holder pid ${existing.pid}, since ${existing.startedAt}). ` +
        'Stop that recording first (`conductor profile js stop` or `conductor profile react stop`).'
    );
  }

  const out = jsOpts.out ?? defaultOut();
  await fs.rm(p.stop, { force: true });
  await fs.rm(p.done, { force: true });

  const args = [process.argv[1], 'profile', 'js', '_hold', '--out', out];
  if (sessionName !== 'default') args.push('--device', sessionName);
  if (jsOpts.port !== undefined) args.push('--port', String(jsOpts.port));
  if (jsOpts.targetIndex !== undefined) args.push('--target', String(jsOpts.targetIndex));
  if (jsOpts.appId) args.push('--app', jsOpts.appId);
  if (jsOpts.pageId) args.push('--page', jsOpts.pageId);

  const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore' });
  child.unref();

  // The holder writes the state file once sampling is actually running, so a
  // failure to attach surfaces here rather than at `stop`.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const state = await readJson<HolderState>(p.state);
    if (state) return state;
    const done = await readJson<{ error?: string }>(p.done);
    if (done?.error) {
      await fs.rm(p.done, { force: true });
      throw new Error(done.error);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('holder did not report back within 15s');
}

/** Ask the holder to stop and wait for its result. Throws when nothing is sampling. */
export async function stopJsHolder(sessionName: string): Promise<HolderDone> {
  const p = paths(sessionName);
  const state = await readJson<HolderState>(p.state);
  const done0 = await readJson<HolderDone>(p.done);
  if (!state && !done0) throw new Error('not sampling (run `conductor profile js start` first)');

  if (state) await fs.writeFile(p.stop, '');
  // Generous: after a drop the holder may still be waiting for the app to come back.
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const done = await readJson<HolderDone>(p.done);
    if (done) {
      await fs.rm(p.done, { force: true });
      await fs.rm(p.state, { force: true });
      if (done.error && !(done.segments && done.segments.length > 0)) throw new Error(done.error);
      return done;
    }
    if (state) {
      try {
        process.kill(state.pid, 0);
      } catch {
        await fs.rm(p.state, { force: true });
        throw new Error(`holder pid ${state.pid} exited without writing a result`);
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('holder did not finish within 90s');
}

export async function loadSegments(done: HolderDone): Promise<CpuProfile[]> {
  const files = done.segments && done.segments.length > 0 ? done.segments : [done.out!];
  const profiles: CpuProfile[] = [];
  for (const f of files) {
    const prof = await readJson<CpuProfile>(f);
    if (!prof) throw new Error(`could not read ${f}`);
    profiles.push(prof);
  }
  return profiles;
}

export async function profileJsStart(
  opts: OutputOptions,
  sessionName: string,
  jsOpts: ProfileJsOptions
): Promise<number> {
  try {
    const state = await startJsHolder(sessionName, jsOpts);
    if (opts.json) printData({ status: 'ok', ...state }, opts);
    else printSuccess(`profile js start — sampling (holder pid ${state.pid})`, opts);
    return 0;
  } catch (err) {
    printError(`profile js start — ${err instanceof Error ? err.message : String(err)}`, opts);
    return 1;
  }
}

export async function profileJsStop(
  opts: OutputOptions,
  sessionName: string,
  jsOpts: ProfileJsOptions
): Promise<number> {
  try {
    const done = await stopJsHolder(sessionName);
    const summary = analyzeCpuProfiles(await loadSegments(done), jsOpts.top ?? 20);
    if (jsOpts.symbolicate !== false) await symbolicateStats(summary.top);
    if (opts.json) printData({ status: 'ok', out: done.out, gaps: done.gaps, ...summary }, opts);
    else {
      printSummary(summary, done.out!);
      printGaps(done.gaps ?? []);
    }
    return 0;
  } catch (err) {
    printError(`profile js stop — ${err instanceof Error ? err.message : String(err)}`, opts);
    return 1;
  }
}

export function printGaps(gaps: SamplingGap[]): void {
  if (gaps.length === 0) return;
  console.log(`\n  debugger session dropped ${gaps.length} time(s) and was re-attached:`);
  for (const g of gaps) {
    console.log(
      `    t+${(g.atMs / 1000).toFixed(1)}s for ${g.durationMs}ms — ` +
        (g.resumed === 'continued'
          ? 'Hermes kept sampling, nothing lost'
          : g.resumed === 'restarted'
            ? 'samples in the gap were lost, sampling restarted'
            : 'the app never came back')
    );
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Internal: hold the CDP socket open for the duration of a start/stop pair.
 * Not part of the public CLI surface.
 *
 * When the socket drops (some tvOS apps drop the debugger session on navigation; an app
 * backgrounding can too), the holder re-attaches to the same logical device and
 * app. Hermes may or may not have kept sampling through the drop; asking it to
 * stop first recovers the samples when it did, and either way a new segment
 * starts. The runtime itself is the same, so commit data held in JS survives.
 */
export async function profileJsHold(
  sessionName: string,
  jsOpts: ProfileJsOptions
): Promise<number> {
  const p = paths(sessionName);
  await fs.mkdir(stateDir(), { recursive: true });
  const out = jsOpts.out ?? defaultOut();
  let client: MetroCdpClient | undefined;
  let pin: PinnedTarget | undefined;
  const startedAtHostMs = Date.now();
  let startedAtRuntimeMs: number | undefined;

  try {
    client = await connectMetro(sessionName, jsOpts);
    const t = client.target;
    pin = {
      port: Number(new URL(t?.webSocketDebuggerUrl ?? 'ws://localhost:8081').port) || 8081,
      pageId: t?.id,
      appId: t ? targetAppId(t) : undefined,
      logicalDeviceId: t?.reactNative?.logicalDeviceId,
      deviceName: t?.deviceName,
      title: t?.title,
    };
    if (jsOpts.port !== undefined) pin.port = jsOpts.port;
    await startSampling(client);
    startedAtRuntimeMs = await client
      .evaluate<number>('Date.now()')
      .then((v) => (typeof v === 'number' ? v : undefined))
      .catch(() => undefined);
    await fs.writeFile(
      p.state,
      JSON.stringify(
        {
          pid: process.pid,
          session: sessionName,
          out,
          startedAt: new Date(startedAtHostMs).toISOString(),
          startedAtHostMs,
          startedAtRuntimeMs,
          target: pin,
        },
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

  const stopRequested = (): Promise<boolean> =>
    fs
      .stat(p.stop)
      .then(() => true)
      .catch(() => false);

  const reconnect = async (budgetMs: number): Promise<MetroCdpClient | undefined> => {
    const until = Date.now() + budgetMs;
    while (Date.now() < until) {
      try {
        return await connectMetro(sessionName, {
          port: pin!.port,
          appId: pin!.appId,
          logicalDeviceId: pin!.logicalDeviceId,
        });
      } catch {
        await sleep(500);
      }
    }
    return undefined;
  };

  const segments: CpuProfile[] = [];
  const gaps: SamplingGap[] = [];
  // Safety valve: never hold a debugger session open indefinitely.
  const deadline = Date.now() + 15 * 60_000;
  let stopped = false;
  let lost = false;
  while (Date.now() < deadline) {
    if (await stopRequested()) {
      stopped = true;
      break;
    }
    if (!client.isConnected()) {
      const dropAt = Date.now();
      client.close();
      // Keep trying until the app is back or stop is requested (then a short final try).
      let next: MetroCdpClient | undefined;
      while (!next && Date.now() < deadline) {
        next = await reconnect((await stopRequested()) ? 5_000 : 2_000);
        if (!next && (await stopRequested())) break;
      }
      if (!next) {
        gaps.push({
          atMs: dropAt - startedAtHostMs,
          durationMs: Date.now() - dropAt,
          resumed: 'lost',
        });
        lost = true;
        break;
      }
      client = next;
      let resumed: SamplingGap['resumed'] = 'restarted';
      try {
        const prof = await stopSampling(client);
        if ((prof.samples?.length ?? 0) > 0) {
          segments.push(prof);
          resumed = 'continued';
        }
      } catch {
        // Sampler did not survive the drop.
      }
      try {
        await startSampling(client);
      } catch {
        lost = true;
      }
      gaps.push({ atMs: dropAt - startedAtHostMs, durationMs: Date.now() - dropAt, resumed });
      if (lost) break;
      continue;
    }
    await sleep(200);
  }

  try {
    if (!lost && client.isConnected()) segments.push(await stopSampling(client));
    if (segments.length === 0) throw new Error('the app disconnected from Metro while sampling');
    const files: string[] = [];
    if (segments.length === 1) {
      await writeProfile(out, segments[0]);
      files.push(out);
    } else {
      for (let i = 0; i < segments.length; i++) {
        const f = out.replace(/(\.cpuprofile)?$/, `.seg${i}.cpuprofile`);
        await writeProfile(f, segments[i]);
        files.push(f);
      }
      await writeProfile(out, mergeCpuProfiles(segments));
    }
    const done: HolderDone = {
      out,
      segments: files,
      gaps,
      stoppedByRequest: stopped,
      startedAtHostMs,
      startedAtRuntimeMs,
      target: pin,
    };
    if (lost) done.error = 'the app disconnected from Metro and did not come back';
    await fs.writeFile(p.done, JSON.stringify(done));
    return 0;
  } catch (err) {
    await fs.writeFile(
      p.done,
      JSON.stringify({ error: err instanceof Error ? err.message : String(err), gaps })
    );
    return 1;
  } finally {
    client?.close();
    await fs.rm(p.stop, { force: true });
    await fs.rm(p.state, { force: true });
  }
}

export interface StackSummary {
  /** Caller chain from the matched function outward (innermost first). */
  frames: string[];
  ms: number;
  samples: number;
}

/**
 * Where a function is called from: for every sample whose stack contains a
 * frame matching `pattern`, the chain from that frame out to `depth` callers.
 */
export function stacksFor(
  profiles: CpuProfile[],
  pattern: RegExp,
  depth = 6,
  top = 5,
  label: (frame: CallFrame) => string = frameKey
): StackSummary[] {
  const byKey = new Map<string, StackSummary>();
  for (const profile of profiles) {
    const byId = new Map<number, ProfileNode>(profile.nodes.map((n) => [n.id, n]));
    const parentOf = new Map<number, number>();
    for (const n of profile.nodes) for (const c of n.children ?? []) parentOf.set(c, n.id);
    const samples = profile.samples ?? [];
    const deltas = profile.timeDeltas ?? [];
    for (let i = 0; i < samples.length; i++) {
      let cursor: number | undefined = samples[i];
      while (
        cursor !== undefined &&
        !pattern.test(byId.get(cursor)?.callFrame.functionName ?? '')
      ) {
        cursor = parentOf.get(cursor);
      }
      if (cursor === undefined) continue;
      const frames: string[] = [];
      while (cursor !== undefined && frames.length < depth) {
        const n = byId.get(cursor);
        if (!n || n.callFrame.functionName === '[root]' || n.callFrame.functionName === '(root)')
          break;
        frames.push(label(n.callFrame));
        cursor = parentOf.get(cursor);
      }
      const key = frames.join(' ← ');
      const slot = byKey.get(key) ?? { frames, ms: 0, samples: 0 };
      slot.ms += (deltas[i] ?? 0) / 1000;
      slot.samples++;
      byKey.set(key, slot);
    }
  }
  return [...byKey.values()]
    .sort((a, b) => b.ms - a.ms)
    .slice(0, top)
    .map((s) => ({ ...s, ms: round(s.ms) }));
}
