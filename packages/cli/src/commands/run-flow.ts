export const HELP = `  run-flow <file> [--device <id>]     Run a Maestro YAML flow file
    --env KEY=VALUE                   Inject env var (repeatable; overrides flow env block)
    --benchmark                       Print elapsed time for each command and total flow time
    --repeat <n>                      With --benchmark, run the flow n times and report p50/p90/σ
    --json                            With --benchmark --repeat, emit the aggregate as JSON`;

import path from 'path';
import { getDriver } from '../runner.js';
import { parseFlowFile, executeFlow, BenchmarkEntry } from '../drivers/flow-runner.js';
import { printSuccess, printError, printData, OutputOptions } from '../output.js';
import { describe, round, fmt, Distribution } from '../stats.js';

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
  repeat = 1
): Promise<number> {
  if (!file) {
    printError('run-flow requires <file>', opts);
    return 1;
  }

  const resolvedFile = path.resolve(process.cwd(), file);

  try {
    const driver = await getDriver(sessionName);
    const flow = await parseFlowFile(resolvedFile, env);

    if (repeat <= 1) {
      await executeFlow(flow, driver, { cwd: path.dirname(resolvedFile), env, benchmark });
      printSuccess(`run-flow "${file}" — done`, opts);
      return 0;
    }

    const runs: Array<{ totalMs: number; entries: BenchmarkEntry[] }> = [];
    for (let i = 0; i < repeat; i++) {
      const entries: BenchmarkEntry[] = [];
      console.log(`\n── run ${i + 1}/${repeat} ─────────────────────────────`);
      const started = performance.now();
      await executeFlow(flow, driver, {
        cwd: path.dirname(resolvedFile),
        env,
        benchmark,
        benchmarkSink: (e) => entries.push(e),
      });
      runs.push({ totalMs: round(performance.now() - started), entries });
    }

    const agg = aggregateRuns(runs);
    if (opts.json) printData({ status: 'ok', benchmark: agg }, opts);
    else {
      printAggregate(agg);
      printSuccess(`run-flow "${file}" — ${repeat} runs done`, opts);
    }
    return 0;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    printError(`run-flow "${file}" — failed\n${detail}`, opts);
    return 1;
  }
}
