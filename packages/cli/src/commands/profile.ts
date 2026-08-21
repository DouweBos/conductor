export const HELP = `  profile cpu --duration <s> [--out <path>]
                                       Record a CPU trace (iOS: xctrace, Android: simpleperf)
    --report [--top N]                 Android: also symbolize the trace into a ranked table
  profile memory --track <s> [--interval <ms>] [<appId>]
                                       Sample memory for N seconds, report deltas
                                       Android: also reports heap growth and GC pauses
  profile frames reset [<appId>]       Android: zero the app's gfxinfo frame counters
  profile frames report [<appId>]      Android: jank / frame timing since the last reset
    --track <s> [--interval <ms>]      Reset, sample for N seconds, then report
    --save-baseline <name> / --diff <name> / --baselines
                                       Save, compare against, and list frame baselines
  profile js record --duration <s>     Sample Hermes JS CPU and rank functions
  profile js start / stop [--top N]    Same, bracketing a flow you drive yourself
    --out <path>                       Where to write the raw .cpuprofile
  profile react start                  Install a React commit-profiler hook in the JS runtime
    --max-commits <n>                  Commit ring-buffer size (default 500)
    --max-components <n>               Component records kept per commit (default 200)
  profile react stop [--top N]         Stop and summarise captured React commits
    --timeline                         Include per-commit component detail in --json`;

import { spawn } from 'child_process';
import os from 'os';
import path from 'path';
import { printError, printData, printSuccess, OutputOptions } from '../output.js';
import { detectPlatform } from '../drivers/bootstrap.js';
import { resolveAndroidTool, androidSpawnEnv } from '../android/sdk.js';
import { spawnCommand } from '../runner.js';
import { adbShell } from '../android/device.js';
import { memory } from './memory.js';
import { MetroCdpClient } from '../drivers/metro-cdp.js';
import { collectGcSince, deviceLogcatTimestamp, summariseGc, GcReport } from './profile-gc.js';

export interface SimpleperfEntry {
  percent: number;
  dso: string;
  symbol: string;
}

/** A library's total share, so one dominant .so is legible as one thing. */
export interface DsoRollup {
  dso: string;
  percent: number;
  symbols: number;
  /** True when every sample in this library landed at a raw offset. */
  unsymbolised: boolean;
}

/** simpleperf renders an unresolved address as `libfoo.so[+1a62f8]`. */
export function isUnsymbolised(symbol: string): boolean {
  return /\[\+[0-9a-fx]+\]\s*$/i.test(symbol);
}

function shortDso(dso: string): string {
  return dso.includes('/') ? dso.slice(dso.lastIndexOf('/') + 1) : dso;
}

/**
 * Sum a flat symbol table by library.
 *
 * A stripped app library shows up as a dozen `libfoo.so[+offset]` rows that a
 * reader cannot tell apart from a dozen unrelated hotspots. Rolled up, one
 * library dominating is immediately visible — which is the actual finding when
 * a profile has no single hot symbol.
 */
export function rollupByDso(entries: SimpleperfEntry[]): DsoRollup[] {
  const byDso = new Map<string, { percent: number; symbols: number; unsym: number }>();
  for (const e of entries) {
    const key = shortDso(e.dso);
    const slot = byDso.get(key) ?? { percent: 0, symbols: 0, unsym: 0 };
    slot.percent += e.percent;
    slot.symbols++;
    if (isUnsymbolised(e.symbol)) slot.unsym++;
    byDso.set(key, slot);
  }
  return [...byDso.entries()]
    .map(([dso, v]) => ({
      dso,
      percent: Math.round(v.percent * 100) / 100,
      symbols: v.symbols,
      unsymbolised: v.unsym === v.symbols,
    }))
    .sort((a, b) => b.percent - a.percent);
}

/** Share of the sampled overhead that resolved to no function name. */
export function unsymbolisedPercent(entries: SimpleperfEntry[]): number {
  const total = entries.reduce((a, e) => a + e.percent, 0);
  if (total <= 0) return 0;
  const unsym = entries.filter((e) => isUnsymbolised(e.symbol)).reduce((a, e) => a + e.percent, 0);
  return Math.round((unsym / total) * 10000) / 100;
}

/**
 * Turn a simpleperf failure into something actionable.
 *
 * simpleperf needs the target to be `android:debuggable` or to declare
 * `<profileable android:shell="true"/>`. A stock release APK is neither, and
 * the resulting error says only `exited with 1`.
 */
async function explainSimpleperfFailure(
  deviceId: string,
  appId: string | undefined,
  stderr: string
): Promise<string> {
  // Drop simpleperf's PMU probing chatter; it is present on every run.
  const meaningful = stderr
    .split(/\r?\n/)
    .filter((l) => l.trim() && !/cannot read event type|Failed to read event type/i.test(l))
    .slice(-4)
    .join('\n');

  if (appId) {
    const pkg = await adbShell(deviceId, ['dumpsys', 'package', appId]);
    if (pkg.success && /^\s*flags=\[/m.test(pkg.stdout) && !/\bDEBUGGABLE\b/.test(pkg.stdout)) {
      return (
        `simpleperf cannot profile ${appId}: the installed APK is neither debuggable nor ` +
        `profileable.\nsimpleperf needs android:debuggable, or ` +
        `\`<profileable android:shell="true"/>\` inside <application> — the latter is a ` +
        `one-line manifest change that keeps the build a release build and is the right fix ` +
        `for a perf build.\n` +
        (meaningful ? `simpleperf said:\n${meaningful}` : '')
      );
    }
  }
  return `simpleperf record failed.\n${meaningful || '(no diagnostic output)'}`;
}

/**
 * Parse `simpleperf report --sort dso,symbol`. The header row is located by its
 * `Overhead` column rather than by line number, since simpleperf prefixes the
 * table with a variable-length preamble.
 */
export function parseSimpleperfReport(out: string): SimpleperfEntry[] {
  const lines = out.split(/\r?\n/);
  const headerIndex = lines.findIndex((l) => /^\s*Overhead\b/.test(l));
  if (headerIndex === -1) return [];
  const entries: SimpleperfEntry[] = [];
  for (const line of lines.slice(headerIndex + 1)) {
    const m = line.match(/^\s*([\d.]+)%\s+(\S+)\s+(.+?)\s*$/);
    if (!m) continue;
    entries.push({ percent: Number(m[1]), dso: m[2], symbol: m[3] });
  }
  return entries;
}

export interface ProfileCpuOptions {
  durationSec: number;
  out?: string;
  appId?: string;
  /** Android: symbolize the recording into a ranked table instead of only a raw file. */
  report?: boolean;
  top?: number;
}

function defaultTracePath(prefix: string, ext: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(os.tmpdir(), `${prefix}-${ts}.${ext}`);
}

async function recordIosCpu(
  deviceId: string,
  appId: string | undefined,
  durationSec: number,
  out: string
): Promise<void> {
  const args = [
    'xctrace',
    'record',
    '--template',
    'Time Profiler',
    '--device',
    deviceId,
    '--time-limit',
    `${durationSec}s`,
    '--output',
    out,
  ];
  if (appId) args.push('--attach', appId);
  await new Promise<void>((resolve, reject) => {
    const proc = spawn('xcrun', args, { stdio: 'inherit' });
    proc.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`xctrace exited with code ${code}`))
    );
    proc.on('error', reject);
  });
}

async function recordAndroidCpu(
  deviceId: string,
  appId: string | undefined,
  durationSec: number,
  out: string,
  report?: { top: number }
): Promise<SimpleperfEntry[] | undefined> {
  const adb = resolveAndroidTool('adb');
  const env = androidSpawnEnv();
  const remote = `/data/local/tmp/conductor-perf-${Date.now()}.data`;
  const recordArgs = [
    '-s',
    deviceId,
    'shell',
    'simpleperf',
    'record',
    '-o',
    remote,
    '--duration',
    String(durationSec),
  ];
  if (appId) {
    recordArgs.push('--app', appId);
  } else {
    recordArgs.push('-a');
  }
  // Capture rather than inherit: simpleperf prints a wall of `cannot read event
  // type` lines while probing PMU support, and those are not the error. Letting
  // them through buries whatever actually went wrong.
  const rec = await spawnCommand(adb, recordArgs, { env });
  if (!rec.success) {
    throw new Error(await explainSimpleperfFailure(deviceId, appId, rec.stderr));
  }
  // Symbolize on-device before pulling: /system/bin/simpleperf resolves against
  // the libraries actually loaded there, which a host-side report cannot do
  // without a matching symfs.
  let entries: SimpleperfEntry[] | undefined;
  if (report) {
    const res = await spawnCommand(
      adb,
      [
        '-s',
        deviceId,
        'shell',
        'simpleperf',
        'report',
        '-i',
        remote,
        '--sort',
        'dso,symbol',
        '--percent-limit',
        '0.1',
      ],
      { env }
    );
    if (!res.success) {
      throw new Error(
        `simpleperf report failed on-device (${res.stderr.trim() || 'no output'}). ` +
          `The raw recording is still at ${out}; symbolize it on the host with the NDK's ` +
          `simpleperf/report.py.`
      );
    }
    entries = parseSimpleperfReport(res.stdout).slice(0, report.top);
  }

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(adb, ['-s', deviceId, 'pull', remote, out], { stdio: 'inherit', env });
    proc.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`adb pull exited with ${code}`))
    );
    proc.on('error', reject);
  });
  await new Promise<void>((resolve) => {
    const proc = spawn(adb, ['-s', deviceId, 'shell', 'rm', remote], { stdio: 'ignore', env });
    proc.on('close', () => resolve());
    proc.on('error', () => resolve());
  });
  return entries;
}

export async function profileCpu(
  opts: OutputOptions,
  sessionName: string,
  profileOpts: ProfileCpuOptions
): Promise<number> {
  if (sessionName === 'default') {
    printError('profile cpu requires a --device', opts);
    return 1;
  }
  const platform = await detectPlatform(sessionName).catch(() => null);
  const isIos = platform === 'ios' || platform === 'tvos';
  const out = profileOpts.out ?? defaultTracePath('cpu', isIos ? 'trace' : 'perf.data');
  let entries: SimpleperfEntry[] | undefined;
  try {
    if (isIos) {
      if (profileOpts.report) {
        printError(
          'profile cpu --report is Android-only. Export the iOS trace with ' +
            '`xcrun xctrace export --input <trace> --toc` to see what it holds.',
          opts
        );
        return 1;
      }
      await recordIosCpu(sessionName, profileOpts.appId, profileOpts.durationSec, out);
    } else if (platform === 'android') {
      entries = await recordAndroidCpu(
        sessionName,
        profileOpts.appId,
        profileOpts.durationSec,
        out,
        profileOpts.report ? { top: profileOpts.top ?? 30 } : undefined
      );
    } else if (platform === 'vega') {
      // Vega is Amazon's own OS, not Android — no simpleperf, no dumpsys. A
      // physical Fire TV Stick runs Fire OS (Android) over adb and is a
      // different target entirely, where all the Android tooling applies.
      printError(
        'profile cpu is not supported on vega (Amazon Vega OS — no simpleperf on device).\n' +
          'A physical Fire TV Stick runs Fire OS, which is Android: connect it with ' +
          '`adb connect <ip>` and conductor treats it as an android device, where ' +
          '`profile cpu`, `profile frames` and `profile memory` all work.',
        opts
      );
      return 1;
    } else {
      printError(`profile cpu is not supported on platform ${platform ?? '(unknown)'}`, opts);
      return 1;
    }
    const byDso = entries ? rollupByDso(entries) : undefined;
    const unsymPercent = entries ? unsymbolisedPercent(entries) : undefined;
    if (opts.json) {
      printData(
        {
          out,
          durationSec: profileOpts.durationSec,
          platform,
          symbols: entries,
          byDso,
          unsymbolisedPercent: unsymPercent,
        },
        opts
      );
    } else {
      printSuccess(`profile cpu — recorded ${profileOpts.durationSec}s → ${out}`, opts);
      if (byDso && byDso.length > 0) {
        // Lead with the rollup: a flat profile has no hot symbol, and the real
        // finding is usually which library the samples are spread across.
        console.log(`\n  by library`);
        for (const d of byDso.slice(0, 10)) {
          console.log(
            `  ${`${d.percent}%`.padStart(9)}  ${d.dso}  (${d.symbols} symbol${d.symbols === 1 ? '' : 's'}` +
              `${d.unsymbolised ? ', unsymbolised' : ''})`
          );
        }
      }
      if (entries) {
        console.log(`\n  ${'overhead'.padStart(9)}  symbol`);
        for (const e of entries) {
          console.log(`  ${`${e.percent}%`.padStart(9)}  ${e.symbol}  [${e.dso}]`);
        }
      }
      if (unsymPercent !== undefined && unsymPercent > 10) {
        console.log(
          `\n  note: ${unsymPercent}% of sampled overhead resolved to a raw address rather ` +
            `than a function — those libraries are stripped. Read the by-library rollup above ` +
            `instead of the symbol table; a dozen \`lib.so[+offset]\` rows are one library, ` +
            `not a dozen findings.`
        );
      }
    }
    return 0;
  } catch (err) {
    printError(`profile cpu — ${err instanceof Error ? err.message : String(err)}`, opts);
    return 1;
  }
}

export interface ProfileMemoryOptions {
  trackSec: number;
  intervalMs: number;
  appId?: string;
}

interface HeapGrowth {
  key: string;
  startBytes: number;
  endBytes: number;
  deltaBytes: number;
  peakBytes: number;
}

/** Growth of each numeric field of `report.app` across the tracked window. */
export function heapGrowth(
  samples: Array<{ at: number; data: Record<string, unknown> | null }>
): HeapGrowth[] {
  const series = new Map<string, number[]>();
  for (const s of samples) {
    const app = (s.data as { app?: Record<string, unknown> } | null)?.app;
    if (!app) continue;
    for (const [k, v] of Object.entries(app)) {
      if (typeof v !== 'number') continue;
      const arr = series.get(k) ?? [];
      arr.push(v);
      series.set(k, arr);
    }
  }
  return [...series.entries()]
    .map(([key, values]) => ({
      key,
      startBytes: values[0],
      endBytes: values[values.length - 1],
      deltaBytes: values[values.length - 1] - values[0],
      peakBytes: Math.max(...values),
    }))
    .sort((a, b) => b.deltaBytes - a.deltaBytes);
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export interface InferredGc {
  /** Consecutive-sample decreases in the tracked heap. Each implies a collection. */
  collections: number;
  reclaimedBytes: number;
  series: string;
}

/**
 * Infer collections from the heap series rather than from logcat.
 *
 * A heap that shrinks between two samples was collected between them — there is
 * no other mechanism. This matters because ART's GC logging is not reliably on:
 * measured on a Fire TV Stick (Fire OS, API 30), a window in which the Java heap
 * fell 11.8MB produced no `art:I` lines at all. Absence of logged collections is
 * therefore not absence of collection, and the deltas are the sounder signal.
 */
export function inferCollections(
  samples: Array<{ at: number; data: Record<string, unknown> | null }>,
  series = 'javaHeapBytes'
): InferredGc | undefined {
  const values: number[] = [];
  for (const s of samples) {
    const app = (s.data as { app?: Record<string, unknown> } | null)?.app;
    const v = app?.[series];
    if (typeof v === 'number') values.push(v);
  }
  if (values.length < 2) return undefined;
  let collections = 0;
  let reclaimedBytes = 0;
  for (let i = 1; i < values.length; i++) {
    const drop = values[i - 1] - values[i];
    // Ignore sampling jitter; only count drops worth a collection.
    if (drop > 256 * 1024) {
      collections++;
      reclaimedBytes += drop;
    }
  }
  return { collections, reclaimedBytes, series };
}

export async function profileMemory(
  opts: OutputOptions,
  sessionName: string,
  profileOpts: ProfileMemoryOptions
): Promise<number> {
  const samples: Array<{ at: number; sample: string }> = [];
  const platform = await detectPlatform(sessionName).catch(() => undefined);
  const isAndroid = platform === 'android';
  // Note the device's own clock before sampling so the logcat window lines up
  // with it even when the host clock has drifted.
  const gcSince = isAndroid ? await deviceLogcatTimestamp(sessionName) : undefined;
  const start = Date.now();
  const end = start + profileOpts.trackSec * 1000;

  while (Date.now() < end) {
    const at = Date.now() - start;
    // Capture memory output for this sample by intercepting stdout.
    const captured = await captureStdout(async () => {
      await memory(profileOpts.appId, { json: true }, sessionName, {});
    });
    samples.push({ at, sample: captured });
    if (Date.now() < end) {
      await new Promise((r) => setTimeout(r, profileOpts.intervalMs));
    }
  }

  const parsed = samples.map((s) => {
    try {
      return { at: s.at, data: JSON.parse(s.sample) as Record<string, unknown> };
    } catch {
      return { at: s.at, data: null };
    }
  });

  const growth = heapGrowth(parsed);
  const inferredGc = isAndroid ? inferCollections(parsed) : undefined;
  let gc: GcReport | undefined;
  if (isAndroid) {
    const events = await collectGcSince(sessionName, gcSince);
    if (events.length > 0) gc = summariseGc(events);
  }

  if (opts.json) {
    printData({ samples: parsed, durationMs: Date.now() - start, growth, gc, inferredGc }, opts);
  } else {
    console.log(`profile memory — ${samples.length} samples over ${profileOpts.trackSec}s`);
    for (const p of parsed) {
      const summary =
        p.data && typeof p.data === 'object'
          ? Object.entries(p.data)
              .slice(0, 4)
              .map(([k, v]) => `${k}=${typeof v === 'object' ? '…' : String(v)}`)
              .join(' ')
          : '(parse error)';
      console.log(`  t+${(p.at / 1000).toFixed(1)}s  ${summary}`);
    }
    if (growth.length > 0) {
      console.log('\n  heap growth over the window');
      for (const g of growth.slice(0, 8)) {
        const sign = g.deltaBytes >= 0 ? '+' : '';
        console.log(
          `    ${g.key.padEnd(20)} ${mb(g.startBytes)} → ${mb(g.endBytes)}  ` +
            `${sign}${mb(g.deltaBytes)}  peak ${mb(g.peakBytes)}`
        );
      }
    }
    if (gc) {
      console.log(
        `\n  GC: ${gc.events} collection(s), ${gc.totalPauseMs}ms of stop-the-world pause total`
      );
      console.log(
        `    pause  p50 ${gc.pause.p50Ms}ms  p95 ${gc.pause.p95Ms}ms  max ${gc.pause.maxMs}ms`
      );
      for (const k of gc.byKind) {
        console.log(
          `    ${k.kind.padEnd(34)} ${String(k.count).padStart(4)}x  ${k.totalPauseMs}ms`
        );
      }
    } else if (isAndroid) {
      console.log('\n  GC: no ART collections logged in the window.');
      if (inferredGc && inferredGc.collections > 0) {
        console.log(
          `    But ${inferredGc.series} fell ${inferredGc.collections} time(s), reclaiming ` +
            `${mb(inferredGc.reclaimedBytes)} — so collections did run and were not logged. ` +
            `ART's logging is off or filtered on this build; trust the heap deltas, not logcat.`
        );
      } else {
        console.log(
          '    Absence of logged collections is not absence of collection — ART logging is ' +
            'off or filtered on some builds. The heap deltas above are the sounder signal.'
        );
      }
    }

    if (inferredGc && inferredGc.collections > 0 && gc) {
      console.log(
        `    (heap deltas independently imply ${inferredGc.collections} collection(s), ` +
          `${mb(inferredGc.reclaimedBytes)} reclaimed)`
      );
    }
  }
  return 0;
}

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((c: string | Uint8Array) => {
    chunks.push(typeof c === 'string' ? c : Buffer.from(c).toString());
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = origWrite;
  }
  return chunks.join('');
}

// ── React profiler ────────────────────────────────────────────────────────────

/**
 * Injected commit profiler.
 *
 * The subtle part is deciding which fibers actually rendered in a given commit.
 * React does not clear `actualDuration` on fibers it left alone, so "has a
 * non-zero actualDuration" is true for anything that rendered at any point in
 * the past, and counting those every commit inflates both render counts and
 * durations. What React does clear is `actualStartTime`: `createWorkInProgress`
 * resets it to -1 and `startProfilerTimer` stamps it as work begins, and a
 * render pass always begins at the root. So the root's own `actualStartTime` is
 * the start of this pass, and a fiber rendered in it exactly when its start time
 * is at or after the root's. Anchoring on the root rather than on a running
 * maximum keeps this independent of whichever clock React's `now()` is bound to.
 *
 * That render passes always walk down from the root also lets us prune: a fiber
 * that did not render cannot contain one that did, so the walk costs the size of
 * the rendered set, not the size of the tree.
 *
 * `actualDuration` bubbles up, so a fiber's own cost is its duration minus that
 * of the children that rendered alongside it. Both are reported: `selfMs` is
 * additive across components, `totalMs` is subtree-inclusive and double-counts
 * by design.
 */
export const REACT_PROFILER_INSTALL = (maxCommits: number, maxComponents: number): string => `
(() => {
  if (globalThis.__CONDUCTOR_REACT_PROFILER__) {
    return { installed: true, already: true };
  }
  const hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook) return { installed: false, error: 'No React DevTools hook on this runtime' };

  var state = {
    commits: [],
    maxCommits: ${maxCommits},
    maxComponents: ${maxComponents},
    droppedCommits: 0,
    droppedComponents: 0,
    skippedCommits: 0,
    profilingSupported: null
  };

  // Detect up front whether this build carries React's timing instrumentation,
  // so profile react start can fail loudly rather than leaving it to stop.
  var rendererCount = 0;
  try {
    if (hook.renderers && hook.getFiberRoots) {
      hook.renderers.forEach(function (_r, id) {
        rendererCount++;
        var roots = hook.getFiberRoots(id);
        if (!roots) return;
        roots.forEach(function (root) {
          if (state.profilingSupported === null) {
            state.profilingSupported = root.current.actualDuration !== undefined;
          }
        });
      });
    }
  } catch (e) {}

  var orig = hook.onCommitFiberRoot;
  hook.onCommitFiberRoot = function (rendererID, root, priorityLevel) {
    try {
      var rootFiber = root.current;
      if (state.profilingSupported === null) {
        state.profilingSupported = rootFiber.actualDuration !== undefined;
      }
      var passStart = rootFiber.actualStartTime;
      if (state.profilingSupported && !(typeof passStart === 'number' && passStart >= 0)) {
        // No start stamp on the root means we cannot tell this commit's work
        // from earlier work; skipping is better than reporting stale fibers.
        state.skippedCommits++;
      } else if (state.profilingSupported) {
        var components = [];
        var droppedHere = 0;

        var visit = function (fiber, depth) {
          var start = fiber.actualStartTime;
          if (!(typeof start === 'number' && start >= passStart)) return 0;

          var childSum = 0;
          var child = fiber.child;
          while (child) {
            childSum += visit(child, depth + 1);
            child = child.sibling;
          }

          var dur = fiber.actualDuration || 0;
          var name =
            (fiber.type && (fiber.type.displayName || fiber.type.name)) ||
            (typeof fiber.type === 'string' ? fiber.type : null);
          if (name) {
            if (components.length < state.maxComponents) {
              components.push({
                name: name,
                depth: depth,
                actualDuration: dur,
                selfDuration: Math.max(0, dur - childSum)
              });
            } else {
              droppedHere++;
            }
          }
          return dur;
        };

        visit(rootFiber, 0);
        state.droppedComponents += droppedHere;
        state.commits.push({
          at: Date.now(),
          rendererID: rendererID,
          durationMs: rootFiber.actualDuration || 0,
          truncated: droppedHere > 0,
          droppedComponents: droppedHere,
          components: components
        });
        while (state.commits.length > state.maxCommits) {
          state.commits.shift();
          state.droppedCommits++;
        }
      }
    } catch (e) {}
    if (typeof orig === 'function') return orig.apply(this, arguments);
  };

  globalThis.__CONDUCTOR_REACT_PROFILER__ = {
    installed: true,
    state: state,
    uninstall: function () { hook.onCommitFiberRoot = orig; }
  };
  return {
    installed: true,
    already: false,
    renderers: rendererCount,
    profilingSupported: state.profilingSupported
  };
})()
`;

export const REACT_PROFILER_READ = (top: number, timeline: boolean): string => `
(() => {
  const p = globalThis.__CONDUCTOR_REACT_PROFILER__;
  if (!p) return { installed: false };
  const s = p.state;
  const byName = {};
  for (const c of s.commits) {
    for (const comp of c.components) {
      const e = byName[comp.name] || (byName[comp.name] = {
        name: comp.name, selfMs: 0, totalMs: 0, renders: 0
      });
      e.selfMs += comp.selfDuration;
      e.totalMs += comp.actualDuration;
      e.renders += 1;
    }
  }
  const ranked = Object.keys(byName).map(function (k) { return byName[k]; })
    .sort(function (a, b) { return b.selfMs - a.selfMs; });
  const commits = s.commits.map(function (c) {
    const out = {
      at: c.at,
      durationMs: c.durationMs,
      componentCount: c.components.length,
      droppedComponents: c.droppedComponents
    };
    if (${timeline ? 'true' : 'false'}) out.components = c.components;
    return out;
  });
  return {
    installed: true,
    profilingSupported: s.profilingSupported,
    totalCommits: s.commits.length,
    droppedCommits: s.droppedCommits,
    skippedCommits: s.skippedCommits,
    droppedComponents: s.droppedComponents,
    truncated: s.droppedCommits > 0 || s.droppedComponents > 0,
    maxCommits: s.maxCommits,
    maxComponents: s.maxComponents,
    componentsRanked: ranked.length,
    top: ranked.slice(0, ${top}),
    commits: commits
  };
})()
`;

export const REACT_PROFILER_STOP = `
(() => {
  const p = globalThis.__CONDUCTOR_REACT_PROFILER__;
  if (!p) return { installed: false };
  if (typeof p.uninstall === 'function') p.uninstall();
  delete globalThis.__CONDUCTOR_REACT_PROFILER__;
  return { installed: true, stopped: true };
})()
`;

interface ReactProfilerStartResult {
  installed: boolean;
  already?: boolean;
  error?: string;
  renderers?: number;
  profilingSupported?: boolean | null;
}

export interface ReactComponentStat {
  name: string;
  selfMs: number;
  totalMs: number;
  renders: number;
}

export interface ReactCommitEntry {
  at: number;
  durationMs: number;
  componentCount: number;
  droppedComponents: number;
  components?: Array<{
    name: string;
    depth: number;
    actualDuration: number;
    selfDuration: number;
  }>;
}

export interface ReactProfilerReadResult {
  installed: boolean;
  profilingSupported?: boolean | null;
  totalCommits?: number;
  droppedCommits?: number;
  /** Commits whose root carried no start stamp, so their work could not be isolated. */
  skippedCommits?: number;
  droppedComponents?: number;
  truncated?: boolean;
  maxCommits?: number;
  maxComponents?: number;
  componentsRanked?: number;
  top?: ReactComponentStat[];
  commits?: ReactCommitEntry[];
}

export interface ProfileReactOptions {
  port?: number;
  targetIndex?: number;
  maxCommits?: number;
  maxComponents?: number;
  timeline?: boolean;
}

const NO_PROFILING_BUILD =
  'this build has no React profiling data (fibers carry no actualDuration). ' +
  'The React commit profiler needs a dev or profiling build; a release build ' +
  'strips the timing instrumentation. Use `profile js` or `profile frames` to ' +
  'measure a release build.';

async function connectCdp(
  sessionName: string,
  cdpOpts: { port?: number; targetIndex?: number }
): Promise<MetroCdpClient> {
  const platform = await detectPlatform(sessionName).catch(() => undefined);
  const client = new MetroCdpClient();
  await client.connect({
    port: cdpOpts.port,
    deviceId: sessionName !== 'default' ? sessionName : undefined,
    platform,
    targetIndex: cdpOpts.targetIndex,
  });
  return client;
}

export async function profileReactStart(
  opts: OutputOptions,
  sessionName: string,
  reactOpts: ProfileReactOptions
): Promise<number> {
  let client: MetroCdpClient | undefined;
  try {
    client = await connectCdp(sessionName, reactOpts);
    const result = await client.evaluate<ReactProfilerStartResult>(
      REACT_PROFILER_INSTALL(reactOpts.maxCommits ?? 500, reactOpts.maxComponents ?? 200)
    );
    if (!result.installed) {
      printError(`profile react start — ${result.error ?? 'install failed'}`, opts);
      return 1;
    }
    if (result.profilingSupported === false) {
      await client.evaluate(REACT_PROFILER_STOP);
      printError(`profile react start — ${NO_PROFILING_BUILD}`, opts);
      return 1;
    }
    if (opts.json) printData({ status: 'ok', ...result }, opts);
    else {
      printSuccess(
        `profile react start — ${result.already ? 'already installed' : 'installed'}`,
        opts
      );
      if (result.profilingSupported === null) {
        console.log(
          '  note: nothing has rendered yet, so the build could not be checked for profiling ' +
            'support. `profile react stop` will say so if it turns out to be a release build.'
        );
      }
    }
    return 0;
  } catch (err) {
    printError(`profile react start — ${err instanceof Error ? err.message : String(err)}`, opts);
    return 1;
  } finally {
    client?.close();
  }
}

export async function profileReactStop(
  opts: OutputOptions,
  sessionName: string,
  reactOpts: ProfileReactOptions,
  top: number
): Promise<number> {
  let client: MetroCdpClient | undefined;
  try {
    client = await connectCdp(sessionName, reactOpts);
    const read = await client.evaluate<ReactProfilerReadResult>(
      REACT_PROFILER_READ(top, reactOpts.timeline ?? false)
    );
    await client.evaluate(REACT_PROFILER_STOP);
    if (!read.installed) {
      printError('profile react stop — profiler was not installed', opts);
      return 1;
    }
    if (read.profilingSupported === false) {
      printError(`profile react stop — ${NO_PROFILING_BUILD}`, opts);
      return 1;
    }
    if (read.profilingSupported === null || (read.totalCommits ?? 0) === 0) {
      printError(
        'profile react stop — no commits were captured. Either nothing re-rendered while the ' +
          'profiler was installed, or the app reloaded (which drops the hook).',
        opts
      );
      return 1;
    }
    if (opts.json) printData({ status: 'ok', ...read }, opts);
    else printReactReport(read);
    return 0;
  } catch (err) {
    printError(`profile react stop — ${err instanceof Error ? err.message : String(err)}`, opts);
    return 1;
  } finally {
    client?.close();
  }
}

function printReactReport(read: ReactProfilerReadResult): void {
  console.log(`profile react — ${read.totalCommits ?? 0} commit(s)`);
  console.log(`  ${'self'.padStart(9)} ${'total'.padStart(9)}  renders  component`);
  for (const t of read.top ?? []) {
    console.log(
      `  ${`${t.selfMs.toFixed(1)}ms`.padStart(9)} ${`${t.totalMs.toFixed(1)}ms`.padStart(9)}  ` +
        `${String(t.renders).padStart(7)}  ${t.name}`
    );
  }
  console.log(
    '  self is additive across components; total is subtree-inclusive and double-counts parents.'
  );

  const commits = read.commits ?? [];
  if (commits.length > 0) {
    const slowest = [...commits].sort((a, b) => b.durationMs - a.durationMs).slice(0, 5);
    const t0 = commits[0].at;
    console.log('\n  slowest commits');
    for (const c of slowest) {
      console.log(
        `    t+${((c.at - t0) / 1000).toFixed(2)}s  ${c.durationMs.toFixed(1)}ms  ` +
          `${c.componentCount} component(s)`
      );
    }
    console.log('  full per-commit timeline is in --json output (add --timeline for components).');
  }

  if ((read.skippedCommits ?? 0) > 0) {
    console.log(
      `\n  skipped ${read.skippedCommits} commit(s) whose root fiber carried no render start ` +
        'stamp — their work could not be told apart from earlier renders.'
    );
  }

  if (read.truncated) {
    console.log(
      `\n  TRUNCATED: dropped ${read.droppedCommits ?? 0} commit(s) beyond --max-commits ` +
        `${read.maxCommits} and ${read.droppedComponents ?? 0} component record(s) beyond ` +
        `--max-components ${read.maxComponents}. Raise those limits or profile a shorter window.`
    );
  }
}
