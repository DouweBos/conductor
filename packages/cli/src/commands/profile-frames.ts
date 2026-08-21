import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { printError, printData, printSuccess, OutputOptions } from '../output.js';
import { detectPlatform } from '../drivers/bootstrap.js';
import {
  adbShell,
  resolveAndroidForegroundApp,
  shellBracketed,
  buildClockAnchor,
  toDeviceRealtimeMs,
  ClockAnchor,
} from '../android/device.js';
import { describe, percentile, round, fmt, Distribution, hasSamples } from '../stats.js';

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * A machine-actionable caveat.
 *
 * Prose in a `string[]` can only be acted on by string-matching the wording,
 * which breaks the moment the wording changes. A `code` plus whatever fields
 * the caller needs to respond (re-run at a different interval, discard the
 * per-frame stats, fall back to another measurement) can be branched on.
 */
export interface Note {
  code:
    | 'poll-gap'
    | 'buffer-window-only'
    | 'no-input-timestamps'
    | 'no-clock-anchor'
    | 'baseline-saved'
    | 'single-window'
    | 'no-frames';
  message: string;
  /** Fraction of the window's frames that survived into the per-frame stats. */
  coveragePercent?: number;
  /** A `--interval` that would likely have achieved full coverage. */
  suggestedIntervalMs?: number;
}

/** Cumulative counters from the `dumpsys gfxinfo` summary block. */
export interface GfxinfoSummary {
  pid?: number;
  packageName?: string;
  totalFrames?: number;
  jankyFrames?: number;
  jankyPercent?: number;
  /** Percentiles as reported by the platform (integer ms, coarse). */
  platformP50Ms?: number;
  platformP90Ms?: number;
  platformP95Ms?: number;
  platformP99Ms?: number;
  missedVsync?: number;
  highInputLatency?: number;
  slowUiThread?: number;
  slowBitmapUploads?: number;
  slowDrawCommands?: number;
  frameDeadlineMissed?: number;
}

export interface HistogramBucket {
  ms: number;
  count: number;
}

/** One row of the `---PROFILEDATA---` CSV, in nanoseconds, keyed by column name. */
export type FramestatsRow = Record<string, number>;

export interface FramePhases {
  /** IntendedVsync → Vsync. Large values mean the UI thread missed its wake-up. */
  vsyncDelayMs: number;
  /** HandleInputStart → AnimationStart. */
  inputMs: number;
  /** AnimationStart → PerformTraversalsStart. */
  animationMs: number;
  /** PerformTraversalsStart → DrawStart (measure + layout). */
  traversalMs: number;
  /** DrawStart → SyncQueued (display-list recording). */
  drawMs: number;
  /** SyncStart → IssueDrawCommandsStart (upload to the render thread). */
  syncMs: number;
  /** IssueDrawCommandsStart → SwapBuffers (render-thread GPU command issue). */
  issueDrawMs: number;
  /** SwapBuffers → FrameCompleted. */
  swapMs: number;
}

export interface FrameSample extends FramePhases {
  /** IntendedVsync in ns — doubles as the frame's identity when de-duplicating. */
  vsyncNs: number;
  /** FrameCompleted in ns (CLOCK_MONOTONIC). */
  completedNs: number;
  /** IntendedVsync → FrameCompleted: what the user actually waited for. */
  totalMs: number;
  /**
   * NewestInputEvent → FrameCompleted, or null when the frame carried no input
   * timestamp. Many devices never populate this — see the `no-input-timestamps`
   * note rather than reading absence as "no input happened".
   */
  inputLatencyMs: number | null;
  /** Frame completion in the app's `Date.now()` domain, when a clock anchor exists. */
  atDeviceRealtimeMs?: number;
}

const PHASE_HINTS: Record<keyof FramePhases, string> = {
  vsyncDelayMs: 'UI thread missed its wake-up — blocked elsewhere (on RN, usually JS)',
  inputMs: 'input handling in the app',
  animationMs: 'animation callbacks / Choreographer work',
  traversalMs: 'measure/layout — deep view trees, expensive onLayout',
  drawMs: 'display-list recording — overdraw, shadows, complex clipping',
  syncMs: 'sync to the render thread — often large texture uploads',
  issueDrawMs: 'render-thread GPU command issue',
  swapMs: 'buffer queue / display back-pressure, not app work',
};

/**
 * Which phase to look at first, computed rather than left to the reader.
 *
 * The routing rule that matters is in the docs, but a consumer handed only the
 * JSON has the numbers and not the meaning — so the routing travels with the
 * numbers. The raw per-phase figures are still reported; this is a starting
 * point to disagree with, not a verdict.
 */
export interface PhaseAttribution {
  /** Largest p95 — what drives the worst frames. */
  dominantPhase: keyof FramePhases;
  /**
   * Largest p50 — what every frame pays. When this differs from
   * `dominantPhase` the two tell different stories: one is an intermittent
   * spike, the other a systematic cost, and both are worth fixing separately.
   */
  steadyPhase: keyof FramePhases;
  /**
   * How much worse the tail is than the median for `dominantPhase`. `null`
   * when its p50 is 0, which means the phase is purely intermittent — see
   * `intermittent`.
   */
  p95OverP50: number | null;
  /** `dominantPhase` costs nothing on a typical frame and spikes on bad ones. */
  intermittent: boolean;
  /** That phase's p95 as a fraction of the whole frame's p95. */
  shareOfFrameP95: number | null;
  hint: string;
  steadyHint: string;
}

export interface FramesStats {
  distribution: Distribution;
  over16ms: number;
  over33ms: number;
  over50ms: number;
  /** p50 of each phase across every sampled frame — where the time goes. */
  phaseP50Ms: FramePhases;
  /** p95 of each phase. A phase whose p95 dwarfs its p50 is the jank source. */
  phaseP95Ms: FramePhases;
  attribution: PhaseAttribution | null;
  inputLatency?: Distribution;
  worst: FrameSample[];
}

/** One `--track` window, reduced to the figures worth comparing across runs. */
export interface WindowSummary {
  index: number;
  windowMs: number;
  totalFrames: number | null;
  jankyFrames: number | null;
  jankyPercent: number | null;
  p50Ms: number | null;
  p90Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  over16ms: number | null;
}

export interface FramesReport {
  platform: string;
  deviceId: string;
  appId: string;
  capturedAt: string;
  /** Wall-clock length of the tracked window, when --track was used. */
  windowMs?: number;
  summary: GfxinfoSummary;
  histogram: HistogramBucket[];
  frames?: FramesStats;
  /** Present with --repeat: one entry per window, for run-to-run variance. */
  windows?: WindowSummary[];
  /**
   * Spread of each `WindowSummary` key across windows. A baseline carrying this
   * lets `--diff` say whether a delta is bigger than the run-to-run noise.
   */
  variance?: Record<string, Distribution>;
  clockAnchor?: ClockAnchor;
  notes: Note[];
}

// ── Parsing ───────────────────────────────────────────────────────────────────

function num(out: string, re: RegExp): number | undefined {
  const m = out.match(re);
  return m ? Number(m[1]) : undefined;
}

export function parseGfxinfoSummary(out: string): GfxinfoSummary {
  const header = out.match(/\*\* Graphics info for pid (\d+) \[([^\]]+)\]/);
  const janky = out.match(/Janky frames:\s*(\d+)\s*\(([\d.]+)%\)/);
  const totalFrames = num(out, /Total frames rendered:\s*(\d+)/);
  // With nothing drawn the platform still prints percentiles, filled from the
  // top histogram bucket — "p99 4950ms" for a window in which no frame existed.
  // A percentile over zero frames is not a slow frame, it is no frame, and it
  // must not be representable as a value.
  const drew = totalFrames !== undefined && totalFrames > 0;
  const pctile = (re: RegExp): number | undefined => (drew ? num(out, re) : undefined);
  // The GPU block repeats these labels as "50th gpu percentile", so matching the
  // exact phrase keeps us on the UI-thread figures.
  return {
    pid: header ? Number(header[1]) : undefined,
    packageName: header ? header[2] : undefined,
    totalFrames,
    jankyFrames: janky ? Number(janky[1]) : undefined,
    jankyPercent: drew && janky ? Number(janky[2]) : undefined,
    platformP50Ms: pctile(/50th percentile:\s*(\d+)ms/),
    platformP90Ms: pctile(/90th percentile:\s*(\d+)ms/),
    platformP95Ms: pctile(/95th percentile:\s*(\d+)ms/),
    platformP99Ms: pctile(/99th percentile:\s*(\d+)ms/),
    missedVsync: num(out, /Number Missed Vsync:\s*(\d+)/),
    highInputLatency: num(out, /Number High input latency:\s*(\d+)/),
    slowUiThread: num(out, /Number Slow UI thread:\s*(\d+)/),
    slowBitmapUploads: num(out, /Number Slow bitmap uploads:\s*(\d+)/),
    slowDrawCommands: num(out, /Number Slow issue draw commands:\s*(\d+)/),
    frameDeadlineMissed: num(out, /Number Frame deadline missed:\s*(\d+)/),
  };
}

/**
 * `Uptime: <ms>` from the dumpsys header. This is CLOCK_MONOTONIC, the same
 * domain as the framestats vsync timestamps, and it is contemporaneous with the
 * dump — so it anchors the frames without costing an extra round trip.
 */
export function parseGfxinfoUptimeMs(out: string): number | undefined {
  return num(out, /^Uptime:\s*(\d+)/m);
}

/** `HISTOGRAM: 5ms=1 6ms=0 ...` — the UI-thread histogram, not the GPU one. */
export function parseGfxinfoHistogram(out: string): HistogramBucket[] {
  const line = out.match(/^HISTOGRAM:\s*(.+)$/m);
  if (!line) return [];
  const buckets: HistogramBucket[] = [];
  for (const [, ms, count] of line[1].matchAll(/(\d+)ms=(\d+)/g)) {
    buckets.push({ ms: Number(ms), count: Number(count) });
  }
  return buckets;
}

/**
 * Rows from every `---PROFILEDATA---` block, keyed by the block's own header so
 * we survive the column set changing between Android versions.
 */
export function parseFramestats(out: string): FramestatsRow[] {
  const rows: FramestatsRow[] = [];
  for (const [, body] of out.matchAll(/---PROFILEDATA---\r?\n([\s\S]*?)---PROFILEDATA---/g)) {
    const lines = body.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length < 2) continue;
    const columns = lines[0]
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);
    if (!columns.includes('IntendedVsync')) continue;
    for (const line of lines.slice(1)) {
      const cells = line.split(',');
      if (cells.length < columns.length) continue;
      const row: FramestatsRow = {};
      columns.forEach((col, i) => {
        row[col] = Number(cells[i]);
      });
      if (Number.isFinite(row.IntendedVsync)) rows.push(row);
    }
  }
  return rows;
}

const NS_PER_MS = 1e6;
/** Devices write INT64_MAX into input-event columns that were never filled in. */
const UNSET_SENTINEL = 9.2e18;

function span(row: FramestatsRow, from: string, to: string): number {
  const a = row[from];
  const b = row[to];
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0 || b === 0 || b < a) return 0;
  if (a >= UNSET_SENTINEL || b >= UNSET_SENTINEL) return 0;
  return round((b - a) / NS_PER_MS);
}

/**
 * A row is usable when Flags is 0 — a non-zero Flags marks a frame the platform
 * itself says not to measure (first draw after a window change, etc.). Real
 * captures do contain such rows, so this filter is load-bearing.
 */
export function toFrameSample(row: FramestatsRow, anchor?: ClockAnchor): FrameSample | null {
  if (row.Flags !== 0) return null;
  const start = row.IntendedVsync;
  const end = row.FrameCompleted;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const totalMs = round((end - start) / NS_PER_MS);
  // Frames idle for a long time show absurd deltas; treat >10s as a bad row.
  if (totalMs > 10_000) return null;
  const newestInput = row.NewestInputEvent;
  const hasInput =
    Number.isFinite(newestInput) &&
    newestInput > 0 &&
    newestInput < UNSET_SENTINEL &&
    end > newestInput;
  return {
    vsyncNs: start,
    completedNs: end,
    totalMs,
    inputLatencyMs: hasInput ? round((end - newestInput) / NS_PER_MS) : null,
    atDeviceRealtimeMs: anchor ? round(toDeviceRealtimeMs(anchor, end)) : undefined,
    vsyncDelayMs: span(row, 'IntendedVsync', 'Vsync'),
    inputMs: span(row, 'HandleInputStart', 'AnimationStart'),
    animationMs: span(row, 'AnimationStart', 'PerformTraversalsStart'),
    traversalMs: span(row, 'PerformTraversalsStart', 'DrawStart'),
    drawMs: span(row, 'DrawStart', 'SyncQueued'),
    syncMs: span(row, 'SyncStart', 'IssueDrawCommandsStart'),
    issueDrawMs: span(row, 'IssueDrawCommandsStart', 'SwapBuffers'),
    swapMs: span(row, 'SwapBuffers', 'FrameCompleted'),
  };
}

export const PHASE_KEYS: Array<keyof FramePhases> = [
  'vsyncDelayMs',
  'inputMs',
  'animationMs',
  'traversalMs',
  'drawMs',
  'syncMs',
  'issueDrawMs',
  'swapMs',
];

function phasePercentile(frames: FrameSample[], p: number): FramePhases {
  const out = {} as FramePhases;
  for (const key of PHASE_KEYS) {
    const sorted = frames.map((f) => f[key]).sort((a, b) => a - b);
    out[key] = round(percentile(sorted, p) ?? 0);
  }
  return out;
}

function attribute(
  p50: FramePhases,
  p95: FramePhases,
  frameP95: number | null
): PhaseAttribution | null {
  let dominant: keyof FramePhases | null = null;
  let steady: keyof FramePhases | null = null;
  for (const key of PHASE_KEYS) {
    if (dominant === null || p95[key] > p95[dominant]) dominant = key;
    if (steady === null || p50[key] > p50[steady]) steady = key;
  }
  if (dominant === null || steady === null || p95[dominant] <= 0) return null;
  return {
    dominantPhase: dominant,
    steadyPhase: steady,
    p95OverP50: p50[dominant] > 0 ? round(p95[dominant] / p50[dominant]) : null,
    intermittent: p50[dominant] <= 0,
    shareOfFrameP95: frameP95 && frameP95 > 0 ? round(p95[dominant] / frameP95, 3) : null,
    hint: PHASE_HINTS[dominant],
    steadyHint: PHASE_HINTS[steady],
  };
}

export function summariseFrames(frames: FrameSample[], top: number): FramesStats | undefined {
  if (frames.length === 0) return undefined;
  const totals = frames.map((f) => f.totalMs);
  const distribution = describe(totals);
  const inputLatencies = frames.map((f) => f.inputLatencyMs).filter((v): v is number => v !== null);
  const phaseP50Ms = phasePercentile(frames, 50);
  const phaseP95Ms = phasePercentile(frames, 95);
  return {
    distribution,
    over16ms: totals.filter((t) => t > 16.67).length,
    over33ms: totals.filter((t) => t > 33.33).length,
    over50ms: totals.filter((t) => t > 50).length,
    phaseP50Ms,
    phaseP95Ms,
    attribution: attribute(phaseP50Ms, phaseP95Ms, distribution.p95Ms),
    inputLatency: inputLatencies.length > 0 ? describe(inputLatencies) : undefined,
    worst: [...frames].sort((a, b) => b.totalMs - a.totalMs).slice(0, top),
  };
}

// ── Collection ────────────────────────────────────────────────────────────────

async function readGfxinfo(deviceId: string, appId: string): Promise<string> {
  const res = await adbShell(deviceId, ['dumpsys', 'gfxinfo', appId, 'framestats']);
  if (!res.success) throw new Error(res.stderr.trim() || 'adb shell dumpsys gfxinfo failed');
  return res.stdout;
}

/**
 * Read the frames and the clock anchor in one adb invocation, so the anchor is
 * contemporaneous with the frames by construction and its error is the
 * on-device dumpsys duration rather than the network round trip.
 */
async function readGfxinfoAnchored(
  deviceId: string,
  appId: string
): Promise<{ dump: string; anchor?: ClockAnchor }> {
  const bracket = await shellBracketed(deviceId, `dumpsys gfxinfo ${appId} framestats`);
  if (!bracket) return { dump: await readGfxinfo(deviceId, appId) };
  const monotonicMs = parseGfxinfoUptimeMs(bracket.stdout);
  return {
    dump: bracket.stdout,
    anchor: monotonicMs === undefined ? undefined : buildClockAnchor(bracket, monotonicMs),
  };
}

export async function resetFrameCounters(deviceId: string, appId: string): Promise<void> {
  const res = await adbShell(deviceId, ['dumpsys', 'gfxinfo', appId, 'reset']);
  if (!res.success) throw new Error(res.stderr.trim() || 'adb shell dumpsys gfxinfo reset failed');
}

interface TrackResult {
  rows: FramestatsRow[];
  lastDump: string;
  polls: number;
  /** Polls that came back with a full buffer, i.e. frames may have been evicted. */
  fullBufferPolls: number;
  slowPolls: number;
}

/**
 * Poll framestats for `durationMs`, de-duplicating frames by IntendedVsync.
 *
 * The on-device PROFILEDATA ring buffer holds ~120 frames (about 2s at 60fps),
 * so a single read at the end of a long window would only show the tail.
 * Polling and merging keeps the whole window — at the cost of one dumpsys per
 * interval, which over networked adb is itself a few hundred ms.
 */
async function trackFrames(
  deviceId: string,
  appId: string,
  durationMs: number,
  intervalMs: number
): Promise<TrackResult> {
  const byVsync = new Map<number, FramestatsRow>();
  const end = Date.now() + durationMs;
  let lastDump = '';
  let polls = 0;
  let fullBufferPolls = 0;
  let slowPolls = 0;

  while (Date.now() < end) {
    const wait = Math.min(intervalMs, Math.max(0, end - Date.now()));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const readStart = Date.now();
    lastDump = await readGfxinfo(deviceId, appId);
    polls++;
    const rows = parseFramestats(lastDump);
    if (rows.length >= 120) fullBufferPolls++;
    if (Date.now() - readStart > intervalMs) slowPolls++;
    for (const row of rows) byVsync.set(row.IntendedVsync, row);
  }

  if (!lastDump) {
    lastDump = await readGfxinfo(deviceId, appId);
    polls++;
    for (const row of parseFramestats(lastDump)) byVsync.set(row.IntendedVsync, row);
  }
  return { rows: [...byVsync.values()], lastDump, polls, fullBufferPolls, slowPolls };
}

// ── Baselines ─────────────────────────────────────────────────────────────────

function baselinesDir(): string {
  return path.join(os.homedir(), '.conductor', 'frame-baselines');
}

function baselinePath(name: string): string {
  if (name.endsWith('.json') || name.includes('/')) return name;
  return path.join(baselinesDir(), `${name}.json`);
}

async function saveBaseline(name: string, report: FramesReport): Promise<string> {
  await fs.mkdir(baselinesDir(), { recursive: true });
  const file = baselinePath(name);
  await fs.writeFile(file, JSON.stringify(report, null, 2));
  return file;
}

async function loadBaseline(name: string): Promise<FramesReport> {
  return JSON.parse(await fs.readFile(baselinePath(name), 'utf8')) as FramesReport;
}

async function listBaselines(): Promise<
  Array<{ name: string; capturedAt?: string; appId?: string; windows?: number }>
> {
  let files: string[];
  try {
    files = await fs.readdir(baselinesDir());
  } catch {
    return [];
  }
  const out: Array<{ name: string; capturedAt?: string; appId?: string; windows?: number }> = [];
  for (const f of files.filter((n) => n.endsWith('.json'))) {
    try {
      const r = JSON.parse(await fs.readFile(path.join(baselinesDir(), f), 'utf8')) as FramesReport;
      out.push({
        name: f.replace(/\.json$/, ''),
        capturedAt: r.capturedAt,
        appId: r.appId,
        windows: r.windows?.length,
      });
    } catch {
      /* skip malformed */
    }
  }
  return out.sort((a, b) => (a.capturedAt ?? '').localeCompare(b.capturedAt ?? ''));
}

/** Which direction is an improvement for each diffed key. */
const POLARITY: Record<string, 'lower' | 'higher' | 'neutral'> = {
  jankyPercent: 'lower',
  jankyFrames: 'lower',
  // More frames drawn in the same window means fewer were dropped.
  totalFrames: 'higher',
  missedVsync: 'lower',
  slowUiThread: 'lower',
  slowDrawCommands: 'lower',
  p50Ms: 'lower',
  p90Ms: 'lower',
  p95Ms: 'lower',
  p99Ms: 'lower',
  maxMs: 'lower',
  over16ms: 'lower',
  over33ms: 'lower',
};

export interface FramesDiffRow {
  key: string;
  before: number | null;
  after: number | null;
  delta: number | null;
  better: 'lower' | 'higher' | 'neutral';
  verdict: 'regression' | 'improvement' | 'neutral' | 'unknown';
  /**
   * Whether the delta exceeds the baseline's own run-to-run spread. `null` when
   * the baseline has no variance data — capture it with `--repeat`.
   */
  significant: boolean | null;
  /** The baseline's stddev for this key, when known. */
  baselineStddev?: number | null;
}

function diffKeys(r: FramesReport): Record<string, number | null> {
  return {
    jankyPercent: r.summary.jankyPercent ?? null,
    totalFrames: r.summary.totalFrames ?? null,
    jankyFrames: r.summary.jankyFrames ?? null,
    missedVsync: r.summary.missedVsync ?? null,
    slowUiThread: r.summary.slowUiThread ?? null,
    slowDrawCommands: r.summary.slowDrawCommands ?? null,
    p50Ms: r.frames?.distribution.p50Ms ?? null,
    p90Ms: r.frames?.distribution.p90Ms ?? null,
    p95Ms: r.frames?.distribution.p95Ms ?? null,
    p99Ms: r.frames?.distribution.p99Ms ?? null,
    maxMs: r.frames?.distribution.maxMs ?? null,
    over16ms: r.frames?.over16ms ?? null,
    over33ms: r.frames?.over33ms ?? null,
  };
}

export function buildFramesDiff(before: FramesReport, after: FramesReport): FramesDiffRow[] {
  const a = diffKeys(before);
  const b = diffKeys(after);
  return Object.keys(a).map((key) => {
    const beforeV = a[key];
    const afterV = b[key];
    const delta = beforeV !== null && afterV !== null ? round(afterV - beforeV) : null;
    const better = POLARITY[key] ?? 'neutral';
    const stddev = before.variance?.[key]?.stddevMs ?? null;
    // Two standard deviations of the baseline's own window-to-window spread.
    const significant = delta === null || stddev === null ? null : Math.abs(delta) > 2 * stddev;

    let verdict: FramesDiffRow['verdict'] = 'unknown';
    if (delta !== null) {
      if (better === 'neutral' || delta === 0 || significant === false) verdict = 'neutral';
      else if (better === 'lower') verdict = delta < 0 ? 'improvement' : 'regression';
      else verdict = delta > 0 ? 'improvement' : 'regression';
    }

    return {
      key,
      before: beforeV,
      after: afterV,
      delta,
      better,
      verdict,
      significant,
      baselineStddev: stddev,
    };
  });
}

/** Spread of each window-summary key across the captured windows. */
export function windowVariance(windows: WindowSummary[]): Record<string, Distribution> {
  const keys: Array<keyof WindowSummary> = [
    'totalFrames',
    'jankyFrames',
    'jankyPercent',
    'p50Ms',
    'p90Ms',
    'p95Ms',
    'p99Ms',
    'over16ms',
  ];
  const out: Record<string, Distribution> = {};
  for (const key of keys) {
    const values = windows.map((w) => w[key]).filter((v): v is number => typeof v === 'number');
    out[key] = describe(values);
  }
  return out;
}

// ── Command ───────────────────────────────────────────────────────────────────

export interface ProfileFramesOptions {
  appId?: string;
  trackSec?: number;
  intervalMs?: number;
  top?: number;
  repeat?: number;
  saveBaseline?: string;
  diff?: string;
  listBaselines?: boolean;
}

/**
 * gfxinfo lives in Android's HWUI, so it covers real Fire TV / Android TV
 * hardware over adb but not the Vega VVD, which is not Android.
 */
async function requireAndroid(
  opts: OutputOptions,
  sessionName: string
): Promise<{ deviceId: string; platform: string } | null> {
  if (sessionName === 'default') {
    const { detectFirstDevice } = await import('../runner.js');
    const detected = await detectFirstDevice().catch(() => undefined);
    if (!detected) {
      printError('profile frames requires a --device', opts);
      return null;
    }
    sessionName = detected;
  }
  const platform = await detectPlatform(sessionName).catch(() => 'unknown');
  if (platform !== 'android') {
    printError(
      `profile frames needs Android's dumpsys gfxinfo — not available on platform ${platform}.` +
        (platform === 'vega'
          ? '\nA physical Fire TV Stick runs Fire OS (Android) and is reachable over adb, which does work;' +
            ' only the Vega VVD does not.'
          : ''),
      opts
    );
    return null;
  }

  // Check the device answers before blaming a missing app for an adb failure.
  const probe = await adbShell(sessionName, ['true']);
  if (!probe.success) {
    printError(
      `profile frames — adb cannot reach ${sessionName}: ${probe.stderr.trim() || 'no response'}`,
      opts
    );
    return null;
  }

  return { deviceId: sessionName, platform };
}

export async function profileFramesReset(
  opts: OutputOptions,
  sessionName: string,
  appIdArg?: string
): Promise<number> {
  const target = await requireAndroid(opts, sessionName);
  if (!target) return 1;
  try {
    const appId = appIdArg ?? (await resolveAndroidForegroundApp(target.deviceId));
    if (!appId) {
      printError('profile frames reset — could not resolve the foreground app; pass <appId>', opts);
      return 1;
    }
    await resetFrameCounters(target.deviceId, appId);
    if (opts.json) printData({ status: 'ok', appId, reset: true }, opts);
    else printSuccess(`profile frames reset — counters zeroed for ${appId}`, opts);
    return 0;
  } catch (err) {
    printError(`profile frames reset — ${err instanceof Error ? err.message : String(err)}`, opts);
    return 1;
  }
}

function toWindowSummary(
  index: number,
  windowMs: number,
  summary: GfxinfoSummary,
  stats: FramesStats | undefined
): WindowSummary {
  return {
    index,
    windowMs,
    totalFrames: summary.totalFrames ?? null,
    jankyFrames: summary.jankyFrames ?? null,
    jankyPercent: summary.jankyPercent ?? null,
    p50Ms: stats?.distribution.p50Ms ?? null,
    p90Ms: stats?.distribution.p90Ms ?? null,
    p95Ms: stats?.distribution.p95Ms ?? null,
    p99Ms: stats?.distribution.p99Ms ?? null,
    over16ms: stats?.over16ms ?? null,
  };
}

export async function profileFramesReport(
  opts: OutputOptions,
  sessionName: string,
  frameOpts: ProfileFramesOptions
): Promise<number> {
  if (frameOpts.listBaselines) {
    const list = await listBaselines();
    if (opts.json) printData({ status: 'ok', baselines: list }, opts);
    else if (list.length === 0) console.log('No baselines saved. Try: --save-baseline <name>');
    else
      for (const b of list) {
        console.log(
          `  ${b.name}  ${b.capturedAt ?? ''}  ${b.appId ?? ''}` +
            (b.windows ? `  (${b.windows} windows)` : '')
        );
      }
    return 0;
  }

  const target = await requireAndroid(opts, sessionName);
  if (!target) return 1;
  const top = frameOpts.top ?? 10;
  // 1000ms measured against the ~120-frame ring buffer, which drains in ~2s at
  // 60fps. One framestats dump costs ~73ms over USB and ~307ms over networked
  // adb, so a 1s interval stays comfortably inside the buffer on both while
  // spending far less of the window dumping than a tighter interval would.
  const intervalMs = frameOpts.intervalMs ?? 1000;
  const repeat = Math.max(1, frameOpts.repeat ?? 1);
  const notes: Note[] = [];

  try {
    const appId = frameOpts.appId ?? (await resolveAndroidForegroundApp(target.deviceId));
    if (!appId) {
      printError(
        'profile frames report — could not resolve the foreground app; pass <appId>',
        opts
      );
      return 1;
    }

    let dump = '';
    let rows: FramestatsRow[] = [];
    let clockAnchor: ClockAnchor | undefined;
    let windowMs: number | undefined;
    const windows: WindowSummary[] = [];
    let track: TrackResult | undefined;

    if (frameOpts.trackSec !== undefined) {
      for (let i = 0; i < repeat; i++) {
        await resetFrameCounters(target.deviceId, appId);
        announceWindow(i, repeat, frameOpts.trackSec, appId);
        const started = Date.now();
        track = await trackFrames(target.deviceId, appId, frameOpts.trackSec * 1000, intervalMs);
        const elapsed = Date.now() - started;
        announceWindowEnd(i, repeat);
        const windowSummary = parseGfxinfoSummary(track.lastDump);
        const windowFrames = track.rows
          .map((r) => toFrameSample(r))
          .filter((f): f is FrameSample => f !== null);
        windows.push(toWindowSummary(i, elapsed, windowSummary, summariseFrames(windowFrames, 1)));
        // The last window is the one reported in detail.
        windowMs = elapsed;
        dump = track.lastDump;
        rows = track.rows;
      }
      // One extra anchored read after the window so frames carry a realtime
      // stamp; the counters it reports are the same ones just captured.
      const anchored = await readGfxinfoAnchored(target.deviceId, appId);
      clockAnchor = anchored.anchor;
    } else {
      const anchored = await readGfxinfoAnchored(target.deviceId, appId);
      dump = anchored.dump;
      clockAnchor = anchored.anchor;
      rows = parseFramestats(dump);
      if (rows.length > 0) {
        notes.push({
          code: 'buffer-window-only',
          message:
            'Per-frame stats cover only the ~120 frames still in the on-device buffer. Use ' +
            '--track <s> for a full window; the summary counters are cumulative since reset.',
        });
      }
    }

    const summary = parseGfxinfoSummary(dump);
    if (summary.totalFrames === undefined) {
      printError(
        `profile frames report — no gfxinfo for ${appId}. Is it running and drawing? ` +
          `(hardware acceleration must be on; WebView-only or SurfaceView-only apps report nothing)`,
        opts
      );
      return 1;
    }

    if (summary.totalFrames === 0) {
      notes.push({
        code: 'no-frames',
        message:
          `${appId} drew no frames in this window, so there is nothing to measure — not ` +
          `smooth, not janky. The app may be idle, backgrounded, or rendering through a ` +
          `SurfaceView/WebView that HWUI does not count. Drive it, or check it is foreground.`,
      });
    }

    if (!clockAnchor) {
      notes.push({
        code: 'no-clock-anchor',
        message:
          'Could not read the device clocks, so frames carry no atDeviceRealtimeMs and cannot ' +
          'be joined to React commit timestamps.',
      });
    }

    const frames = rows
      .map((r) => toFrameSample(r, clockAnchor))
      .filter((f): f is FrameSample => f !== null);
    const stats = summariseFrames(frames, top);

    if (track && summary.totalFrames > 0) {
      // Only actual loss matters. A poll seeing a full buffer is normal on a
      // busy device and means nothing on its own — frames are lost only if the
      // buffer wrapped *between* polls, which is what coverage measures.
      const coverage = frames.length / summary.totalFrames;
      if (coverage < 0.98) {
        // Scale the interval down by the shortfall so the next run's polls land
        // inside one buffer's worth of frames.
        const suggested = Math.max(100, Math.floor(intervalMs * coverage * 0.8));
        notes.push({
          code: 'poll-gap',
          message:
            `Captured ${frames.length} of ${summary.totalFrames} frames the platform counted, ` +
            `so the per-frame stats and percentiles below are over a subset. ` +
            `${track.fullBufferPolls} of ${track.polls} poll(s) saw a full buffer and ` +
            `${track.slowPolls} overran the interval. The summary counters are still exact. ` +
            `Re-run with --interval ${suggested} for full coverage.`,
          coveragePercent: round(coverage * 100, 1),
          suggestedIntervalMs: suggested,
        });
      }
    }

    if (stats && stats.inputLatency === undefined && frames.length > 0) {
      notes.push({
        code: 'no-input-timestamps',
        message:
          'No frame in this capture carried a NewestInputEvent timestamp. Many devices never ' +
          'populate it, so this is not evidence that no input occurred — use ' +
          '`press-key --measure` for input latency instead of inferring it from frames.',
      });
    }

    if (frameOpts.trackSec !== undefined && repeat === 1) {
      notes.push({
        code: 'single-window',
        message:
          'One window carries no run-to-run variance, so nothing here can be called a change. ' +
          'Measured on a Fire TV Stick, five identical captures of the same screen ranged ' +
          '37.8-72.9% janky and 6.2-13.0ms issueDraw p50 — wide enough to invent a regression ' +
          'or hide one. Treat --repeat 5 as the default on TV, not an option.',
      });
    }

    const report: FramesReport = {
      platform: target.platform,
      deviceId: target.deviceId,
      appId,
      capturedAt: new Date().toISOString(),
      windowMs,
      summary,
      histogram: parseGfxinfoHistogram(dump),
      frames: stats,
      windows: windows.length > 1 ? windows : undefined,
      variance: windows.length > 1 ? windowVariance(windows) : undefined,
      clockAnchor,
      notes,
    };

    if (frameOpts.saveBaseline) {
      const file = await saveBaseline(frameOpts.saveBaseline, report);
      notes.push({ code: 'baseline-saved', message: `baseline saved → ${file}` });
    }

    if (frameOpts.diff) {
      const before = await loadBaseline(frameOpts.diff);
      const diff = buildFramesDiff(before, report);
      if (opts.json) {
        printData({ status: 'ok', diff, baseline: frameOpts.diff, current: report }, opts);
      } else {
        printFramesDiff(diff, frameOpts.diff, before.variance !== undefined);
      }
      return 0;
    }

    if (opts.json) printData({ status: 'ok', ...report }, opts);
    else printFramesReport(report);
    return 0;
  } catch (err) {
    printError(`profile frames report — ${err instanceof Error ? err.message : String(err)}`, opts);
    return 1;
  }
}

/**
 * Tell a watching human when the window opens and closes.
 *
 * TV navigation has no momentum — focus moves one step per keypress and stops —
 * so there is no such thing as capturing navigation frames without something
 * driving input. Where that something is a person with the physical remote,
 * they need to know when to start, and they are the only input path with no
 * harness load at all. Goes to stderr so `--json` on stdout stays clean, and
 * only when stderr is a terminal so piped runs stay quiet.
 */
function announceWindow(index: number, repeat: number, sec: number, appId: string): void {
  if (!process.stderr.isTTY) return;
  const which = repeat > 1 ? ` (window ${index + 1}/${repeat})` : '';
  process.stderr.write(`\n▶ measuring ${appId} for ${sec}s${which} — drive the device now\n`);
}

function announceWindowEnd(index: number, repeat: number): void {
  if (!process.stderr.isTTY) return;
  const more = index + 1 < repeat ? ' — next window starts shortly' : '';
  process.stderr.write(`■ window closed${more}\n`);
}

function pct(n: number | undefined): string {
  return n === undefined ? 'n/a' : `${n.toFixed(2)}%`;
}

function printFramesReport(r: FramesReport): void {
  const s = r.summary;
  console.log(
    `profile frames — ${r.appId}${r.windowMs ? ` over ${(r.windowMs / 1000).toFixed(1)}s` : ''}` +
      (r.windows ? ` × ${r.windows.length} windows` : '')
  );
  console.log(`  frames rendered:  ${s.totalFrames ?? 'n/a'}`);
  console.log(`  janky frames:     ${s.jankyFrames ?? 'n/a'} (${pct(s.jankyPercent)})`);
  console.log(
    `  platform pctiles: p50 ${fmt(s.platformP50Ms)}  p90 ${fmt(s.platformP90Ms)}  ` +
      `p95 ${fmt(s.platformP95Ms)}  p99 ${fmt(s.platformP99Ms)}`
  );
  console.log(
    `  counters:         missedVsync=${s.missedVsync ?? 0} slowUiThread=${s.slowUiThread ?? 0} ` +
      `slowDraw=${s.slowDrawCommands ?? 0} slowBitmapUpload=${s.slowBitmapUploads ?? 0} ` +
      `highInputLatency=${s.highInputLatency ?? 0} deadlineMissed=${s.frameDeadlineMissed ?? 0}`
  );

  if (r.frames) {
    const d = r.frames.distribution;
    console.log(`\n  per-frame (${d.count} frames from framestats)`);
    console.log(
      `    p50 ${fmt(d.p50Ms)}  p90 ${fmt(d.p90Ms)}  p95 ${fmt(d.p95Ms)}  ` +
        `p99 ${fmt(d.p99Ms)}  max ${fmt(d.maxMs)}`
    );
    console.log(
      `    >16ms ${r.frames.over16ms}  >33ms ${r.frames.over33ms}  >50ms ${r.frames.over50ms}`
    );

    if (r.frames.attribution) {
      const a = r.frames.attribution;
      const share =
        a.shareOfFrameP95 === null ? '' : `, ${Math.round(a.shareOfFrameP95 * 100)}% of frame p95`;
      console.log(
        `\n  worst frames:     ${a.dominantPhase.replace(/Ms$/, '')} ` +
          (a.intermittent
            ? `(intermittent — 0ms on a typical frame${share})`
            : `(p95 ${a.p95OverP50}× its p50${share})`)
      );
      console.log(`    → ${a.hint}`);
      if (a.steadyPhase !== a.dominantPhase) {
        console.log(
          `  every frame:      ${a.steadyPhase.replace(/Ms$/, '')} ` +
            `(${r.frames.phaseP50Ms[a.steadyPhase]}ms on the median frame)`
        );
        console.log(`    → ${a.steadyHint}`);
      }
    }

    console.log(`\n  phase          p50      p95`);
    for (const key of PHASE_KEYS) {
      console.log(
        `    ${key.replace(/Ms$/, '').padEnd(13)}${String(r.frames.phaseP50Ms[key]).padStart(6)}ms ` +
          `${String(r.frames.phaseP95Ms[key]).padStart(7)}ms`
      );
    }

    if (r.frames.inputLatency) {
      const i = r.frames.inputLatency;
      console.log(
        `\n  input→frame:    p50 ${fmt(i.p50Ms)}  p90 ${fmt(i.p90Ms)}  p99 ${fmt(i.p99Ms)}  ` +
          `(${i.count} frames carried input)`
      );
    }
    if (r.frames.worst.length > 0) {
      console.log(`\n  worst frames`);
      for (const f of r.frames.worst) {
        const at =
          f.atDeviceRealtimeMs !== undefined ? `  at=${Math.round(f.atDeviceRealtimeMs)}` : '';
        console.log(
          `    ${String(f.totalMs).padStart(7)}ms  vsyncDelay=${f.vsyncDelayMs} ` +
            `traversal=${f.traversalMs} draw=${f.drawMs} issueDraw=${f.issueDrawMs} ` +
            `swap=${f.swapMs}${at}`
        );
      }
    }
  }

  if (r.variance) {
    console.log('\n  run-to-run spread across windows');
    for (const [key, d] of Object.entries(r.variance)) {
      if (!hasSamples(d)) continue;
      console.log(
        `    ${key.padEnd(14)} p50 ${d.p50Ms}  min ${d.minMs}  max ${d.maxMs}  σ ${d.stddevMs}`
      );
    }
  }

  if (r.clockAnchor) {
    console.log(
      `\n  clock anchor:    device monotonic ${r.clockAnchor.deviceMonotonicMs}ms ↔ ` +
        `realtime ${Math.round(r.clockAnchor.deviceRealtimeMs)}ms (±${r.clockAnchor.anchorErrorMs}ms)` +
        (r.clockAnchor.clockStepped ? '  [clock stepped mid-read — suspect]' : '')
    );
    console.log(
      "    frame at= values are in the app's Date.now() domain — joinable to React commits."
    );
  }

  for (const note of r.notes) console.log(`\n  note [${note.code}]: ${note.message}`);
}

function printFramesDiff(diff: FramesDiffRow[], baselineName: string, hasVariance: boolean): void {
  console.log(`profile frames diff — ${baselineName} → current`);
  const mark = (row: FramesDiffRow): string => {
    if (row.verdict === 'regression') return 'WORSE';
    if (row.verdict === 'improvement') return 'better';
    if (row.verdict === 'neutral') return '—';
    return '?';
  };
  for (const row of diff) {
    const sign = row.delta === null ? '' : row.delta > 0 ? '+' : '';
    const sig = row.significant === false ? ' (within noise)' : '';
    console.log(
      `  ${row.key.padEnd(16)} ${fmt(row.before, '').padStart(10)} → ${fmt(row.after, '').padStart(10)}  ` +
        `${sign}${fmt(row.delta, '')}  ${mark(row).padEnd(7)}${sig}`
    );
  }
  if (!hasVariance) {
    console.log(
      '\n  note [single-window]: the baseline carries no run-to-run variance, so nothing here ' +
        'can be called significant. Re-capture it with --repeat 5.'
    );
  }
}
