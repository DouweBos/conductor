/**
 * Android GC-pause scraping.
 *
 * ART logs every collection it considers noteworthy to logcat under the `art`
 * tag; the pause figures in those lines are the stop-the-world portions, which
 * is what shows up as a dropped frame. Scraped rather than sampled because
 * there is no dumpsys surface for pause times.
 */
import { adbShell } from '../android/device.js';
import { describe, round, Distribution } from '../stats.js';

export interface GcEvent {
  /** e.g. "Background concurrent copying", "Explicit", "Alloc". */
  kind: string;
  /** Individual stop-the-world pauses reported for this collection. */
  pausesMs: number[];
  /** Wall-clock duration of the whole collection. */
  totalMs: number;
  freedBytes?: number;
  heapUsedBytes?: number;
  heapTotalBytes?: number;
}

export interface GcReport {
  events: number;
  totalPauseMs: number;
  pause: Distribution;
  duration: Distribution;
  byKind: Array<{ kind: string; count: number; totalPauseMs: number }>;
}

function toMs(value: string): number {
  const m = value.match(/^([\d.]+)(us|ms|s)$/);
  if (!m) return 0;
  const n = Number(m[1]);
  if (m[2] === 'us') return n / 1000;
  if (m[2] === 's') return n * 1000;
  return n;
}

function toBytes(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const m = value.match(/^([\d.]+)(B|KB|MB|GB)$/i);
  if (!m) return undefined;
  const mult = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[m[2].toLowerCase()]!;
  return Math.round(Number(m[1]) * mult);
}

/**
 * Parse ART GC lines out of raw logcat. Tolerates the pause list being one or
 * several values and the units varying between us and ms.
 */
export function parseGcEvents(logcat: string): GcEvent[] {
  const events: GcEvent[] = [];
  const re =
    /([A-Za-z][A-Za-z ]*?) GC freed (?:[\d.]+)\(([\d.]+[KMG]?B)\) AllocSpace objects.*?, (?:[\d.]+% free, )?([\d.]+[KMG]?B)\/([\d.]+[KMG]?B), paused ([\d.]+(?:us|ms|s)(?:,\s*[\d.]+(?:us|ms|s))*) total ([\d.]+(?:us|ms|s))/g;
  for (const m of logcat.matchAll(re)) {
    events.push({
      kind: m[1].trim(),
      freedBytes: toBytes(m[2]),
      heapUsedBytes: toBytes(m[3]),
      heapTotalBytes: toBytes(m[4]),
      pausesMs: m[5].split(',').map((p) => toMs(p.trim())),
      totalMs: toMs(m[6]),
    });
  }
  return events;
}

export function summariseGc(events: GcEvent[]): GcReport {
  const pauses = events.flatMap((e) => e.pausesMs);
  const byKind = new Map<string, { count: number; totalPauseMs: number }>();
  for (const e of events) {
    const slot = byKind.get(e.kind) ?? { count: 0, totalPauseMs: 0 };
    slot.count++;
    slot.totalPauseMs += e.pausesMs.reduce((a, b) => a + b, 0);
    byKind.set(e.kind, slot);
  }
  return {
    events: events.length,
    totalPauseMs: round(pauses.reduce((a, b) => a + b, 0)),
    pause: describe(pauses),
    duration: describe(events.map((e) => e.totalMs)),
    byKind: [...byKind.entries()]
      .map(([kind, v]) => ({ kind, count: v.count, totalPauseMs: round(v.totalPauseMs) }))
      .sort((a, b) => b.totalPauseMs - a.totalPauseMs),
  };
}

/**
 * logcat's `-T` filter wants the device's own clock, which can drift from the
 * host's, so ask the device what time it thinks it is.
 */
export async function deviceLogcatTimestamp(deviceId: string): Promise<string | undefined> {
  const res = await adbShell(deviceId, ['date', '+%m-%d %H:%M:%S.000']);
  return res.success ? res.stdout.trim() : undefined;
}

export async function collectGcSince(
  deviceId: string,
  since: string | undefined
): Promise<GcEvent[]> {
  const args = ['logcat', '-d'];
  if (since) args.push('-T', since);
  args.push('art:I', '*:S');
  const res = await adbShell(deviceId, args);
  return res.success ? parseGcEvents(res.stdout) : [];
}
