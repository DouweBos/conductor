/**
 * Tests for the profiling parsers and statistics.
 *
 * Everything here is pure: real `dumpsys` / `simpleperf` / logcat / cpuprofile
 * fixtures in, structured reports out. The device-touching layers around them
 * are thin by design so this is where the logic is exercised.
 */
import fs from 'fs';
import path from 'path';
import { TestSuite, assert, runAll } from './runner.js';
import {
  parseGfxinfoSummary,
  parseGfxinfoHistogram,
  parseGfxinfoUptimeMs,
  parseFramestats,
  toFrameSample,
  summariseFrames,
  buildFramesDiff,
  PHASE_KEYS,
  FramesReport,
} from '../src/commands/profile-frames.js';
import {
  parseSimpleperfReport,
  REACT_PROFILER_INSTALL,
  REACT_PROFILER_READ,
  REACT_PROFILER_STOP,
  ReactProfilerReadResult,
} from '../src/commands/profile.js';
import { parseGcEvents, summariseGc } from '../src/commands/profile-gc.js';
import { inferCollections, heapGrowth } from '../src/commands/profile.js';
import { analyzeCpuProfile } from '../src/commands/profile-js.js';
import { describe, percentile, hasSamples } from '../src/stats.js';
import { focusKey } from '../src/commands/focused.js';
import { aggregateRuns } from '../src/commands/run-flow.js';

export const profiling = new TestSuite('profiling');

// ── gfxinfo ───────────────────────────────────────────────────────────────────

const GFXINFO = `Applications Graphics Acceleration Info:
Uptime: 123456 Realtime: 123456

** Graphics info for pid 4242 [com.plexapp.android] **

Stats since: 100000000ns
Total frames rendered: 600
Janky frames: 51 (8.50%)
50th percentile: 6ms
90th percentile: 13ms
95th percentile: 21ms
99th percentile: 47ms
Number Missed Vsync: 3
Number High input latency: 2
Number Slow UI thread: 12
Number Slow bitmap uploads: 1
Number Slow issue draw commands: 5
Number Frame deadline missed: 20
HISTOGRAM: 5ms=100 6ms=50 7ms=0 8ms=3
GPU HISTOGRAM: 5ms=9 6ms=1

---PROFILEDATA---
Flags,IntendedVsync,Vsync,OldestInputEvent,NewestInputEvent,HandleInputStart,AnimationStart,PerformTraversalsStart,DrawStart,SyncQueued,SyncStart,IssueDrawCommandsStart,SwapBuffers,FrameCompleted,DequeueBufferDuration,QueueBufferDuration,GpuCompleted,
0,1000000000,1001000000,999000000,999500000,1001500000,1002000000,1002500000,1004500000,1005000000,1005500000,1006000000,1007000000,1008000000,0,0,1008500000,
0,2000000000,2000500000,0,0,2000600000,2000700000,2000800000,2001800000,2002000000,2002200000,2002400000,2002800000,2003000000,0,0,2003200000,
1,3000000000,3000500000,0,0,3000600000,3000700000,3000800000,3001800000,3002000000,3002200000,3002400000,3002800000,3099000000,0,0,3099200000,
---PROFILEDATA---
`;

profiling.test('parses the gfxinfo summary block', async () => {
  const s = parseGfxinfoSummary(GFXINFO);
  assert(s.pid === 4242, `pid ${s.pid}`);
  assert(s.packageName === 'com.plexapp.android', `pkg ${s.packageName}`);
  assert(s.totalFrames === 600, `totalFrames ${s.totalFrames}`);
  assert(s.jankyFrames === 51, `jankyFrames ${s.jankyFrames}`);
  assert(s.jankyPercent === 8.5, `jankyPercent ${s.jankyPercent}`);
  assert(s.platformP99Ms === 47, `p99 ${s.platformP99Ms}`);
  assert(s.missedVsync === 3, `missedVsync ${s.missedVsync}`);
  assert(s.highInputLatency === 2, `highInputLatency ${s.highInputLatency}`);
  assert(s.slowUiThread === 12, `slowUiThread ${s.slowUiThread}`);
  assert(s.slowBitmapUploads === 1, `slowBitmapUploads ${s.slowBitmapUploads}`);
  assert(s.slowDrawCommands === 5, `slowDrawCommands ${s.slowDrawCommands}`);
  assert(s.frameDeadlineMissed === 20, `frameDeadlineMissed ${s.frameDeadlineMissed}`);
});

profiling.test('reads the UI histogram, not the GPU one', async () => {
  const h = parseGfxinfoHistogram(GFXINFO);
  assert(h.length === 4, `expected 4 buckets, got ${h.length}`);
  assert(h[0].ms === 5 && h[0].count === 100, `first bucket ${JSON.stringify(h[0])}`);
});

profiling.test('parses framestats rows by header name', async () => {
  const rows = parseFramestats(GFXINFO);
  assert(rows.length === 3, `expected 3 rows, got ${rows.length}`);
  assert(rows[0].IntendedVsync === 1000000000, `vsync ${rows[0].IntendedVsync}`);
  assert(rows[0].GpuCompleted === 1008500000, `gpu ${rows[0].GpuCompleted}`);
});

profiling.test('frame duration is IntendedVsync to FrameCompleted', async () => {
  const rows = parseFramestats(GFXINFO);
  const f = toFrameSample(rows[0])!;
  assert(f.totalMs === 8, `totalMs ${f.totalMs}`);
  // NewestInputEvent 999.5ms -> FrameCompleted 1008ms
  assert(f.inputLatencyMs === 8.5, `inputLatencyMs ${f.inputLatencyMs}`);
  assert(f.vsyncDelayMs === 1, `vsyncDelayMs ${f.vsyncDelayMs}`);
  assert(f.traversalMs === 2, `traversalMs ${f.traversalMs}`);
});

profiling.test('drops rows the platform flagged as not measurable', async () => {
  const rows = parseFramestats(GFXINFO);
  assert(toFrameSample(rows[2]) === null, 'Flags=1 row should be dropped');
});

profiling.test('reports no input latency for frames that carried no input', async () => {
  const rows = parseFramestats(GFXINFO);
  const f = toFrameSample(rows[1])!;
  assert(f.inputLatencyMs === null, `expected null, got ${f.inputLatencyMs}`);
});

profiling.test('summarises frames with thresholds and phase percentiles', async () => {
  const frames = parseFramestats(GFXINFO)
    .map((r) => toFrameSample(r))
    .filter((f) => f !== null)
    .map((f) => f!);
  const summary = summariseFrames(frames, 10)!;
  assert(summary.distribution.count === 2, `count ${summary.distribution.count}`);
  assert(summary.over16ms === 0, `over16ms ${summary.over16ms}`);
  assert(summary.worst[0].totalMs === 8, `worst ${summary.worst[0].totalMs}`);
  assert(summary.phaseP50Ms.traversalMs > 0, 'traversal p50 should be non-zero');
  assert(summary.inputLatency?.count === 1, `input latency count ${summary.inputLatency?.count}`);
});

function mkReport(over: { jankyPercent?: number; totalFrames?: number }): FramesReport {
  return {
    platform: 'android',
    deviceId: 'x',
    appId: 'com.example',
    capturedAt: '2026-01-01T00:00:00.000Z',
    summary: { jankyPercent: over.jankyPercent ?? 5, totalFrames: over.totalFrames ?? 100 },
    histogram: [],
    notes: [],
  };
}

profiling.test('diffs a baseline against a later report', async () => {
  const mk = (janky: number, p99: number): FramesReport => ({
    platform: 'android',
    deviceId: 'x',
    appId: 'com.example',
    capturedAt: '2026-01-01T00:00:00.000Z',
    summary: { jankyPercent: janky, totalFrames: 100 },
    histogram: [],
    notes: [],
    frames: {
      distribution: {
        count: 100,
        minMs: 1,
        maxMs: p99,
        meanMs: 5,
        stddevMs: 1,
        p50Ms: 5,
        p90Ms: 10,
        p95Ms: 12,
        p99Ms: p99,
      },
      over16ms: 0,
      over33ms: 0,
      over50ms: 0,
      phaseP50Ms: {
        vsyncDelayMs: 0,
        inputMs: 0,
        animationMs: 0,
        traversalMs: 0,
        drawMs: 0,
        syncMs: 0,
        issueDrawMs: 0,
        swapMs: 0,
      },
      phaseP95Ms: {
        vsyncDelayMs: 0,
        inputMs: 0,
        animationMs: 0,
        traversalMs: 0,
        drawMs: 0,
        syncMs: 0,
        issueDrawMs: 0,
        swapMs: 0,
      },
      attribution: null,
      worst: [],
    },
  });
  const diff = buildFramesDiff(mk(10, 50), mk(4, 30));
  const janky = diff.find((d) => d.key === 'jankyPercent')!;
  assert(janky.delta === -6, `delta ${janky.delta}`);
  assert(janky.better === 'lower', `polarity ${janky.better}`);
  assert(janky.verdict === 'improvement', `verdict ${janky.verdict}`);
  const p99 = diff.find((d) => d.key === 'p99Ms')!;
  assert(p99.delta === -20, `p99 delta ${p99.delta}`);
  // No baseline variance means nothing can be called significant.
  assert(janky.significant === null, `significant ${janky.significant}`);
});

profiling.test('more frames in the same window is an improvement, not a regression', async () => {
  const diff = buildFramesDiff(mkReport({ totalFrames: 100 }), mkReport({ totalFrames: 140 }));
  const row = diff.find((d) => d.key === 'totalFrames')!;
  assert(row.better === 'higher', `polarity ${row.better}`);
  assert(row.verdict === 'improvement', `verdict ${row.verdict} — more frames means fewer dropped`);
});

profiling.test('a delta inside the baseline spread is not called a regression', async () => {
  const before = mkReport({ jankyPercent: 8 });
  before.variance = { jankyPercent: describe([7.5, 8, 8.5, 7.8, 8.2]) };
  const diff = buildFramesDiff(before, mkReport({ jankyPercent: 8.4 }));
  const row = diff.find((d) => d.key === 'jankyPercent')!;
  assert(row.significant === false, `significant ${row.significant}`);
  assert(row.verdict === 'neutral', `verdict ${row.verdict} — inside noise is not a regression`);

  const big = buildFramesDiff(before, mkReport({ jankyPercent: 20 }));
  const bigRow = big.find((d) => d.key === 'jankyPercent')!;
  assert(bigRow.significant === true, `significant ${bigRow.significant}`);
  assert(bigRow.verdict === 'regression', `verdict ${bigRow.verdict}`);
});

profiling.test('attribution names the dominant phase and carries its meaning', async () => {
  const frames = parseFramestats(GFXINFO)
    .map((r) => toFrameSample(r))
    .filter((f) => f !== null)
    .map((f) => f!);
  const a = summariseFrames(frames, 5)!.attribution!;
  assert(PHASE_KEYS.includes(a.dominantPhase), `dominantPhase ${a.dominantPhase}`);
  assert(a.hint.length > 0, 'hint should explain what the phase means');
  assert(
    a.shareOfFrameP95 === null || (a.shareOfFrameP95 > 0 && a.shareOfFrameP95 <= 1),
    `shareOfFrameP95 ${a.shareOfFrameP95}`
  );
});

profiling.test('INT64_MAX in an input column is treated as unset, not as a timestamp', async () => {
  // Real devices write INT64_MAX into input columns they never filled in.
  const row = parseFramestats(GFXINFO)[0];
  const sentinelRow = { ...row, OldestInputEvent: 9223372036854775807, NewestInputEvent: 0 };
  const f = toFrameSample(sentinelRow)!;
  assert(f.inputLatencyMs === null, `inputLatencyMs ${f.inputLatencyMs}`);
});

// ── stats ─────────────────────────────────────────────────────────────────────

profiling.test('percentiles use nearest rank so p99 names a real sample', async () => {
  const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
  assert(percentile(sorted, 50) === 50, `p50 ${percentile(sorted, 50)}`);
  assert(percentile(sorted, 99) === 99, `p99 ${percentile(sorted, 99)}`);
  assert(percentile(sorted, 100) === 100, `p100 ${percentile(sorted, 100)}`);
  assert(percentile([], 50) === null, 'empty input is null, never 0');
});

profiling.test('an empty distribution is null everywhere, never zero', async () => {
  const d = describe([]);
  assert(d.count === 0, `count ${d.count}`);
  for (const key of ['p50Ms', 'p90Ms', 'p95Ms', 'p99Ms', 'minMs', 'maxMs', 'meanMs', 'stddevMs']) {
    const v = (d as unknown as Record<string, number | null>)[key];
    assert(v === null, `${key} is ${v} — a missing measurement must not read as a fast one`);
  }
  assert(!hasSamples(d), 'hasSamples should reject it');
  assert(hasSamples(describe([1])), 'hasSamples should accept a real sample');
});

profiling.test('describe reports dispersion', async () => {
  const d = describe([2, 4, 4, 4, 5, 5, 7, 9]);
  assert(d.meanMs === 5, `mean ${d.meanMs}`);
  assert(d.stddevMs === 2, `stddev ${d.stddevMs}`);
  assert(d.count === 8, `count ${d.count}`);
});

// ── simpleperf ────────────────────────────────────────────────────────────────

const SIMPLEPERF = `Cmdline: /system/bin/simpleperf record -o /data/local/tmp/x.data
Arch: arm64
Event: cpu-clock (type 1, config 0)
Samples: 12345
Event count: 123456789

Overhead  Shared Object                    Symbol
12.34%    /apex/com.android.runtime/lib64/bionic/libc.so   memcpy
 8.10%    /data/app/com.example/lib/arm64/libhermes.so     facebook::hermes::Interpreter::interpret
 0.05%    /system/lib64/libutils.so                        android::Looper::pollInner
`;

profiling.test('parses a simpleperf report table', async () => {
  const entries = parseSimpleperfReport(SIMPLEPERF);
  assert(entries.length === 3, `expected 3 entries, got ${entries.length}`);
  assert(entries[0].percent === 12.34, `percent ${entries[0].percent}`);
  assert(entries[0].symbol === 'memcpy', `symbol ${entries[0].symbol}`);
  assert(
    entries[1].symbol === 'facebook::hermes::Interpreter::interpret',
    `symbol ${entries[1].symbol}`
  );
});

profiling.test('returns nothing when simpleperf printed no table', async () => {
  assert(parseSimpleperfReport('simpleperf: no such file').length === 0, 'expected no entries');
});

// ── GC ────────────────────────────────────────────────────────────────────────

const LOGCAT = `01-01 10:00:00.100  4242  4250 I art     : Background concurrent copying GC freed 123456(12MB) AllocSpace objects, 12(240KB) LOS objects, 49% free, 20MB/40MB, paused 1.234ms total 56.789ms
01-01 10:00:01.100  4242  4250 I art     : Explicit concurrent copying GC freed 1000(1MB) AllocSpace objects, 0(0B) LOS objects, 20% free, 30MB/40MB, paused 260us total 12.5ms
01-01 10:00:02.100  4242  4250 I art     : Alloc concurrent copying GC freed 500(500KB) AllocSpace objects, 1(1MB) LOS objects, 10% free, 35MB/40MB, paused 2.5ms,3.5ms total 40ms
01-01 10:00:03.100  4242  4250 I art     : Starting a blocking GC Alloc
`;

profiling.test('parses ART GC lines including us pauses and pause lists', async () => {
  const events = parseGcEvents(LOGCAT);
  assert(events.length === 3, `expected 3 events, got ${events.length}`);
  assert(events[0].kind === 'Background concurrent copying', `kind "${events[0].kind}"`);
  assert(events[0].pausesMs[0] === 1.234, `pause ${events[0].pausesMs[0]}`);
  assert(events[0].totalMs === 56.789, `total ${events[0].totalMs}`);
  assert(events[1].pausesMs[0] === 0.26, `us pause ${events[1].pausesMs[0]}`);
  assert(events[2].pausesMs.length === 2, `pause list ${JSON.stringify(events[2].pausesMs)}`);
  assert(events[0].heapUsedBytes === 20 * 1024 * 1024, `heapUsed ${events[0].heapUsedBytes}`);
});

profiling.test('summarises GC pause pressure by kind', async () => {
  const gc = summariseGc(parseGcEvents(LOGCAT));
  assert(gc.events === 3, `events ${gc.events}`);
  assert(gc.totalPauseMs === 7.49, `totalPauseMs ${gc.totalPauseMs}`);
  assert(gc.byKind[0].kind === 'Alloc concurrent copying', `worst kind ${gc.byKind[0].kind}`);
});

// ── cpuprofile ────────────────────────────────────────────────────────────────

profiling.test('attributes self and total time from a cpuprofile', async () => {
  // root -> a -> b. Two samples in b, one in a.
  const profile = {
    startTime: 0,
    endTime: 30_000,
    nodes: [
      { id: 1, callFrame: { functionName: '(root)' }, children: [2] },
      { id: 2, callFrame: { functionName: 'a', url: 'http://x/App.js', lineNumber: 9 }, children: [3] },
      { id: 3, callFrame: { functionName: 'b', url: 'http://x/App.js', lineNumber: 19 } },
    ],
    samples: [3, 3, 2],
    timeDeltas: [10_000, 10_000, 10_000],
  };
  const summary = analyzeCpuProfile(profile, 10);
  const b = summary.top.find((f) => f.name === 'b')!;
  const a = summary.top.find((f) => f.name === 'a')!;
  assert(b.selfMs === 20, `b self ${b.selfMs}`);
  assert(b.location === 'App.js:20', `b location ${b.location}`);
  assert(a.selfMs === 10, `a self ${a.selfMs}`);
  // a is on the stack for all three samples, so its total is the whole 30ms.
  assert(a.totalMs === 30, `a total ${a.totalMs}`);
  assert(summary.sampleCount === 3, `samples ${summary.sampleCount}`);
  assert(summary.medianSampleIntervalMs === 10, `interval ${summary.medianSampleIntervalMs}`);
});

profiling.test('counts a recursive function once per sample', async () => {
  const profile = {
    startTime: 0,
    endTime: 10_000,
    nodes: [
      { id: 1, callFrame: { functionName: 'rec', url: 'x.js', lineNumber: 0 }, children: [2] },
      { id: 2, callFrame: { functionName: 'rec', url: 'x.js', lineNumber: 0 } },
    ],
    samples: [2],
    timeDeltas: [10_000],
  };
  const summary = analyzeCpuProfile(profile, 10);
  assert(summary.top.length === 1, `expected 1 function, got ${summary.top.length}`);
  assert(summary.top[0].totalMs === 10, `total ${summary.top[0].totalMs} should not double count`);
});

profiling.test('reports how many functions the --top cut off', async () => {
  const nodes = Array.from({ length: 5 }, (_, i) => ({
    id: i + 1,
    callFrame: { functionName: `f${i}`, url: 'x.js', lineNumber: 0 },
  }));
  const summary = analyzeCpuProfile(
    { startTime: 0, endTime: 5000, nodes, samples: [1, 2, 3, 4, 5], timeDeltas: [1, 1, 1, 1, 1] },
    2
  );
  assert(summary.omitted === 3, `omitted ${summary.omitted}`);
});

// ── focus identity ────────────────────────────────────────────────────────────

profiling.test('focus identity distinguishes repeated labels by bounds', async () => {
  const a = { text: 'Continue Watching', resourceId: '', bounds: { x1: 0, y1: 0, x2: 100, y2: 50 } };
  const b = { text: 'Continue Watching', resourceId: '', bounds: { x1: 110, y1: 0, x2: 210, y2: 50 } };
  assert(focusKey(a) !== focusKey(b), 'same label at different bounds must differ');
  assert(focusKey(a) === focusKey({ ...a, text: 'anything else' }), 'label must not affect identity');
  assert(focusKey(null) === '(none)', 'null focus');
});

// ── flow benchmark aggregation ────────────────────────────────────────────────

profiling.test('aggregates repeated flow runs per command', async () => {
  const agg = aggregateRuns([
    {
      totalMs: 100,
      entries: [
        { label: 'tap "Play"', depth: 0, ms: 10, ok: true },
        { label: 'assertVisible "Now Playing"', depth: 0, ms: 90, ok: true },
      ],
    },
    {
      totalMs: 200,
      entries: [
        { label: 'tap "Play"', depth: 0, ms: 20, ok: true },
        { label: 'assertVisible "Now Playing"', depth: 0, ms: 180, ok: false },
      ],
    },
  ]);
  assert(agg.runs === 2, `runs ${agg.runs}`);
  assert(agg.commands[0].label === 'assertVisible "Now Playing"', 'slowest command sorts first');
  assert(agg.commands[0].failures === 1, `failures ${agg.commands[0].failures}`);
  assert(agg.total.p50Ms === 100, `total p50 ${agg.total.p50Ms}`);
});

// ── React commit profiler (the injected hook, run for real) ───────────────────

type FakeFiber = {
  type: { name: string } | string | null;
  actualStartTime: number;
  actualDuration: number;
  child?: FakeFiber | null;
  sibling?: FakeFiber | null;
};

function fiber(
  name: string | null,
  actualStartTime: number,
  actualDuration: number,
  child?: FakeFiber | null,
  sibling?: FakeFiber | null
): FakeFiber {
  return {
    type: name === null ? null : { name },
    actualStartTime,
    actualDuration,
    child: child ?? null,
    sibling: sibling ?? null,
  };
}

type FakeHook = {
  renderers: Map<number, unknown>;
  getFiberRoots: () => Set<{ current: FakeFiber }>;
  onCommitFiberRoot?: (id: number, root: { current: FakeFiber }, priority?: number) => void;
};

const g = globalThis as unknown as Record<string, unknown>;

/**
 * Install the real injected hook against a fake DevTools hook, feed it commits,
 * and read the summary back — exercising the shipped source rather than a
 * re-implementation of it.
 *
 * Commits are thunks so a test can mutate the fiber tree between them, the way
 * React mutates the tree it reuses.
 */
function runCommits(commits: Array<() => { current: FakeFiber }>): ReactProfilerReadResult {
  const hook: FakeHook = {
    renderers: new Map([[1, {}]]),
    getFiberRoots: () => new Set<{ current: FakeFiber }>(),
  };
  delete g.__CONDUCTOR_REACT_PROFILER__;
  g.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook;
  try {
    eval(REACT_PROFILER_INSTALL(500, 200));
    for (const commit of commits) hook.onCommitFiberRoot!(1, commit());
    const read = eval(REACT_PROFILER_READ(20, true)) as ReactProfilerReadResult;
    eval(REACT_PROFILER_STOP);
    return read;
  } finally {
    delete g.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    delete g.__CONDUCTOR_REACT_PROFILER__;
  }
}

profiling.test('attributes self time by subtracting children that rendered too', async () => {
  // root(10ms) -> A(10ms) -> B(6ms): A's own cost is 4ms, B's is 6ms.
  const b = fiber('B', 102, 6);
  const a = fiber('A', 101, 10, b);
  const read = runCommits([() => ({ current: fiber(null, 100, 10, a) })]);

  const A = read.top!.find((t) => t.name === 'A')!;
  const B = read.top!.find((t) => t.name === 'B')!;
  assert(A.selfMs === 4, `A self ${A.selfMs}`);
  assert(A.totalMs === 10, `A total ${A.totalMs}`);
  assert(B.selfMs === 6, `B self ${B.selfMs}`);
  assert(read.totalCommits === 1, `commits ${read.totalCommits}`);
});

profiling.test('does not re-count a fiber that did not render in this commit', async () => {
  // Commit 1 renders A and B. Commit 2 renders only A; B keeps the stale
  // actualDuration React left on it, which must not be counted again.
  const b = fiber('B', 102, 6);
  const a = fiber('A', 101, 10, b);
  const root = fiber(null, 100, 10, a);

  const read = runCommits([
    () => ({ current: root }),
    () => {
      // React reuses these fiber objects; only A is worked on again. b keeps the
      // stale 6ms React left on it from the first commit.
      root.actualStartTime = 200;
      root.actualDuration = 3;
      a.actualStartTime = 201;
      a.actualDuration = 3;
      return { current: root };
    },
  ]);
  const A = read.top!.find((t) => t.name === 'A')!;
  const B = read.top!.find((t) => t.name === 'B')!;
  assert(read.totalCommits === 2, `commits ${read.totalCommits}`);
  assert(A.renders === 2, `A renders ${A.renders}`);
  assert(B.renders === 1, `B renders ${B.renders} — stale fiber was re-counted`);
  assert(B.selfMs === 6, `B self ${B.selfMs} — stale duration was re-added`);
  assert(A.selfMs === 7, `A self ${A.selfMs}`);
});

profiling.test('keeps a per-commit timeline with durations', async () => {
  const a = fiber('A', 101, 10);
  const root = fiber(null, 100, 10, a);
  const read = runCommits([() => ({ current: root })]);
  assert(read.commits!.length === 1, `commits ${read.commits!.length}`);
  assert(read.commits![0].durationMs === 10, `duration ${read.commits![0].durationMs}`);
  assert(read.commits![0].components!.length === 1, 'component detail is retained');
  assert(typeof read.commits![0].at === 'number', 'commit carries a timestamp');
});

profiling.test('reports truncation instead of silently dropping records', async () => {
  const hook: FakeHook = {
    renderers: new Map([[1, {}]]),
    getFiberRoots: () => new Set<{ current: FakeFiber }>(),
  };
  delete g.__CONDUCTOR_REACT_PROFILER__;
  g.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook;
  try {
    eval(REACT_PROFILER_INSTALL(2, 1));
    // Three commits, each with two components: both caps bite.
    for (let i = 0; i < 3; i++) {
      const b = fiber('B', 100 * i + 2, 1);
      const a = fiber('A', 100 * i + 1, 2, b);
      hook.onCommitFiberRoot!(1, { current: fiber(null, 100 * i, 2, a) });
    }
    const read = eval(REACT_PROFILER_READ(20, false)) as ReactProfilerReadResult;
    eval(REACT_PROFILER_STOP);
    assert(read.truncated === true, 'truncation should be reported');
    assert(read.droppedCommits === 1, `droppedCommits ${read.droppedCommits}`);
    assert(read.droppedComponents === 3, `droppedComponents ${read.droppedComponents}`);
    assert(read.totalCommits === 2, `totalCommits ${read.totalCommits}`);
  } finally {
    delete g.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    delete g.__CONDUCTOR_REACT_PROFILER__;
  }
});

profiling.test('detects a build with no React profiling instrumentation', async () => {
  const bare = { type: null, actualStartTime: 0, child: null, sibling: null };
  const hook: FakeHook = {
    renderers: new Map([[1, {}]]),
    getFiberRoots: () => new Set([{ current: bare as unknown as FakeFiber }]),
  };
  delete g.__CONDUCTOR_REACT_PROFILER__;
  g.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook;
  try {
    const result = eval(REACT_PROFILER_INSTALL(500, 200)) as { profilingSupported?: boolean | null };
    assert(result.profilingSupported === false, `profilingSupported ${result.profilingSupported}`);
    eval(REACT_PROFILER_STOP);
  } finally {
    delete g.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    delete g.__CONDUCTOR_REACT_PROFILER__;
  }
});

profiling.test('refuses to install without a React DevTools hook', async () => {
  delete g.__CONDUCTOR_REACT_PROFILER__;
  delete g.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  const result = eval(REACT_PROFILER_INSTALL(500, 200)) as { installed: boolean; error?: string };
  assert(result.installed === false, 'should not install');
  assert(/DevTools hook/.test(result.error ?? ''), `error "${result.error}"`);
});

// ── Real-hardware regression fixture ──────────────────────────────────────────

// Captured from an NVIDIA SHIELD Android TV (Android 11, API 30) over adb. Every
// trap in here was found on the device, not anticipated: a "50th gpu percentile"
// line that a loose regex would read as the UI percentile, a Flags=8 row the
// platform says not to measure, and INT64_MAX in OldestInputEvent.
const SHIELD = fs.readFileSync(
  path.join(__dirname, '../../tests/fixtures-gfxinfo-shield.txt'),
  'utf8'
);

profiling.test('real Shield capture: UI percentiles are not the GPU ones', async () => {
  const s = parseGfxinfoSummary(SHIELD);
  // The capture has "99th percentile: 19ms" and "99th gpu percentile: 14ms".
  assert(s.platformP99Ms === 19, `p99 ${s.platformP99Ms} — must not pick up the GPU line`);
  assert(s.platformP50Ms === 5, `p50 ${s.platformP50Ms}`);
  assert(s.totalFrames === 115, `totalFrames ${s.totalFrames}`);
  assert(s.highInputLatency === 18, `highInputLatency ${s.highInputLatency}`);
  assert(s.packageName === 'com.google.android.tvlauncher', `pkg ${s.packageName}`);
});

profiling.test('real Shield capture: UI histogram is not the GPU histogram', async () => {
  const h = parseGfxinfoHistogram(SHIELD);
  assert(h[0].count === 111, `first bucket count ${h[0].count} — GPU histogram starts 1ms=92`);
});

profiling.test('real Shield capture: the Flags!=0 row is dropped', async () => {
  const rows = parseFramestats(SHIELD);
  assert(rows.length === 4, `rows ${rows.length}`);
  const usable = rows.map((r) => toFrameSample(r)).filter((f) => f !== null);
  assert(usable.length === 3, `usable ${usable.length} — the Flags=8 row must be excluded`);
});

profiling.test('real Shield capture: INT64_MAX input columns never become latencies', async () => {
  const frames = parseFramestats(SHIELD)
    .map((r) => toFrameSample(r))
    .filter((f) => f !== null)
    .map((f) => f!);
  assert(
    frames.every((f) => f.inputLatencyMs === null),
    'this device never populates NewestInputEvent, so every frame must report null'
  );
  const stats = summariseFrames(frames, 5)!;
  assert(stats.inputLatency === undefined, 'absent, not a zeroed distribution');
});

profiling.test('real Shield capture: Uptime anchors frames to the monotonic clock', async () => {
  const uptimeMs = parseGfxinfoUptimeMs(SHIELD);
  assert(uptimeMs === 228452, `uptime ${uptimeMs}`);
  const frames = parseFramestats(SHIELD)
    .map((r) => toFrameSample(r))
    .filter((f) => f !== null)
    .map((f) => f!);
  // Frames must predate the dump that reported them, in the same clock domain.
  assert(
    frames.every((f) => f.completedNs / 1e6 < uptimeMs!),
    'framestats vsync must be in the same CLOCK_MONOTONIC domain as Uptime'
  );
});

// ── Regressions found on a Fire TV Stick 4K Max ───────────────────────────────

// With nothing drawn, gfxinfo still prints percentiles filled from the top
// histogram bucket. Reported verbatim that reads as catastrophic jank when the
// truth is that no frame existed.
const GFXINFO_NO_FRAMES = `Applications Graphics Acceleration Info:
Uptime: 100000 Realtime: 100000

** Graphics info for pid 999 [com.example.idle] **

Stats since: 1000000ns
Total frames rendered: 0
Janky frames: 0 (0.00%)
50th percentile: 4950ms
90th percentile: 4950ms
95th percentile: 4950ms
99th percentile: 4950ms
Number Missed Vsync: 0
Number High input latency: 0
Number Slow UI thread: 0
Number Slow bitmap uploads: 0
Number Slow issue draw commands: 0
Number Frame deadline missed: 0
HISTOGRAM: 5ms=0 4950ms=0
`;

profiling.test('a zero-frame window reports no percentiles at all', async () => {
  const s = parseGfxinfoSummary(GFXINFO_NO_FRAMES);
  assert(s.totalFrames === 0, `totalFrames ${s.totalFrames}`);
  for (const key of ['platformP50Ms', 'platformP90Ms', 'platformP95Ms', 'platformP99Ms'] as const) {
    assert(s[key] === undefined, `${key} is ${s[key]} — "p99 4950ms" over zero frames is not jank`);
  }
  assert(s.jankyPercent === undefined, `jankyPercent ${s.jankyPercent}`);
});

profiling.test('a window that did draw keeps its percentiles', async () => {
  const s = parseGfxinfoSummary(SHIELD);
  assert(s.totalFrames === 115 && s.platformP99Ms === 19, 'real frames still report percentiles');
});

profiling.test('sample attribution separates GC and empty stacks from real functions', async () => {
  // Shape observed on a Fire TV Stick: almost everything synthetic.
  const profile = {
    startTime: 0,
    endTime: 100_000,
    nodes: [
      { id: 1, callFrame: { functionName: '[root]' } },
      { id: 2, callFrame: { functionName: '[GC Old Gen (Direct)]' } },
      { id: 3, callFrame: { functionName: '[GC Young Gen]' } },
      { id: 4, callFrame: { functionName: 'renderRow', url: 'App.js', lineNumber: 4 } },
    ],
    samples: [1, 1, 1, 1, 1, 1, 1, 2, 2, 3, 4],
    timeDeltas: Array(11).fill(1000),
  };
  const summary = analyzeCpuProfile(profile, 10);
  const a = summary.attribution;
  assert(a.idlePercent > 60, `idlePercent ${a.idlePercent}`);
  assert(a.gcPercent > 20, `gcPercent ${a.gcPercent}`);
  assert(a.namedJsPercent < 15, `namedJsPercent ${a.namedJsPercent}`);
  assert(
    summary.notes.some((n) => n.code === 'low-attribution'),
    'a ranking built on <25% of samples must say so'
  );
});

profiling.test('a well-attributed profile raises no low-attribution note', async () => {
  const profile = {
    startTime: 0,
    endTime: 10_000,
    nodes: [
      { id: 1, callFrame: { functionName: '[root]' } },
      { id: 2, callFrame: { functionName: 'work', url: 'App.js', lineNumber: 0 } },
    ],
    samples: [2, 2, 2, 1],
    timeDeltas: [1000, 1000, 1000, 1000],
  };
  const summary = analyzeCpuProfile(profile, 10);
  assert(summary.attribution.namedJsPercent === 75, `named ${summary.attribution.namedJsPercent}`);
  assert(summary.notes.length === 0, 'no note when the ranking is trustworthy');
});

// ── GC inferred from heap deltas ──────────────────────────────────────────────

// On a Fire TV Stick the Java heap fell 11.8MB in a window that logged no ART
// collections at all. A shrinking heap was collected; there is no other
// mechanism, so the deltas catch what logcat misses.
function memSamples(javaHeapMb: number[]): Array<{ at: number; data: Record<string, unknown> }> {
  return javaHeapMb.map((mb, i) => ({
    at: i * 1000,
    data: { app: { javaHeapBytes: mb * 1024 * 1024 } },
  }));
}

profiling.test('a shrinking heap is counted as a collection logcat missed', async () => {
  const g = inferCollections(memSamples([22.6, 23.1, 10.8, 12.0]))!;
  assert(g.collections === 1, `collections ${g.collections}`);
  assert(Math.round(g.reclaimedBytes / 1024 / 1024) === 12, `reclaimed ${g.reclaimedBytes}`);
  assert(g.series === 'javaHeapBytes', `series ${g.series}`);
});

profiling.test('sampling jitter is not mistaken for a collection', async () => {
  const g = inferCollections(memSamples([22.6, 22.5, 22.55, 22.7]))!;
  assert(g.collections === 0, `sub-256KB wobble must not count, got ${g.collections}`);
});

profiling.test('a monotonically growing heap implies no collection', async () => {
  const g = inferCollections(memSamples([10, 12, 14, 16]))!;
  assert(g.collections === 0, `collections ${g.collections}`);
});

profiling.test('inference needs at least two samples', async () => {
  assert(inferCollections(memSamples([10])) === undefined, 'one sample cannot show a delta');
  assert(inferCollections([]) === undefined, 'no samples');
});

profiling.test('heap growth reports start, end, delta and peak per field', async () => {
  const rows = heapGrowth(memSamples([20, 30, 25]));
  const java = rows.find((r) => r.key === 'javaHeapBytes')!;
  assert(Math.round(java.startBytes / 1024 / 1024) === 20, `start ${java.startBytes}`);
  assert(Math.round(java.endBytes / 1024 / 1024) === 25, `end ${java.endBytes}`);
  assert(Math.round(java.deltaBytes / 1024 / 1024) === 5, `delta ${java.deltaBytes}`);
  assert(Math.round(java.peakBytes / 1024 / 1024) === 30, `peak ${java.peakBytes}`);
});

if (require.main === module) runAll([profiling]);
