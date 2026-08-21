/**
 * Percentile / dispersion helpers shared by the profiling commands.
 *
 * Percentiles use nearest-rank on a sorted copy so a p99 over a handful of
 * samples still names a real observation rather than an interpolated one that
 * never happened.
 *
 * With no samples every figure is `null`, never 0. A missing measurement that
 * reads as `0ms` is a missing measurement that reads as a *perfect* one, and a
 * consumer has to remember to check `count` to avoid believing it. `null`
 * propagates through arithmetic and comparison loudly enough to notice.
 */

export interface Distribution {
  count: number;
  minMs: number | null;
  maxMs: number | null;
  meanMs: number | null;
  stddevMs: number | null;
  p50Ms: number | null;
  p90Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
}

/** A distribution with at least one sample, so every figure is a real number. */
export type PopulatedDistribution = {
  [K in keyof Distribution]: NonNullable<Distribution[K]>;
};

export const EMPTY_DISTRIBUTION: Distribution = {
  count: 0,
  minMs: null,
  maxMs: null,
  meanMs: null,
  stddevMs: null,
  p50Ms: null,
  p90Ms: null,
  p95Ms: null,
  p99Ms: null,
};

export function hasSamples(d: Distribution | undefined): d is PopulatedDistribution {
  return d !== undefined && d.count > 0;
}

export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

export function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/** `round` that passes `null` through, for optional measurements. */
export function roundOrNull(n: number | null, digits = 2): number | null {
  return n === null ? null : round(n, digits);
}

export function describe(values: number[]): Distribution {
  if (values.length === 0) return { ...EMPTY_DISTRIBUTION };
  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const variance = sorted.reduce((acc, v) => acc + (v - mean) ** 2, 0) / sorted.length;
  return {
    count: sorted.length,
    minMs: round(sorted[0]),
    maxMs: round(sorted[sorted.length - 1]),
    meanMs: round(mean),
    stddevMs: round(Math.sqrt(variance)),
    p50Ms: roundOrNull(percentile(sorted, 50)),
    p90Ms: roundOrNull(percentile(sorted, 90)),
    p95Ms: roundOrNull(percentile(sorted, 95)),
    p99Ms: roundOrNull(percentile(sorted, 99)),
  };
}

/** Format a possibly-absent measurement for text output. */
export function fmt(v: number | null | undefined, unit = 'ms'): string {
  return v === null || v === undefined ? 'n/a' : `${v}${unit}`;
}
