export const HELP = `  run-flow <file> [--device <id>]     Run a Maestro YAML flow file
    --env KEY=VALUE                   Inject env var (repeatable; overrides flow env block)
    --benchmark                       Print elapsed time for each command and total flow time
    --repeat <n>                      With --benchmark, run the flow n times and report p50/p90/σ
    --json                            With --benchmark --repeat, emit the aggregate as JSON
    --profile [react|native|all]      Record a profile around the whole run (default react:
                                      React commits + Hermes CPU), then print ranked findings
      --profile-out <dir>             Profile directory (default ~/.conductor/profiles/…)
      --app <id> / --page <id>        Metro target when several apps share Metro`;

import path from 'path';
import { getDriver } from '../runner.js';
import { parseFlowFile, executeFlow, BenchmarkEntry } from '../drivers/flow-runner.js';
import { printSuccess, printError, printData, OutputOptions } from '../output.js';
import { describe, round, fmt, Distribution } from '../stats.js';
import {
  startReactProfile,
  stopReactProfile,
  analyzeProfile,
  printFindings,
} from './profile-session.js';
import { startNativeProfile, stopNativeProfile, printNativeReport } from './profile-native.js';
import { readMeta, writeMeta } from './profile-store.js';

export interface FlowProfileOptions {
  mode: 'react' | 'native' | 'all';
  out?: string;
  appId?: string;
  pageId?: string;
  port?: number;
}

export interface CommandBenchmark extends Distribution {
  label: string;
  /** Runs in which this command executed — lower than the run count means it was conditional. */
  runs: number;
  failures: number;
}

export interface BenchmarkAggregate {
  runs: number;
  total: Distribution;
  commands: CommandBenchmark[];
}

/**
 * Aggregate per-run timings by command label. Keyed on label rather than
 * position so a flow whose branches differ between runs still lines up.
 */
export function aggregateRuns(
  runs: Array<{ totalMs: number; entries: BenchmarkEntry[] }>
): BenchmarkAggregate {
  const byLabel = new Map<string, { times: number[]; failures: number }>();
  for (const run of runs) {
    for (const entry of run.entries) {
      const slot = byLabel.get(entry.label) ?? { times: [], failures: 0 };
      slot.times.push(entry.ms);
      if (!entry.ok) slot.failures++;
      byLabel.set(entry.label, slot);
    }
  }
  return {
    runs: runs.length,
    total: describe(runs.map((r) => r.totalMs)),
    commands: [...byLabel.entries()]
      .map(([label, v]) => ({
        label,
        runs: v.times.length,
        failures: v.failures,
        ...describe(v.times),
      }))
      .sort((a, b) => (b.p50Ms ?? 0) - (a.p50Ms ?? 0)),
  };
}

function printAggregate(agg: BenchmarkAggregate): void {
  console.log(`\nBenchmark over ${agg.runs} run(s)`);
  console.log(
    `  total  p50 ${fmt(agg.total.p50Ms)}  p90 ${fmt(agg.total.p90Ms)}  ` +
      `σ ${fmt(agg.total.stddevMs)}  min ${fmt(agg.total.minMs)}  max ${fmt(agg.total.maxMs)}`
  );
  console.log(`\n  ${'p50'.padStart(9)} ${'p90'.padStart(9)} ${'σ'.padStart(8)}  n  command`);
  for (const c of agg.commands) {
    console.log(
      `  ${fmt(c.p50Ms).padStart(9)} ${fmt(c.p90Ms).padStart(9)} ` +
        `${fmt(c.stddevMs).padStart(8)}  ${c.runs}  ${c.label}` +
        (c.failures > 0 ? `  (${c.failures} failed)` : '')
    );
  }
}

export async function runFlow(
  file: string,
  opts: OutputOptions = {},
  sessionName = 'default',
  env: Record<string, string> = {},
  benchmark = false,
  repeat = 1,
  profile?: FlowProfileOptions
): Promise<number> {
  if (!file) {
    printError('run-flow requires <file>', opts);
    return 1;
  }

  const resolvedFile = path.resolve(process.cwd(), file);
  const runs = Math.max(1, repeat);

  let profileDir: string | undefined;
  const react = profile && profile.mode !== 'native';
  const native = profile && profile.mode !== 'react';
  let flowError: unknown;
  let agg: BenchmarkAggregate | undefined;

  try {
    const driver = await getDriver(sessionName);
    const flow = await parseFlowFile(resolvedFile, env);

    // Start profilers only once the flow parsed, so a typo does not leave one running.
    if (react) {
      const { meta } = await startReactProfile(sessionName, {
        out: profile!.out,
        appId: profile!.appId,
        pageId: profile!.pageId,
        port: profile!.port,
      });
      profileDir = meta.dir;
    }
    if (native) {
      try {
        const meta = await startNativeProfile(sessionName, {
          appId: profile!.appId,
          out: profile!.out,
        });
        profileDir = meta.dir;
      } catch (err) {
        if (react) await stopReactProfile(sessionName).catch(() => undefined);
        throw err;
      }
    }

    try {
      if (runs <= 1) {
        await executeFlow(flow, driver, { cwd: path.dirname(resolvedFile), env, benchmark });
      } else {
        const results: Array<{ totalMs: number; entries: BenchmarkEntry[] }> = [];
        for (let i = 0; i < runs; i++) {
          const entries: BenchmarkEntry[] = [];
          console.log(`\n── run ${i + 1}/${runs} ─────────────────────────────`);
          const started = performance.now();
          await executeFlow(flow, driver, {
            cwd: path.dirname(resolvedFile),
            env,
            benchmark,
            benchmarkSink: (e) => entries.push(e),
          });
          results.push({ totalMs: round(performance.now() - started), entries });
        }
        agg = aggregateRuns(results);
      }
    } catch (err) {
      flowError = err;
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    printError(`run-flow "${file}" — failed\n${detail}`, opts);
    return 1;
  }

  // Always stop what was started, even when the flow failed part-way.
  let profileResult: Awaited<ReturnType<typeof analyzeProfile>> | undefined;
  const profileErrors: string[] = [];
  if (profile) {
    let nativeReport: Awaited<ReturnType<typeof stopNativeProfile>>['report'] | undefined;
    if (native) {
      try {
        nativeReport = (await stopNativeProfile(sessionName)).report;
      } catch (err) {
        profileErrors.push(`native: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (react) {
      try {
        const r = await stopReactProfile(sessionName);
        if (r.reactError) profileErrors.push(`react: ${r.reactError}`);
        if (r.cpuError) profileErrors.push(`Hermes CPU: ${r.cpuError}`);
      } catch (err) {
        profileErrors.push(`react: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (profileDir) {
      const meta = await readMeta(profileDir);
      if (meta) {
        meta.flow = { file: resolvedFile, runs, ok: !flowError };
        await writeMeta(meta);
      }
      try {
        profileResult = await analyzeProfile(sessionName, { dir: profileDir });
      } catch (err) {
        profileErrors.push(`analyze: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (!opts.json && nativeReport && profile.mode === 'native')
      printNativeReport(nativeReport, 10);
  }

  if (opts.json && (agg || profile)) {
    printData(
      {
        status: flowError ? 'error' : 'ok',
        error: flowError
          ? flowError instanceof Error
            ? flowError.message
            : String(flowError)
          : undefined,
        benchmark: agg,
        profile: profile
          ? {
              dir: profileDir,
              findings: profileResult?.findings.slice(0, 20),
              findingsTotal: profileResult?.findings.length,
              errors: profileErrors.length ? profileErrors : undefined,
            }
          : undefined,
      },
      opts
    );
    return flowError ? 1 : 0;
  }

  if (agg) printAggregate(agg);
  if (profileResult) {
    console.log('');
    printFindings(profileResult, 10);
  }
  for (const e of profileErrors) console.error(`  profile ${e}`);
  if (flowError) {
    const detail = flowError instanceof Error ? flowError.message : String(flowError);
    printError(`run-flow "${file}" — failed\n${detail}`, opts);
    return 1;
  }
  printSuccess(`run-flow "${file}" — ${runs > 1 ? `${runs} runs ` : ''}done`, opts);
  return 0;
}
