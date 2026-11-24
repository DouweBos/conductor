/**
 * `profile launch` — cold-start timing.
 *
 * Android: force-stop, clear logcat, drop a marker, `am start -W`, then read
 * `Displayed` / `am_activity_fully_drawn_time` and any app marks from logcat.
 * iOS simulator: terminate, stream the app's unified log, `simctl launch`, and
 * time marks against the host clock (the simulator shares it).
 *
 * App marks are generic: `--mark-regex` with a `name` group (and optionally a
 * `time` group on the app's own clock) turns log lines into a phase table.
 */
import { spawn } from 'child_process';
import { printError, printData, OutputOptions } from '../output.js';
import { detectPlatform, detectDeviceKind } from '../drivers/bootstrap.js';
import { adb, adbShell } from '../android/device.js';
import { parseLogTime } from '../daemon/log-collector.js';
import { describe, Distribution, fmt } from '../stats.js';

export const HELP = `  profile launch [<appId>]             Cold-start timing (Android; iOS simulator: marks only)
    --runs <n>                         Repeat and report median/min/max (default 1)
    --mode launch|deeplink --url <u>   Launch from the launcher (default) or by opening a deep link
    --activity <name>                  Android: activity to start (default: the launcher activity)
    --mark-regex '<re>'                App log marks: a regex with a (?<name>…) group and an
                                       optional (?<time>…) ms group, e.g. 'PERFMARK (?<name>\\S+)'
    --until-mark <name>                Wait for this mark, and report time to it
    --duration <s>                     Seconds to keep reading logs after launch (default 3)
    --timeout <s>                      Give up waiting for --until-mark after N seconds (default 30)`;

// ── Parsing ───────────────────────────────────────────────────────────────────

/** `am start -W` output → its key/value fields (TotalTime, WaitTime, LaunchState, …). */
export function parseAmStart(text: string): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const line of text.split('\n')) {
    const m = /^\s*(ThisTime|TotalTime|WaitTime|LaunchState|Status|Activity|Error):\s*(.*)$/.exec(
      line
    );
    const value = m?.[2].trim();
    if (m && value) out[m[1]] = /^\d+$/.test(value) ? Number(value) : value;
  }
  return out;
}

// Days before each month. Year and timezone cancel out: only deltas are used.
const CUM_DAYS = [0, 0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

// 09-01 22:32:25.743  4866  4866 I Tag: message
const LOGCAT_RE =
  /^(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})\s+(\d+)\s+(\d+)\s+[VDIWEFS]\s+(.*?):\s?(.*)$/;

export interface LogcatLine {
  ms: number;
  pid: number;
  tag: string;
  message: string;
}

export function parseLogcatLine(line: string): LogcatLine | null {
  const m = LOGCAT_RE.exec(line.replace(/\r$/, ''));
  if (!m) return null;
  const days = CUM_DAYS[Number(m[1])] + Number(m[2]) - 1;
  const ms =
    ((days * 24 + Number(m[3])) * 60 + Number(m[4])) * 60_000 + Number(m[5]) * 1000 + Number(m[6]);
  return { ms, pid: Number(m[7]), tag: m[9].trim(), message: m[10] };
}

/** "+1s261ms" → 1261. */
export function parsePlusDuration(s: string): number | null {
  const m = /\+(?:(\d+)s)?(\d+)ms/.exec(s);
  return m ? Number(m[1] ?? 0) * 1000 + Number(m[2]) : null;
}

export interface LaunchMark {
  name: string;
  /** ms since the launch was issued. */
  atMs: number;
  /** ms since the previous mark (or the launch). */
  deltaMs: number;
  /** The mark's own `time` group, on the app's clock, when the regex has one. */
  appMs?: number;
}

export interface LaunchTimeline {
  procStartMs: number | null;
  displayedMs: number | null;
  fullyDrawnMs: number | null;
  marks: LaunchMark[];
}

/** Compile `--mark-regex`; marks without a `name` group use the first group, then the match. */
export function compileMarkRegex(src: string | undefined): RegExp | undefined {
  return src ? new RegExp(src) : undefined;
}

export function matchMark(re: RegExp, text: string): { name: string; appMs?: number } | null {
  const m = re.exec(text);
  if (!m) return null;
  const name = m.groups?.name ?? m[1] ?? m[0];
  const t = m.groups?.time !== undefined ? Number(m.groups.time) : undefined;
  return { name, appMs: t !== undefined && Number.isFinite(t) ? t : undefined };
}

/** Order marks, keep each name's first occurrence, fill in deltas. */
export function buildMarks(
  raw: Array<{ name: string; atMs: number; appMs?: number }>
): LaunchMark[] {
  const seen = new Set<string>();
  const sorted = [...raw]
    .sort((a, b) => a.atMs - b.atMs)
    .filter((m) => {
      if (seen.has(m.name)) return false;
      seen.add(m.name);
      return true;
    });
  let prev = 0;
  return sorted.map((m) => {
    const out: LaunchMark = { name: m.name, atMs: m.atMs, deltaMs: m.atMs - prev };
    if (m.appMs !== undefined) out.appMs = m.appMs;
    prev = m.atMs;
    return out;
  });
}

export const LAUNCH_MARKER = 'conductor-launch-start';

/**
 * Read a launch out of `logcat -v threadtime -b main -b events`. Times are
 * relative to our `log -t conductor` marker when present (written right before
 * `am start`), else to the app's process start.
 */
export function parseAndroidLaunch(logcat: string, pkg: string, markRe?: RegExp): LaunchTimeline {
  const lines = logcat
    .split('\n')
    .map(parseLogcatLine)
    .filter((l): l is LogcatLine => !!l);
  const anchorLine = lines.find((l) => l.tag === 'conductor' && l.message.includes(LAUNCH_MARKER));
  const procLine = lines.find(
    (l) =>
      (l.tag === 'am_proc_start' && l.message.split(',').some((f) => f.trim() === pkg)) ||
      (l.tag.startsWith('ActivityManager') &&
        new RegExp(`Start proc \\d+:${escapeRe(pkg)}/`).test(l.message))
  );
  const t0 = anchorLine?.ms ?? procLine?.ms ?? lines[0]?.ms ?? 0;
  const comp = new RegExp(`^${escapeRe(pkg)}/`);

  let displayedMs: number | null = null;
  let fullyDrawnMs: number | null = null;
  const raw: Array<{ name: string; atMs: number; appMs?: number }> = [];
  for (const l of lines) {
    if (displayedMs === null) {
      const d = /^Displayed\s+(\S+?):?\s/.exec(l.message);
      if (d && comp.test(d[1])) displayedMs = parsePlusDuration(l.message);
    }
    if (fullyDrawnMs === null) {
      if (l.tag === 'am_activity_fully_drawn_time') {
        const f = /^\[(.*)\]\s*$/
          .exec(l.message)?.[1]
          .split(',')
          .map((s) => s.trim());
        if (f && f.some((x) => comp.test(x) || x.startsWith(`${pkg}/`))) {
          const v = Number(f[f.length - 1]);
          if (Number.isFinite(v)) fullyDrawnMs = v;
        }
      } else {
        const fd = /^Fully drawn\s+(\S+?):?\s/.exec(l.message);
        if (fd && comp.test(fd[1])) fullyDrawnMs = parsePlusDuration(l.message);
      }
    }
    if (markRe) {
      const m = matchMark(markRe, l.message);
      if (m) raw.push({ name: m.name, atMs: l.ms - t0, appMs: m.appMs });
    }
  }
  return {
    procStartMs: procLine ? procLine.ms - t0 : null,
    displayedMs,
    fullyDrawnMs,
    marks: buildMarks(raw),
  };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Aggregation ───────────────────────────────────────────────────────────────

export interface LaunchRun {
  run: number;
  launchState?: string;
  totalTimeMs?: number;
  waitTimeMs?: number;
  /** iOS: time until `simctl launch` returned (process spawned). */
  spawnMs?: number;
  procStartMs: number | null;
  displayedMs: number | null;
  fullyDrawnMs: number | null;
  untilMarkMs?: number | null;
  marks: LaunchMark[];
}

export type LaunchSummary = Record<string, Distribution>;

const RUN_METRICS: Array<[keyof LaunchRun, string]> = [
  ['totalTimeMs', 'TotalTime (am start)'],
  ['waitTimeMs', 'WaitTime (am start)'],
  ['spawnMs', 'process spawned'],
  ['procStartMs', 'process start'],
  ['displayedMs', 'Displayed (first frame)'],
  ['fullyDrawnMs', 'fully drawn'],
  ['untilMarkMs', 'until mark'],
];

/** Per-metric distributions across runs; marks keyed `mark:<name>` by their atMs. */
export function summariseLaunchRuns(runs: LaunchRun[]): LaunchSummary {
  const out: LaunchSummary = {};
  for (const [key] of RUN_METRICS) {
    const vals = runs.map((r) => r[key]).filter((v): v is number => typeof v === 'number');
    if (vals.length) out[key] = describe(vals);
  }
  const names: string[] = [];
  for (const r of runs) for (const m of r.marks) if (!names.includes(m.name)) names.push(m.name);
  for (const name of names) {
    const vals = runs.flatMap((r) => r.marks.filter((m) => m.name === name).map((m) => m.atMs));
    out[`mark:${name}`] = describe(vals);
  }
  return out;
}

// ── Device runners ────────────────────────────────────────────────────────────

export interface LaunchOptions {
  runs?: number;
  mode?: string;
  url?: string;
  activity?: string;
  markRegex?: string;
  untilMark?: string;
  duration?: number;
  timeout?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function resolveLauncherActivity(serial: string, pkg: string): Promise<string | undefined> {
  for (const cat of [
    'android.intent.category.LAUNCHER',
    'android.intent.category.LEANBACK_LAUNCHER',
  ]) {
    const r = await adbShell(serial, [
      'cmd',
      'package',
      'resolve-activity',
      '--brief',
      '-c',
      cat,
      pkg,
    ]);
    const last = r.stdout.trim().split('\n').pop()?.trim();
    if (r.success && last && last.includes('/')) return last;
  }
  return undefined;
}

async function readLogcat(serial: string): Promise<string> {
  return (
    await adb(serial, [
      'logcat',
      '-d',
      '-v',
      'threadtime',
      '-b',
      'main',
      '-b',
      'events',
      '-b',
      'system',
    ])
  ).stdout;
}

async function androidRun(
  serial: string,
  pkg: string,
  component: string | undefined,
  o: LaunchOptions,
  markRe: RegExp | undefined,
  run: number
): Promise<LaunchRun> {
  await adbShell(serial, ['am', 'force-stop', pkg]);
  await adb(serial, ['logcat', '-c', '-b', 'main', '-b', 'events', '-b', 'system']);
  await adbShell(serial, ['log', '-t', 'conductor', LAUNCH_MARKER]);

  const startArgs =
    o.mode === 'deeplink'
      ? ['am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', `'${o.url}'`, pkg]
      : ['am', 'start', '-W', '-n', component!];
  const am = await adbShell(serial, startArgs);
  const fields = parseAmStart(am.stdout);
  if (fields.Error || /Error:/.test(am.stdout + am.stderr)) {
    throw new Error(
      `am start failed: ${String(fields.Error ?? am.stderr.trim() ?? am.stdout.trim())}`
    );
  }

  let timeline = parseAndroidLaunch('', pkg, markRe);
  if (o.untilMark) {
    const deadline = Date.now() + (o.timeout ?? 30) * 1000;
    while (Date.now() < deadline) {
      timeline = parseAndroidLaunch(await readLogcat(serial), pkg, markRe);
      if (timeline.marks.some((m) => m.name === o.untilMark)) break;
      await sleep(500);
    }
  } else {
    await sleep((o.duration ?? 3) * 1000);
    timeline = parseAndroidLaunch(await readLogcat(serial), pkg, markRe);
  }

  return {
    run,
    launchState: typeof fields.LaunchState === 'string' ? fields.LaunchState : undefined,
    totalTimeMs: typeof fields.TotalTime === 'number' ? fields.TotalTime : undefined,
    waitTimeMs: typeof fields.WaitTime === 'number' ? fields.WaitTime : undefined,
    ...timeline,
    ...(o.untilMark
      ? { untilMarkMs: timeline.marks.find((m) => m.name === o.untilMark)?.atMs ?? null }
      : {}),
  };
}

function exec(
  cmd: string,
  args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    p.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    p.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    p.on('error', (e) => resolve({ code: 1, stdout, stderr: e.message }));
  });
}

async function iosSimRun(
  udid: string,
  bundleId: string,
  o: LaunchOptions,
  markRe: RegExp | undefined,
  run: number
): Promise<LaunchRun> {
  await exec('xcrun', ['simctl', 'terminate', udid, bundleId]);
  const procName = bundleId.split('.').pop()!;
  const raw: Array<{ name: string; atMs: number; appMs?: number }> = [];
  let t0 = 0;
  let buffer = '';
  const stream = spawn(
    'xcrun',
    [
      'simctl',
      'spawn',
      udid,
      'log',
      'stream',
      '--style',
      'ndjson',
      '--level',
      'debug',
      '--predicate',
      `process CONTAINS "${procName}"`,
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] }
  );
  stream.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf-8');
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!markRe || !t0) continue;
      try {
        const d = JSON.parse(line) as { timestamp?: string; eventMessage?: string };
        if (!d.eventMessage) continue;
        const m = matchMark(markRe, d.eventMessage);
        if (!m) continue;
        const ts = d.timestamp ? parseLogTime(d.timestamp) : NaN;
        raw.push({
          name: m.name,
          atMs: Math.round((Number.isFinite(ts) ? ts : Date.now()) - t0),
          appMs: m.appMs,
        });
      } catch {
        /* header line */
      }
    }
  });
  try {
    await sleep(800);
    t0 = Date.now();
    const launch =
      o.mode === 'deeplink'
        ? await exec('xcrun', ['simctl', 'openurl', udid, o.url!])
        : await exec('xcrun', ['simctl', 'launch', udid, bundleId]);
    if (launch.code !== 0) throw new Error(`simctl launch failed: ${launch.stderr.trim()}`);
    const spawnMs = Date.now() - t0;

    if (o.untilMark) {
      const deadline = Date.now() + (o.timeout ?? 30) * 1000;
      while (Date.now() < deadline && !raw.some((m) => m.name === o.untilMark)) await sleep(200);
      await sleep(300);
    } else {
      await sleep((o.duration ?? 3) * 1000);
    }
    const marks = buildMarks(raw);
    return {
      run,
      spawnMs,
      procStartMs: null,
      displayedMs: null,
      fullyDrawnMs: null,
      marks,
      ...(o.untilMark
        ? { untilMarkMs: marks.find((m) => m.name === o.untilMark)?.atMs ?? null }
        : {}),
    };
  } finally {
    stream.kill('SIGTERM');
  }
}

// ── Command ───────────────────────────────────────────────────────────────────

function printLaunch(
  appId: string,
  platform: string,
  o: LaunchOptions,
  runs: LaunchRun[],
  summary: LaunchSummary
): void {
  console.log(
    `profile launch — ${appId} (${platform}, ${o.mode === 'deeplink' ? `deep link ${o.url}` : 'cold launch'}, ${runs.length} run${runs.length === 1 ? '' : 's'})`
  );
  if (runs.length === 1) {
    const r = runs[0];
    for (const [key, label] of RUN_METRICS) {
      const v = r[key];
      if (typeof v === 'number' || (key === 'untilMarkMs' && o.untilMark)) {
        console.log(`  ${label.padEnd(26)} ${fmt(v as number | null)}`);
      }
    }
    if (r.launchState) console.log(`  ${'launch state'.padEnd(26)} ${r.launchState}`);
    if (r.marks.length) {
      console.log(`\n  ${'mark'.padEnd(40)} ${'at'.padStart(9)} ${'Δ'.padStart(9)}`);
      for (const m of r.marks) {
        console.log(
          `  ${m.name.padEnd(40)} ${`${m.atMs}ms`.padStart(9)} ${`+${m.deltaMs}ms`.padStart(9)}`
        );
      }
    }
  } else {
    console.log(
      `\n  ${'metric'.padEnd(40)} ${'median'.padStart(9)} ${'min'.padStart(9)} ${'max'.padStart(9)}`
    );
    for (const [key, d] of Object.entries(summary)) {
      const label = RUN_METRICS.find(([k]) => k === key)?.[1] ?? key;
      console.log(
        `  ${label.padEnd(40)} ${fmt(d.p50Ms).padStart(9)} ${fmt(d.minMs).padStart(9)} ${fmt(d.maxMs).padStart(9)}`
      );
    }
  }
  if (o.markRegex && runs.every((r) => r.marks.length === 0)) {
    console.log('\n  (no log line matched --mark-regex)');
  }
  if (o.untilMark && runs.some((r) => r.untilMarkMs === null)) {
    console.log(`\n  (mark "${o.untilMark}" not seen in some runs; raise --timeout?)`);
  }
}

export async function profileLaunch(
  appIdArg: string | undefined,
  opts: OutputOptions,
  sessionName: string,
  o: LaunchOptions
): Promise<number> {
  if (!appIdArg) {
    printError('profile launch requires an <appId> (package / bundle id)', opts);
    return 1;
  }
  if (sessionName === 'default') {
    const { detectFirstDevice } = await import('../runner.js');
    const detected = await detectFirstDevice().catch(() => undefined);
    if (!detected) {
      printError('profile launch requires a --device', opts);
      return 1;
    }
    sessionName = detected;
  }
  const mode = o.mode ?? 'launch';
  if (mode !== 'launch' && mode !== 'deeplink') {
    printError('profile launch — --mode must be launch or deeplink', opts);
    return 1;
  }
  if (mode === 'deeplink' && !o.url) {
    printError('profile launch — --mode deeplink needs --url <link>', opts);
    return 1;
  }
  let markRe: RegExp | undefined;
  try {
    markRe = compileMarkRegex(o.markRegex);
  } catch (err) {
    printError(
      `profile launch — invalid --mark-regex: ${err instanceof Error ? err.message : String(err)}`,
      opts
    );
    return 1;
  }
  if (o.untilMark && !markRe) {
    printError('profile launch — --until-mark needs --mark-regex', opts);
    return 1;
  }

  const runsWanted = Math.max(1, o.runs ?? 1);
  const platform = await detectPlatform(sessionName).catch(() => 'unknown');
  const runs: LaunchRun[] = [];
  try {
    if (platform === 'android') {
      const component =
        mode === 'launch'
          ? o.activity
            ? o.activity.includes('/')
              ? o.activity
              : `${appIdArg}/${o.activity}`
            : await resolveLauncherActivity(sessionName, appIdArg)
          : undefined;
      if (mode === 'launch' && !component) {
        throw new Error(`could not resolve ${appIdArg}'s launcher activity; pass --activity`);
      }
      for (let i = 1; i <= runsWanted; i++) {
        if (!opts.json && runsWanted > 1) process.stderr.write(`run ${i}/${runsWanted}…\n`);
        runs.push(await androidRun(sessionName, appIdArg, component, { ...o, mode }, markRe, i));
      }
    } else if (platform === 'ios' || platform === 'tvos' || platform === 'watchos') {
      if ((await detectDeviceKind(sessionName)) === 'physical') {
        throw new Error(
          'profile launch supports Android and iOS/tvOS simulators; physical devices are not supported yet'
        );
      }
      for (let i = 1; i <= runsWanted; i++) {
        if (!opts.json && runsWanted > 1) process.stderr.write(`run ${i}/${runsWanted}…\n`);
        runs.push(await iosSimRun(sessionName, appIdArg, { ...o, mode }, markRe, i));
      }
    } else {
      throw new Error(`not supported on platform ${platform}`);
    }
  } catch (err) {
    printError(`profile launch — ${err instanceof Error ? err.message : String(err)}`, opts);
    return 1;
  }

  const summary = summariseLaunchRuns(runs);
  if (opts.json) printData({ appId: appIdArg, platform, mode, runs, summary }, opts);
  else printLaunch(appIdArg, platform, { ...o, mode }, runs, summary);
  return 0;
}
