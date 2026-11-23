/**
 * Native CPU profiling bracketed by start/stop, for a flow you drive in between.
 *
 * iOS/tvOS simulators and macOS: `xctrace record --template 'Time Profiler'`
 * attached to the app's pid, stopped with SIGINT so xctrace finalises the
 * trace, then exported (`time-profile`, `potential-hangs`) and ranked here.
 * Android: on-device `simpleperf record --app`, stopped with SIGINT, then
 * symbolised on the device with `simpleperf report`.
 */
import { spawn } from 'child_process';
import { openSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { printData, printError, printSuccess, OutputOptions } from '../output.js';
import { detectPlatform } from '../drivers/bootstrap.js';
import { resolveAndroidTool, androidSpawnEnv } from '../android/sdk.js';
import { spawnCommand } from '../runner.js';
import { getSession } from '../session.js';
import { macAppPid } from '../drivers/macos.js';
import { round } from '../stats.js';
import { parseSimpleperfReport, rollupByDso } from './profile.js';
import type { NativeHang, NativeReport, NativeSymbol, NativeThread } from './profile-analyze.js';
import {
  ProfileMeta,
  openProfile,
  activeProfile,
  settleProfile,
  writeMeta,
  writeJson,
  readJson,
  readMeta,
  resolveProfileDir,
} from './profile-store.js';

// ── xctrace XML ───────────────────────────────────────────────────────────────

export interface XNode {
  tag: string;
  attrs: Record<string, string>;
  text: string;
  children: XNode[];
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) attrs[m[1]] = decodeEntities(m[2] ?? m[3] ?? '');
  return attrs;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export interface XTable {
  columns: string[];
  /** One entry per row: column mnemonic → value node (refs resolved), or null for a sentinel. */
  rows: Array<Record<string, XNode | null>>;
}

/**
 * Parse one `xctrace export --xpath …/table[@schema=…]` result. xctrace
 * deduplicates repeated values: the first occurrence carries `id="N"`, later
 * ones are `<tag ref="N"/>`. Refs are resolved to the original node here.
 */
export function parseXctraceTable(xml: string): XTable {
  const columns: string[] = [];
  const colRe = /<col>\s*<mnemonic>([^<]*)<\/mnemonic>/g;
  let cm: RegExpExecArray | null;
  while ((cm = colRe.exec(xml))) columns.push(cm[1]);

  const byId = new Map<string, XNode>();
  const rows: XTable['rows'] = [];
  const tokenRe = /<(\/?)([\w:-]+)([^>]*?)(\/?)>|([^<]+)/g;
  const stack: XNode[] = [];
  let inRow = false;
  let t: RegExpExecArray | null;
  while ((t = tokenRe.exec(xml))) {
    const [, closing, tag, rawAttrs, selfClosing, text] = t;
    if (text !== undefined) {
      if (inRow && stack.length > 0) stack[stack.length - 1].text += decodeEntities(text);
      continue;
    }
    if (tag === 'row') {
      if (closing) {
        const row = stack.pop()!;
        const rec: Record<string, XNode | null> = {};
        row.children.forEach((c, i) => {
          rec[columns[i] ?? `col${i}`] = c.tag === 'sentinel' ? null : c;
        });
        rows.push(rec);
        inRow = false;
      } else {
        inRow = true;
        stack.length = 0;
        stack.push({ tag, attrs: {}, text: '', children: [] });
      }
      continue;
    }
    if (!inRow || tag.startsWith('?')) continue;
    if (closing) {
      stack.pop();
      continue;
    }
    const attrs = parseAttrs(rawAttrs);
    let node: XNode;
    if (attrs.ref !== undefined) {
      node = byId.get(attrs.ref) ?? { tag, attrs, text: '', children: [] };
    } else {
      node = { tag, attrs, text: '', children: [] };
      if (attrs.id !== undefined) byId.set(attrs.id, node);
    }
    stack[stack.length - 1]?.children.push(node);
    if (!selfClosing && attrs.ref === undefined) stack.push(node);
    else if (!selfClosing) stack.push({ tag, attrs: {}, text: '', children: [] });
  }
  return { columns, rows };
}

/** "Main Thread (0x9a1296b) (ProfilingTest, pid: 48516)" → "Main Thread". */
export function threadName(fmt: string | undefined): string {
  if (!fmt) return '(unknown thread)';
  return fmt
    .replace(/\s*\(\S+, pid: \d+\)\s*$/, '')
    .replace(/\s*\(0x[0-9a-f]+\)\s*$/i, '')
    .trim();
}

interface XFrame {
  name: string;
  library: string;
  path?: string;
}

function framesOf(stack: XNode | null | undefined): XFrame[] {
  if (!stack) return [];
  return stack.children
    .filter((f) => f.tag === 'frame')
    .map((f) => {
      const bin = f.children.find((c) => c.tag === 'binary');
      return {
        name: f.attrs.name ?? f.attrs.addr ?? '?',
        library: bin?.attrs.name ?? '?',
        path: bin?.attrs.path,
      };
    });
}

/** React Native's own runtime ships inside the app bundle but is not the app's code. */
const RN_RUNTIME_LIB =
  /^(hermes|hermesvm|React|React-.*|ReactNative.*|RCT.*|yoga|folly|jsi|DYLD-STUB.*)$/i;

/** Bottom-of-stack frames every main-thread sample carries; they say nothing about the cost. */
const ENTRY_POINT = /(^|[\s.])main(\(\))?$|^start$|UIApplicationMain/;

/** The app's own code: anything shipped inside its bundle, not the OS or the RN runtime. */
function isAppBinary(f: XFrame, appExecutable?: string): boolean {
  if (appExecutable && f.library === appExecutable) return true;
  if (RN_RUNTIME_LIB.test(f.library)) return false;
  const p = f.path ?? '';
  return /\.app\//.test(p) && !/RuntimeRoot|\/System\/|\/usr\/lib\//.test(p);
}

/**
 * Rank a Time Profiler export. Self time goes to the leaf frame; `threads`
 * splits the same time by thread (main vs JS vs render), which is usually the
 * first question; `appFrames` credits each sample to the deepest frame in the
 * app's own binaries, so app code shows up even when the leaf is a system call.
 */
export function analyzeTimeProfile(
  tp: XTable,
  hangs: XTable | undefined,
  opts: { top: number; appExecutable?: string; trace: string; platform: string }
): NativeReport & { appFrames: NativeSymbol[] } {
  let totalNs = 0;
  let first = Infinity;
  let last = -Infinity;
  const self = new Map<string, { symbol: string; library: string; ns: number; app: boolean }>();
  const appSelf = new Map<string, { symbol: string; library: string; ns: number }>();
  const libs = new Map<string, number>();
  const threads = new Map<string, number>();
  const mainSamples: Array<{ t: number; ns: number; leaf: XFrame }> = [];

  for (const row of tp.rows) {
    const weight = Number(row.weight?.text ?? 0) || 1_000_000;
    const t = Number(row.time?.text ?? 0);
    first = Math.min(first, t);
    last = Math.max(last, t);
    totalNs += weight;
    const frames = framesOf(row.stack);
    const leaf = frames[0] ?? { name: '(no backtrace)', library: '?' };
    const key = `${leaf.name}\u0000${leaf.library}`;
    const slot = self.get(key) ?? {
      symbol: leaf.name,
      library: leaf.library,
      ns: 0,
      app: isAppBinary(leaf, opts.appExecutable),
    };
    slot.ns += weight;
    self.set(key, slot);
    libs.set(leaf.library, (libs.get(leaf.library) ?? 0) + weight);
    const th = threadName(row.thread?.attrs.fmt);
    threads.set(th, (threads.get(th) ?? 0) + weight);
    const appFrame = frames.find(
      (f) => isAppBinary(f, opts.appExecutable) && !ENTRY_POINT.test(f.name)
    );
    if (appFrame) {
      const k = `${appFrame.name}\u0000${appFrame.library}`;
      const s = appSelf.get(k) ?? { symbol: appFrame.name, library: appFrame.library, ns: 0 };
      s.ns += weight;
      appSelf.set(k, s);
    }
    if (th === 'Main Thread') mainSamples.push({ t, ns: weight, leaf });
  }

  const pct = (ns: number): number => (totalNs > 0 ? round((ns / totalNs) * 100) : 0);
  const ms = (ns: number): number => round(ns / 1e6);
  const symbols: NativeSymbol[] = [...self.values()]
    .sort((a, b) => b.ns - a.ns)
    .slice(0, opts.top)
    .map((s) => ({
      symbol: s.symbol,
      library: s.library,
      percent: pct(s.ns),
      selfMs: ms(s.ns),
      app: s.app,
    }));
  const appFrames: NativeSymbol[] = [...appSelf.values()]
    .sort((a, b) => b.ns - a.ns)
    .slice(0, opts.top)
    .map((s) => ({
      symbol: s.symbol,
      library: s.library,
      percent: pct(s.ns),
      selfMs: ms(s.ns),
      app: true,
    }));

  const hangList: NativeHang[] = [];
  for (const h of hangs?.rows ?? []) {
    const start = Number(h.start?.text ?? NaN);
    const dur = Number(h.duration?.text ?? NaN);
    if (!Number.isFinite(start) || !Number.isFinite(dur)) continue;
    const inHang = new Map<string, number>();
    for (const s of mainSamples) {
      if (s.t < start || s.t > start + dur) continue;
      inHang.set(s.leaf.name, (inHang.get(s.leaf.name) ?? 0) + s.ns);
    }
    hangList.push({
      startMs: ms(start - (Number.isFinite(first) ? first : 0)),
      durationMs: ms(dur),
      kind: h['hang-type']?.attrs.fmt ?? h['hang-type']?.text ?? 'hang',
      top: [...inHang.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([symbol, ns]) => ({ symbol, selfMs: ms(ns) })),
    });
  }

  const notes: string[] = [];
  if (tp.rows.length === 0) {
    notes.push(
      'No CPU samples: Time Profiler only samples running threads, so an idle app records nothing. ' +
        'Make sure the flow actually exercised the app while recording.'
    );
  }
  return {
    platform: opts.platform,
    tool: 'xctrace',
    trace: opts.trace,
    durationMs: Number.isFinite(first) ? ms(last - first) : 0,
    totalSamples: tp.rows.length,
    symbols,
    appFrames,
    libraries: [...libs.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([library, ns]) => ({ library, percent: pct(ns) })),
    threads: [...threads.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([name, ns]) => ({ name, percent: pct(ns), selfMs: ms(ns) })),
    hangs: hangList.sort((a, b) => b.durationMs - a.durationMs),
    notes,
  };
}

/** `simpleperf report --sort comm` → per-thread share. */
export function parseSimpleperfThreads(out: string): NativeThread[] {
  const lines = out.split(/\r?\n/);
  const header = lines.findIndex((l) => /^\s*Overhead\b/.test(l));
  if (header === -1) return [];
  const threads: NativeThread[] = [];
  for (const line of lines.slice(header + 1)) {
    const m = line.match(/^\s*([\d.]+)%\s+(.+?)\s*$/);
    if (m) threads.push({ name: m[2], percent: Number(m[1]) });
  }
  return threads;
}

// ── Recording ─────────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function simAppPid(udid: string, appId: string): Promise<number | undefined> {
  const list = await spawnCommand('xcrun', ['simctl', 'spawn', udid, 'launchctl', 'list']);
  if (!list.success) return undefined;
  for (const line of list.stdout.split('\n')) {
    if (!line.includes(`UIKitApplication:${appId}[`)) continue;
    const pid = Number(line.trim().split(/\s+/)[0]);
    if (Number.isFinite(pid) && pid > 0) return pid;
  }
  return undefined;
}

export interface NativeOptions {
  appId?: string;
  out?: string;
  top?: number;
}

async function startXctrace(
  meta: ProfileMeta,
  sessionName: string,
  platform: string,
  appId: string
): Promise<void> {
  const pid = platform === 'macos' ? await macAppPid(appId) : await simAppPid(sessionName, appId);
  if (pid === undefined) {
    throw new Error(
      `${appId} is not running on ${sessionName}` +
        (platform === 'macos' ? '' : ' (physical devices are not supported yet — use a simulator)')
    );
  }
  const trace = path.join(meta.dir, 'native.trace');
  await fs.rm(trace, { recursive: true, force: true });
  const log = path.join(meta.dir, 'native.log');
  const args = ['xctrace', 'record', '--template', 'Time Profiler', '--attach', String(pid)];
  if (platform !== 'macos') args.push('--device', sessionName);
  // A forgotten recording should not grow forever.
  args.push('--time-limit', '10m', '--output', trace, '--no-prompt');
  const fd = openSync(log, 'w');
  const child = spawn('xcrun', args, { detached: true, stdio: ['ignore', fd, fd] });
  child.unref();

  // Only report started once xctrace is actually recording.
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const text = await fs.readFile(log, 'utf8').catch(() => '');
    if (/Ctrl-C to stop|Starting recording/.test(text)) {
      meta.native = { state: 'recording', tool: 'xctrace', trace, pid: child.pid };
      return;
    }
    if (!alive(child.pid!)) throw new Error(`xctrace exited before recording:\n${text.trim()}`);
    await sleep(200);
  }
  try {
    process.kill(child.pid!, 'SIGINT');
  } catch {
    // already gone
  }
  throw new Error('xctrace did not start recording within 60s');
}

async function stopXctrace(meta: ProfileMeta): Promise<void> {
  const pid = meta.native!.pid!;
  if (alive(pid)) process.kill(pid, 'SIGINT');
  // Finalising a trace takes a while; xctrace exits once the file is saved.
  const deadline = Date.now() + 180_000;
  while (alive(pid) && Date.now() < deadline) await sleep(250);
  if (alive(pid)) throw new Error(`xctrace (pid ${pid}) did not finish saving within 180s`);
  const log = await fs.readFile(path.join(meta.dir, 'native.log'), 'utf8').catch(() => '');
  const saved = await fs
    .stat(meta.native!.trace)
    .then(() => true)
    .catch(() => false);
  if (!saved) throw new Error(`xctrace did not save a trace:\n${log.trim()}`);
}

async function exportTable(trace: string, schema: string): Promise<XTable | undefined> {
  const res = await spawnCommand('xcrun', [
    'xctrace',
    'export',
    '--input',
    trace,
    '--xpath',
    `/trace-toc/run[@number="1"]/data/table[@schema="${schema}"]`,
  ]);
  if (!res.success || !res.stdout.includes('<schema')) return undefined;
  return parseXctraceTable(res.stdout);
}

async function analyzeXctrace(meta: ProfileMeta, top: number): Promise<NativeReport> {
  const trace = meta.native!.trace;
  const tp = await exportTable(trace, 'time-profile');
  if (!tp) throw new Error(`could not export the time-profile table from ${trace}`);
  const hangs = await exportTable(trace, 'potential-hangs');
  // The app's executable name is the process name xctrace attached to.
  const log = await fs.readFile(path.join(meta.dir, 'native.log'), 'utf8').catch(() => '');
  const exe = log.match(/Attaching to: (.+?) \(\d+\)/)?.[1];
  return analyzeTimeProfile(tp, hangs, {
    top,
    appExecutable: exe,
    trace,
    platform: meta.platform ?? 'ios',
  });
}

function remotePerfPath(meta: ProfileMeta): string {
  return `/data/local/tmp/conductor-native-${path.basename(meta.dir).replace(/[^\w-]/g, '')}.data`;
}

async function startSimpleperf(meta: ProfileMeta, deviceId: string, appId: string): Promise<void> {
  const adb = resolveAndroidTool('adb');
  const env = androidSpawnEnv();
  const remote = remotePerfPath(meta);
  const log = path.join(meta.dir, 'native.log');

  // Returns the child once it has survived start-up, or the reason it died.
  const attempt = async (event?: string): Promise<{ pid?: number; error?: string }> => {
    const fd = openSync(log, 'w');
    const args = ['-s', deviceId, 'shell', 'simpleperf', 'record', '--app', appId];
    if (event) args.push('-e', event);
    // --duration caps a forgotten recording; SIGINT ends it early and still writes the file.
    args.push('-o', remote, '--duration', '600');
    const child = spawn(adb, args, { detached: true, stdio: ['ignore', fd, fd], env });
    child.unref();
    // simpleperf fails fast when the app is not debuggable/profileable or not running.
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      if (!alive(child.pid!)) {
        const text = await fs.readFile(log, 'utf8').catch(() => '');
        return {
          error: text
            .split(/\r?\n/)
            .filter((l) => l.trim() && !/cannot read event type|Failed to read event type/i.test(l))
            .slice(-4)
            .join('\n'),
        };
      }
      await sleep(250);
    }
    return { pid: child.pid };
  };

  let res = await attempt();
  // Emulators (and some devices) expose no hardware PMU; the cpu-clock software event works everywhere.
  if (res.error && /not supported/i.test(res.error)) res = await attempt('cpu-clock');
  if (res.error) {
    throw new Error(
      `simpleperf exited immediately.\n${res.error}` +
        (/not supported/i.test(res.error)
          ? ''
          : '\nIt needs a running app that is android:debuggable or declares ' +
            '`<profileable android:shell="true"/>`.')
    );
  }
  const child = { pid: res.pid };
  meta.native = {
    state: 'recording',
    tool: 'simpleperf',
    trace: path.join(meta.dir, 'native.perf.data'),
    pid: child.pid,
  };
}

async function stopSimpleperf(meta: ProfileMeta, deviceId: string): Promise<void> {
  const adb = resolveAndroidTool('adb');
  const env = androidSpawnEnv();
  const remote = remotePerfPath(meta);
  await spawnCommand(adb, ['-s', deviceId, 'shell', 'pkill', '-INT', '-f', remote], { env });
  const pid = meta.native!.pid!;
  const deadline = Date.now() + 60_000;
  while (alive(pid) && Date.now() < deadline) await sleep(250);
  const pull = await spawnCommand(adb, ['-s', deviceId, 'pull', remote, meta.native!.trace], {
    env,
  });
  if (!pull.success) {
    const log = await fs.readFile(path.join(meta.dir, 'native.log'), 'utf8').catch(() => '');
    throw new Error(`could not pull ${remote}: ${pull.stderr.trim()}\n${log.trim().slice(-500)}`);
  }
}

async function analyzeSimpleperf(
  meta: ProfileMeta,
  deviceId: string,
  top: number
): Promise<NativeReport> {
  const adb = resolveAndroidTool('adb');
  const env = androidSpawnEnv();
  const remote = remotePerfPath(meta);
  // Symbolise on the device: it has the exact libraries that were loaded.
  const report = (sort: string): Promise<{ success: boolean; stdout: string; stderr: string }> =>
    spawnCommand(
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
        sort,
        '--percent-limit',
        '0.1',
      ],
      { env }
    );
  const bySymbol = await report('dso,symbol');
  if (!bySymbol.success) {
    throw new Error(
      `simpleperf report failed on-device (${bySymbol.stderr.trim() || 'no output'}). ` +
        `The raw recording is at ${meta.native!.trace}.`
    );
  }
  const byThread = await report('comm');
  const entries = parseSimpleperfReport(bySymbol.stdout);
  const samples = Number(bySymbol.stdout.match(/^Samples:\s*(\d+)/m)?.[1] ?? NaN);
  const appLib = (dso: string): boolean =>
    /\/data\/app\//.test(dso) &&
    !/\/(libhermes|libreactnative|libjsi|libfbjni|libc\+\+_shared)/.test(dso);
  return {
    platform: 'android',
    tool: 'simpleperf',
    trace: meta.native!.trace,
    totalSamples: Number.isFinite(samples) ? samples : undefined,
    symbols: entries.slice(0, top).map((e) => ({
      symbol: e.symbol,
      library: e.dso.includes('/') ? e.dso.slice(e.dso.lastIndexOf('/') + 1) : e.dso,
      percent: e.percent,
      app: appLib(e.dso),
    })),
    libraries: rollupByDso(entries)
      .slice(0, 15)
      .map((d) => ({ library: d.dso, percent: d.percent })),
    threads: byThread.success ? parseSimpleperfThreads(byThread.stdout).slice(0, 15) : [],
    notes: [],
  };
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function resolveAppId(sessionName: string, appId?: string): Promise<string> {
  const id = appId ?? (await getSession(sessionName).catch(() => ({ appId: undefined }))).appId;
  if (!id)
    throw new Error(
      'no app to profile — pass <appId> or launch one with `conductor launch-app` first'
    );
  return id;
}

export async function startNativeProfile(
  sessionName: string,
  nOpts: NativeOptions
): Promise<ProfileMeta> {
  if (sessionName === 'default') throw new Error('requires a --device');
  const platform = await detectPlatform(sessionName).catch(() => undefined);
  if (!platform || !['ios', 'tvos', 'macos', 'android'].includes(platform)) {
    throw new Error(
      `not supported on ${platform ?? 'this device'} — native profiling covers iOS/tvOS ` +
        'simulators, macOS apps and Android'
    );
  }
  const appId = await resolveAppId(sessionName, nOpts.appId);
  const active = await activeProfile(sessionName);
  if (active?.native?.state === 'recording') {
    throw new Error(`already recording into ${active.dir} — run \`conductor profile native stop\``);
  }
  const meta = await openProfile(sessionName, { platform, appId, out: nOpts.out });
  meta.appId ??= appId;
  try {
    if (platform === 'android') await startSimpleperf(meta, sessionName, appId);
    else await startXctrace(meta, sessionName, platform, appId);
  } catch (err) {
    meta.native = undefined;
    await settleProfile(meta);
    throw err;
  }
  await writeMeta(meta);
  return meta;
}

export async function profileNativeStart(
  opts: OutputOptions,
  sessionName: string,
  nOpts: NativeOptions
): Promise<number> {
  try {
    const meta = await startNativeProfile(sessionName, nOpts);
    const tool = meta.native!.tool;
    if (opts.json) {
      printData(
        { status: 'ok', dir: meta.dir, tool, trace: meta.native!.trace, appId: meta.appId },
        opts
      );
    } else {
      printSuccess(`profile native start — ${tool} recording ${meta.appId}`, opts);
      console.log(`  profile → ${meta.dir}`);
      console.log('  drive the flow, then `conductor profile native stop`.');
    }
    return 0;
  } catch (err) {
    printError(`profile native start — ${err instanceof Error ? err.message : String(err)}`, opts);
    return 1;
  }
}

export async function stopNativeProfile(
  sessionName: string,
  top = 25
): Promise<{ meta: ProfileMeta; report: NativeReport }> {
  const meta = await activeProfile(sessionName);
  if (!meta?.native || meta.native.state !== 'recording') {
    throw new Error('not recording (run `conductor profile native start` first)');
  }
  try {
    if (meta.native.tool === 'simpleperf') await stopSimpleperf(meta, sessionName);
    else await stopXctrace(meta);
    meta.native.state = 'done';
  } catch (err) {
    meta.native.state = 'failed';
    meta.native.error = err instanceof Error ? err.message : String(err);
    await settleProfile(meta);
    throw err;
  }
  try {
    const report = await analyzeNative(meta, sessionName, top);
    return { meta, report };
  } finally {
    if (meta.native.tool === 'simpleperf') {
      await spawnCommand(
        resolveAndroidTool('adb'),
        ['-s', sessionName, 'shell', 'rm', '-f', remotePerfPath(meta)],
        { env: androidSpawnEnv() }
      );
    }
    await settleProfile(meta);
  }
}

export async function profileNativeStop(
  opts: OutputOptions,
  sessionName: string,
  nOpts: NativeOptions
): Promise<number> {
  try {
    const { meta, report } = await stopNativeProfile(sessionName, nOpts.top ?? 25);
    if (opts.json) printData({ status: 'ok', dir: meta.dir, ...report }, opts);
    else {
      printNativeReport(report, 10);
      console.log(`\n  profile → ${meta.dir}`);
      console.log(
        '  next: `conductor profile analyze` for ranked findings across React, JS and native.'
      );
    }
    return 0;
  } catch (err) {
    printError(`profile native stop — ${err instanceof Error ? err.message : String(err)}`, opts);
    return 1;
  }
}

/** Analyse (and cache) a finished native recording. */
export async function analyzeNative(
  meta: ProfileMeta,
  sessionName: string,
  top: number
): Promise<NativeReport> {
  const cache = path.join(meta.dir, 'native.json');
  const cached = await readJson<NativeReport>(cache);
  if (cached) return cached;
  const report =
    meta.native!.tool === 'simpleperf'
      ? await analyzeSimpleperf(meta, sessionName, top)
      : await analyzeXctrace(meta, top);
  await writeJson(cache, report);
  return report;
}

export async function profileNativeAnalyze(
  opts: OutputOptions,
  sessionName: string,
  nOpts: NativeOptions & { dir?: string }
): Promise<number> {
  try {
    const dir = await resolveProfileDir(sessionName, nOpts.dir);
    const meta = (await readMeta(dir))!;
    if (!meta.native || meta.native.state !== 'done') {
      throw new Error(`${dir} has no finished native recording`);
    }
    const report = await analyzeNative(meta, meta.session, nOpts.top ?? 25);
    if (opts.json) printData({ status: 'ok', dir, ...report }, opts);
    else printNativeReport(report, nOpts.top ?? 25);
    return 0;
  } catch (err) {
    printError(
      `profile native analyze — ${err instanceof Error ? err.message : String(err)}`,
      opts
    );
    return 1;
  }
}

export function printNativeReport(
  r: NativeReport & { appFrames?: NativeSymbol[] },
  top: number
): void {
  console.log(
    `profile native — ${r.tool}` +
      (r.durationMs ? `, ${(r.durationMs / 1000).toFixed(1)}s` : '') +
      (r.totalSamples !== undefined ? `, ${r.totalSamples} samples` : '')
  );
  if (r.threads.length) {
    console.log('\n  by thread');
    for (const t of r.threads.slice(0, 8))
      console.log(`  ${`${t.percent}%`.padStart(8)}  ${t.name}`);
  }
  if (r.symbols.length) {
    console.log('\n  hottest functions (self)');
    for (const s of r.symbols.slice(0, top)) {
      console.log(
        `  ${`${s.percent}%`.padStart(8)}  ${s.symbol}  [${s.library}]${s.app ? ' (app)' : ''}`
      );
    }
  }
  if (r.appFrames?.length) {
    console.log('\n  app code on the stack (deepest app frame per sample)');
    for (const s of r.appFrames.slice(0, Math.min(top, 10))) {
      console.log(`  ${`${s.percent}%`.padStart(8)}  ${s.symbol}  [${s.library}]`);
    }
  }
  if (r.hangs?.length) {
    console.log('\n  hangs');
    for (const h of r.hangs.slice(0, 5)) {
      console.log(
        `    t+${(h.startMs / 1000).toFixed(2)}s  ${h.durationMs}ms  ${h.kind}` +
          (h.top.length
            ? `  — ${h.top
                .map((x) => x.symbol)
                .slice(0, 3)
                .join(', ')}`
            : '')
      );
    }
  }
  for (const n of r.notes) console.log(`\n  note: ${n}`);
  console.log(`\n  trace → ${r.trace}`);
}
