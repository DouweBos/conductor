/**
 * `profile react start|stop|renders|cpu` and `profile analyze`: the React
 * commit profiler and the Hermes sampler recorded together into one profile
 * directory (see profile-store.ts), then analysed offline.
 *
 * Commit data lives in the app's JS runtime, not in the debugger session, so it
 * survives a dropped CDP connection (some tvOS apps drop it on navigation); the sampler
 * holder re-attaches on its own. Only a JS reload loses the recording, and
 * `stop` says so.
 */
import os from 'node:os';
import path from 'node:path';
import { printData, printError, printSuccess, OutputOptions } from '../output.js';
import { detectPlatform } from '../drivers/bootstrap.js';
import { MetroCdpClient } from '../drivers/metro-cdp.js';
import { round } from '../stats.js';
import {
  REACT_PROFILER_INSTALL,
  REACT_PROFILER_READ,
  REACT_PROFILER_STOP,
  NO_PROFILING_BUILD,
  ReactProfilerReadResult,
  ReactProfilerStartResult,
  printReactReport,
} from './profile.js';
import {
  CdpOpts,
  HolderDone,
  JsProfileSummary,
  analyzeCpuProfiles,
  connectMetro,
  loadSegments,
  printGaps,
  printSummary,
  startJsHolder,
  stopJsHolder,
  symbolicateStats,
} from './profile-js.js';
import {
  AnalyzeInput,
  Finding,
  ProfileBaseline,
  RendersReport,
  buildFindings,
  computeRenders,
  diffBaselines,
  toBaseline,
  BaselineDelta,
} from './profile-analyze.js';
import {
  ProfileMeta,
  activeProfile,
  openProfile,
  readJson,
  readMeta,
  resolveProfileDir,
  settleProfile,
  writeJson,
  writeMeta,
} from './profile-store.js';
import { analyzeNative, printNativeReport } from './profile-native.js';
import { getSession } from '../session.js';

export interface ReactStartOptions extends CdpOpts {
  maxCommits?: number;
  maxComponents?: number;
  /** Record host elements (View, Text…) too. */
  includeHosts?: boolean;
  /** Also run the Hermes sampler (default true). */
  cpu?: boolean;
  /** Profile directory to write (default under ~/.conductor/profiles). */
  out?: string;
}

export interface ReactStopOptions {
  top?: number;
  timeline?: boolean;
  symbolicate?: boolean;
}

const RE_ATTACH_MS = 20_000;

/** Attach to the recording's own target; retry while a dropped session comes back. */
async function connectPinned(
  sessionName: string,
  meta: ProfileMeta,
  budgetMs = RE_ATTACH_MS
): Promise<MetroCdpClient> {
  const pin = meta.target;
  const until = Date.now() + budgetMs;
  let lastErr: unknown;
  do {
    try {
      return await connectMetro(sessionName, {
        port: pin?.port,
        appId: pin?.appId,
        logicalDeviceId: pin?.logicalDeviceId,
      });
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 500));
    }
  } while (Date.now() < until);
  throw lastErr;
}

// ── start ─────────────────────────────────────────────────────────────────────

export async function startReactProfile(
  sessionName: string,
  o: ReactStartOptions
): Promise<{ meta: ProfileMeta; install: ReactProfilerStartResult }> {
  const active = await activeProfile(sessionName);
  if (active?.react?.state === 'recording') {
    throw new Error(
      `already profiling into ${active.dir} (since ${active.startedAt}) — run ` +
        '`conductor profile react stop` first'
    );
  }
  const platform = await detectPlatform(sessionName).catch(() => undefined);
  let client: MetroCdpClient | undefined;
  try {
    client = await connectMetro(sessionName, o);
    const t = client.target!;
    // Discard a hook left behind by an earlier run that never stopped.
    await client.evaluate(REACT_PROFILER_STOP).catch(() => undefined);
    const install = await client.evaluate<ReactProfilerStartResult>(
      REACT_PROFILER_INSTALL(o.maxCommits ?? 2000, o.maxComponents ?? 1000, o.includeHosts)
    );
    if (!install.installed) throw new Error(install.error ?? 'install failed');
    if (install.profilingSupported === false) {
      await client.evaluate(REACT_PROFILER_STOP);
      throw new Error(NO_PROFILING_BUILD);
    }

    const sessionApp = (await getSession(sessionName).catch(() => ({ appId: undefined }))).appId;
    const meta = await openProfile(sessionName, {
      platform,
      appId: t.appId ?? t.description ?? sessionApp,
      out: o.out,
    });
    meta.target = {
      port: Number(new URL(t.webSocketDebuggerUrl!).port) || o.port || 8081,
      pageId: t.id,
      appId: t.appId ?? t.description,
      logicalDeviceId: t.reactNative?.logicalDeviceId,
      deviceName: t.deviceName,
      title: t.title,
    };
    if (o.port !== undefined) meta.target.port = o.port;
    const cpu = o.cpu !== false;
    meta.react = { state: 'recording', cpu };
    await writeMeta(meta);

    if (cpu) {
      try {
        await startJsHolder(sessionName, {
          port: meta.target.port,
          pageId: t.id,
          out: path.join(meta.dir, 'cpu.cpuprofile'),
        });
      } catch (err) {
        await client.evaluate(REACT_PROFILER_STOP).catch(() => undefined);
        meta.react = undefined;
        await settleProfile(meta);
        throw new Error(
          `the React hook installed but the Hermes sampler did not start: ` +
            `${err instanceof Error ? err.message : String(err)} (pass --no-cpu to profile renders only)`
        );
      }
    }
    return { meta, install };
  } finally {
    client?.close();
  }
}

export async function profileReactStart(
  opts: OutputOptions,
  sessionName: string,
  o: ReactStartOptions
): Promise<number> {
  try {
    const { meta, install } = await startReactProfile(sessionName, o);
    if (opts.json) {
      printData(
        {
          status: 'ok',
          dir: meta.dir,
          startedAt: meta.startedAt,
          cpu: meta.react!.cpu,
          target: meta.target,
          renderers: install.renderers,
          profilingSupported: install.profilingSupported,
        },
        opts
      );
    } else {
      printSuccess(
        `profile react start — recording React commits${meta.react!.cpu ? ' + Hermes CPU samples' : ''}`,
        opts
      );
      const t = meta.target!;
      console.log(
        `  target: ${t.appId ?? '(app)'} on ${t.deviceName ?? '(device)'}  page=${t.pageId}` +
          (t.logicalDeviceId ? `  device=${t.logicalDeviceId}` : '')
      );
      console.log(`  profile → ${meta.dir}`);
      if (install.profilingSupported === null) {
        console.log(
          '  note: nothing has rendered yet, so the build could not be checked for profiling ' +
            'support. `profile react stop` will say so if it turns out to be a release build.'
        );
      }
      console.log('  drive the flow, then `conductor profile react stop`.');
    }
    return 0;
  } catch (err) {
    printError(`profile react start — ${err instanceof Error ? err.message : String(err)}`, opts);
    return 1;
  }
}

// ── stop ──────────────────────────────────────────────────────────────────────

export interface ReactStopResult {
  meta: ProfileMeta;
  read?: ReactProfilerReadResult;
  cpu?: JsProfileSummary;
  cpuDone?: HolderDone;
  reactError?: string;
  cpuError?: string;
}

/**
 * Collect everything and write it to the profile directory. Always stops the
 * sampler, even when the React data turns out to be lost.
 */
export async function stopReactProfile(
  sessionName: string,
  o: ReactStopOptions = {}
): Promise<ReactStopResult> {
  const meta = await activeProfile(sessionName);
  if (!meta?.react || meta.react.state !== 'recording') {
    throw new Error('not profiling (run `conductor profile react start` first)');
  }
  const result: ReactStopResult = { meta };

  let client: MetroCdpClient | undefined;
  try {
    client = await connectPinned(sessionName, meta);
    const read = await client.evaluate<ReactProfilerReadResult>(
      REACT_PROFILER_READ(o.top ?? 20, true)
    );
    await client.evaluate(REACT_PROFILER_STOP).catch(() => undefined);
    if (!read.installed) {
      result.reactError =
        'the commit hook is gone — the JS bundle reloaded (Fast Refresh full reload, `metro reload`, ' +
        'or an app restart) while recording, which discards everything held in the runtime';
    } else if (read.profilingSupported === false) {
      result.reactError = NO_PROFILING_BUILD;
    } else {
      result.read = read;
      await writeJson(path.join(meta.dir, 'react.json'), read);
    }
  } catch (err) {
    result.reactError = `could not re-attach to the app: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    client?.close();
  }

  if (meta.react.cpu) {
    try {
      const done = await stopJsHolder(sessionName);
      result.cpuDone = done;
      await writeJson(path.join(meta.dir, 'cpu.json'), done);
      const profiles = await loadSegments(done);
      const summary = analyzeCpuProfiles(profiles, 200);
      if (o.symbolicate !== false) {
        const cacheFile = path.join(meta.dir, 'symbols.json');
        const cache = (await readJson<Record<string, string | null>>(cacheFile)) ?? {};
        await writeJson(cacheFile, await symbolicateStats(summary.top, cache));
      }
      result.cpu = summary;
      if (done.error) result.cpuError = done.error;
    } catch (err) {
      result.cpuError = err instanceof Error ? err.message : String(err);
    }
  }

  meta.react.state = result.read ? 'done' : 'lost';
  if (result.reactError) meta.react.error = result.reactError;
  await settleProfile(meta);
  return result;
}

export async function profileReactStop(
  opts: OutputOptions,
  sessionName: string,
  o: ReactStopOptions
): Promise<number> {
  try {
    const r = await stopReactProfile(sessionName, o);
    const top = o.top ?? 20;
    if (opts.json) {
      const read = r.read
        ? {
            ...r.read,
            commits: o.timeline
              ? r.read.commits
              : r.read.commits?.map(({ components: _c, ...c }) => c),
          }
        : undefined;
      printData(
        {
          status: r.read ? 'ok' : 'error',
          dir: r.meta.dir,
          ...(read ?? {}),
          reactError: r.reactError,
          cpu: r.cpu ? { ...r.cpu, top: r.cpu.top.slice(0, top) } : undefined,
          cpuGaps: r.cpuDone?.gaps,
          cpuError: r.cpuError,
        },
        opts
      );
    } else {
      if (r.read) {
        if ((r.read.totalCommits ?? 0) === 0) {
          console.log(
            'profile react — no commits were captured: nothing re-rendered while recording.'
          );
        } else printReactReport(r.read);
      } else console.error(`profile react stop — React data lost: ${r.reactError}`);
      if (r.cpu) {
        console.log('');
        printSummary(
          { ...r.cpu, top: r.cpu.top.slice(0, 10), omitted: 0 },
          r.cpuDone!.out!,
          'Hermes CPU'
        );
        printGaps(r.cpuDone?.gaps ?? []);
      } else if (r.cpuError) console.error(`  Hermes CPU: ${r.cpuError}`);
      console.log(`\n  profile → ${r.meta.dir}`);
      console.log(
        '  next: `conductor profile react renders`, `profile react cpu`, `profile analyze`.'
      );
    }
    return r.read ? 0 : 1;
  } catch (err) {
    printError(`profile react stop — ${err instanceof Error ? err.message : String(err)}`, opts);
    return 1;
  }
}

// ── offline readers ───────────────────────────────────────────────────────────

interface LoadedProfile {
  dir: string;
  meta: ProfileMeta;
  react?: ReactProfilerReadResult;
  cpuDone?: HolderDone;
}

async function loadProfile(sessionName: string, dir?: string): Promise<LoadedProfile> {
  const d = await resolveProfileDir(sessionName, dir);
  const meta = (await readMeta(d))!;
  return {
    dir: d,
    meta,
    react: (await readJson<ReactProfilerReadResult>(path.join(d, 'react.json'))) ?? undefined,
    cpuDone: (await readJson<HolderDone>(path.join(d, 'cpu.json'))) ?? undefined,
  };
}

async function cpuSummary(p: LoadedProfile, top: number): Promise<JsProfileSummary | undefined> {
  if (!p.cpuDone) return undefined;
  const summary = analyzeCpuProfiles(await loadSegments(p.cpuDone), top);
  const file = path.join(p.dir, 'symbols.json');
  const cache = (await readJson<Record<string, string | null>>(file)) ?? {};
  // Fills in anything `stop` could not map (Metro was down); a no-op when all are cached.
  await writeJson(file, await symbolicateStats(summary.top.slice(0, 200), cache, 15_000));
  return summary;
}

export interface RendersOptions {
  dir?: string;
  top?: number;
  filter?: string;
  includeHost?: boolean;
}

export async function profileReactRenders(
  opts: OutputOptions,
  sessionName: string,
  o: RendersOptions
): Promise<number> {
  try {
    const p = await loadProfile(sessionName, o.dir);
    if (!p.react)
      throw new Error(
        `${p.dir} has no React data${p.meta.react?.error ? ` (${p.meta.react.error})` : ''}`
      );
    const report = computeRenders(p.react, { includeHost: o.includeHost });
    const re = o.filter ? new RegExp(o.filter, 'i') : undefined;
    const comps = report.components.filter((c) => !re || re.test(c.name));
    const top = o.top ?? 25;
    if (opts.json) {
      printData(
        {
          status: 'ok',
          dir: p.dir,
          ...report,
          components: comps.slice(0, top),
          omitted: Math.max(0, comps.length - top),
        },
        opts
      );
      return 0;
    }
    console.log(
      `profile react renders — ${report.totalCommits} commit(s) over ${(report.durationMs / 1000).toFixed(1)}s, ` +
        `${comps.length} component(s)${re ? ` matching /${o.filter}/` : ''}`
    );
    console.log(
      `\n  ${'renders'.padStart(7)} ${'commits'.padStart(7)} ${'self'.padStart(9)} ${'max'.padStart(8)}  component  (why)`
    );
    for (const c of comps.slice(0, top)) {
      const why = Object.entries(c.reasons)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k} ${v}`)
        .join(', ');
      console.log(
        `  ${String(c.renders).padStart(7)} ${`${Math.round(c.commitShare * 100)}%`.padStart(7)} ` +
          `${`${c.selfMs}ms`.padStart(9)} ${`${c.maxSelfMs}ms`.padStart(8)}  ${c.name}` +
          (c.maxInstances > 1 ? ` ×${c.maxInstances}` : '') +
          (why ? `  (${why})` : '')
      );
      if (c.changedProps.length) {
        console.log(
          `  ${''.padStart(44)}changed: ${c.changedProps.map((x) => `${x.prop} ×${x.count}`).join(', ')}`
        );
      }
    }
    if (comps.length > top) console.log(`  ... ${comps.length - top} more (raise --top)`);
    console.log(
      '\n  commits = share of commits it rendered in. why: mount / props (changed props listed) / ' +
        'state / parent (new props object, all values equal — React.memo would skip) / context.'
    );
    console.log('  per-commit membership (`commits: [indices]`) is in --json.');
    if (report.truncated) {
      console.log('  TRUNCATED: raise --max-commits / --max-components on `profile react start`.');
    }
    return 0;
  } catch (err) {
    printError(`profile react renders — ${err instanceof Error ? err.message : String(err)}`, opts);
    return 1;
  }
}

export async function profileReactCpu(
  opts: OutputOptions,
  sessionName: string,
  o: { dir?: string; top?: number; componentsOnly?: boolean }
): Promise<number> {
  try {
    const p = await loadProfile(sessionName, o.dir);
    if (!p.cpuDone) throw new Error(`${p.dir} has no Hermes CPU profile (recorded with --no-cpu?)`);
    const top = o.top ?? 20;
    const summary = (await cpuSummary(p, 500))!;
    let rows = summary.top;
    // PascalCase function names are (almost always) components' render functions.
    if (o.componentsOnly) rows = rows.filter((f) => /^[A-Z][A-Za-z0-9]*$/.test(f.name));
    const out = { ...summary, top: rows.slice(0, top), omitted: Math.max(0, rows.length - top) };
    if (opts.json) printData({ status: 'ok', dir: p.dir, gaps: p.cpuDone.gaps, ...out }, opts);
    else {
      printSummary(out, p.cpuDone.out!, 'profile react cpu');
      printGaps(p.cpuDone.gaps ?? []);
    }
    return 0;
  } catch (err) {
    printError(`profile react cpu — ${err instanceof Error ? err.message : String(err)}`, opts);
    return 1;
  }
}

// ── analyze ───────────────────────────────────────────────────────────────────

export interface AnalyzeOptions {
  dir?: string;
  top?: number;
  saveBaseline?: string;
  diff?: string;
}

/** A bare name lives under ~/.conductor; anything path-like is used as given. */
export function baselineFile(name: string): string {
  if (/[\\/]/.test(name) || name.endsWith('.json')) return path.resolve(name);
  return path.join(os.homedir(), '.conductor', 'profile-baselines', `${name}.json`);
}

export interface AnalyzeResult {
  dir: string;
  meta: ProfileMeta;
  input: AnalyzeInput;
  findings: Finding[];
  diff?: BaselineDelta[];
  baselineSaved?: string;
}

export async function analyzeProfile(
  sessionName: string,
  o: AnalyzeOptions
): Promise<AnalyzeResult> {
  const p = await loadProfile(sessionName, o.dir);
  const input: AnalyzeInput = {};
  let renders: RendersReport | undefined;
  if (p.react) {
    renders = computeRenders(p.react);
    input.renders = renders;
    input.reactStartedAt = p.react.startedAt;
  }
  if (p.cpuDone) {
    input.cpu = await cpuSummary(p, 50);
    input.cpuProfiles = await loadSegments(p.cpuDone);
    input.symbols =
      (await readJson<Record<string, string | null>>(path.join(p.dir, 'symbols.json'))) ??
      undefined;
    if (p.cpuDone.startedAtRuntimeMs !== undefined) {
      input.cpuAnchor = { startedAtRuntimeMs: p.cpuDone.startedAtRuntimeMs };
    }
  }
  if (p.meta.native?.state === 'done') {
    input.native = await analyzeNative(p.meta, p.meta.session, 25).catch(() => undefined);
  }
  if (!input.renders && !input.cpu && !input.native) {
    throw new Error(`${p.dir} holds no finished recording to analyse`);
  }
  const findings = buildFindings(input);
  const result: AnalyzeResult = { dir: p.dir, meta: p.meta, input, findings };
  const current = toBaseline(input);
  if (o.diff) {
    const before = await readJson<ProfileBaseline>(baselineFile(o.diff));
    if (!before || before.version !== 1) {
      throw new Error(
        `no usable baseline at ${baselineFile(o.diff)} (save one with --save-baseline)`
      );
    }
    result.diff = diffBaselines(before, current);
  }
  if (o.saveBaseline) {
    const file = baselineFile(o.saveBaseline);
    await writeJson(file, current);
    result.baselineSaved = file;
  }
  await writeJson(path.join(p.dir, 'findings.json'), findings);
  return result;
}

export async function profileAnalyze(
  opts: OutputOptions,
  sessionName: string,
  o: AnalyzeOptions
): Promise<number> {
  try {
    const r = await analyzeProfile(sessionName, o);
    const top = o.top ?? 15;
    if (opts.json) {
      printData(
        {
          status: 'ok',
          dir: r.dir,
          flow: r.meta.flow,
          findings: r.findings.slice(0, top),
          findingsTotal: r.findings.length,
          diff: r.diff,
          baselineSaved: r.baselineSaved,
          summary: summaryOf(r.input),
        },
        opts
      );
      return 0;
    }
    printFindings(r, top);
    return 0;
  } catch (err) {
    printError(`profile analyze — ${err instanceof Error ? err.message : String(err)}`, opts);
    return 1;
  }
}

function summaryOf(input: AnalyzeInput): Record<string, unknown> {
  const r = input.renders;
  return {
    react: r
      ? {
          commits: r.totalCommits,
          durationMs: r.durationMs,
          slowCommits: r.commits.filter((c) => c.durationMs >= 16).length,
          renderMs: round(r.commits.reduce((a, c) => a + c.durationMs, 0)),
          topByRenders: r.components
            .filter((c) => !c.host)
            .slice(0, 10)
            .map((c) => ({ name: c.name, renders: c.renders, selfMs: c.selfMs })),
          topBySelfMs: [...r.components]
            .filter((c) => !c.host)
            .sort((a, b) => b.selfMs - a.selfMs)
            .slice(0, 10)
            .map((c) => ({ name: c.name, renders: c.renders, selfMs: c.selfMs })),
        }
      : undefined,
    cpu: input.cpu
      ? {
          durationMs: input.cpu.durationMs,
          attribution: input.cpu.attribution,
          top: input.cpu.top.slice(0, 10),
        }
      : undefined,
    native: input.native
      ? {
          threads: input.native.threads.slice(0, 5),
          top: input.native.symbols.slice(0, 10),
          hangs: input.native.hangs?.length ?? 0,
        }
      : undefined,
  };
}

export function printFindings(r: AnalyzeResult, top: number): void {
  const s = summaryOf(r.input) as {
    react?: { commits: number; durationMs: number; slowCommits: number; renderMs: number };
  };
  const parts: string[] = [];
  if (s.react) {
    parts.push(
      `${s.react.commits} commits (${s.react.slowCommits} over 16ms, ${s.react.renderMs}ms rendering) ` +
        `in ${(s.react.durationMs / 1000).toFixed(1)}s`
    );
  }
  if (r.input.cpu) {
    const a = r.input.cpu.attribution;
    parts.push(`JS ${a.namedJsPercent}% busy / ${a.gcPercent}% GC`);
  }
  if (r.input.native) parts.push(`native ${r.input.native.tool}`);
  console.log(`profile analyze — ${parts.join('; ')}`);
  if (r.meta.flow)
    console.log(
      `  flow: ${r.meta.flow.file} × ${r.meta.flow.runs}${r.meta.flow.ok ? '' : ' (FAILED)'}`
    );

  if (r.findings.length === 0) {
    console.log(
      '\n  no findings: nothing crossed a threshold (16ms commits, ≥3 wasted renders, ≥5% hotspots).'
    );
  } else {
    console.log('');
    r.findings.slice(0, top).forEach((f, i) => {
      console.log(`  ${String(i + 1).padStart(2)}. [${f.severity.toUpperCase()}] ${f.title}`);
      console.log(`      ${f.detail}`);
      console.log(`      → ${f.suggestion}`);
    });
    if (r.findings.length > top)
      console.log(`\n  ... ${r.findings.length - top} more (raise --top or use --json)`);
  }
  if (r.input.cpu) {
    for (const n of r.input.cpu.notes) console.log(`\n  note [${n.code}]: ${n.message}`);
  }
  if (r.diff) {
    console.log(`\n  vs baseline: ${r.diff.length} change(s) beyond ±20%`);
    for (const d of r.diff.slice(0, 15)) {
      const pct =
        d.changePercent === null ? '' : ` (${d.changePercent > 0 ? '+' : ''}${d.changePercent}%)`;
      console.log(
        `    ${d.verdict.toUpperCase().padEnd(11)} ${d.kind} ${d.name} ${d.metric} ${d.before} → ${d.after}${pct}`
      );
    }
  }
  if (r.baselineSaved) console.log(`\n  baseline saved → ${r.baselineSaved}`);
  console.log(`\n  profile → ${r.dir}  (findings.json written there)`);
}

/** For `run-flow --profile`: print the native report too when one was recorded. */
export async function printNativeIfAny(dir: string): Promise<void> {
  const meta = await readMeta(dir);
  if (meta?.native?.state !== 'done') return;
  const report = await readJson<Parameters<typeof printNativeReport>[0]>(
    path.join(dir, 'native.json')
  );
  if (report) printNativeReport(report, 10);
}
