/**
 * Small adb helpers for read-only device queries.
 *
 * Deliberately spawns adb directly rather than going through `runner.ts` so the
 * profiling commands can query a device without booting the gRPC driver daemon —
 * `dumpsys` needs neither, and starting the daemon would perturb what we measure.
 */
import { spawn } from 'child_process';
import { resolveAndroidTool, androidSpawnEnv } from './sdk.js';

export interface AdbResult {
  success: boolean;
  stdout: string;
  stderr: string;
}

export function adb(deviceId: string, args: string[]): Promise<AdbResult> {
  return new Promise((resolve) => {
    const proc = spawn(resolveAndroidTool('adb'), ['-s', deviceId, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: androidSpawnEnv(),
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    proc.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    proc.on('close', (code) => resolve({ success: code === 0, stdout, stderr }));
    proc.on('error', (err) => resolve({ success: false, stdout: '', stderr: err.message }));
  });
}

export function adbShell(deviceId: string, args: string[]): Promise<AdbResult> {
  return adb(deviceId, ['shell', ...args]);
}

/**
 * Package name of the resumed activity, or undefined. Android spells this
 * differently across API levels, hence the alternation.
 */
export function parseResumedPackage(dumpsysActivities: string): string | undefined {
  const m = dumpsysActivities.match(
    /(?:m|top)?ResumedActivity[=:].*?([a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)+)\//
  );
  return m ? m[1] : undefined;
}

export async function resolveAndroidForegroundApp(deviceId: string): Promise<string | undefined> {
  const dump = await adbShell(deviceId, ['dumpsys', 'activity', 'activities']);
  return dump.success ? parseResumedPackage(dump.stdout) : undefined;
}

/**
 * Correlation anchor between the device's monotonic and realtime clocks.
 *
 * Both reads happen inside a *single* adb invocation, bracketing the command
 * that supplies the monotonic side. adb round-trip therefore affects when we
 * learn the offset, not how accurate it is: the error is the on-device
 * separation of the two realtime reads, which is tens of ms, not the hundreds
 * of ms a networked adb round trip costs.
 *
 * Realtime matters because an app's `Date.now()` — what the React commit
 * profiler stamps commits with — is device CLOCK_REALTIME, while framestats
 * vsync timestamps are CLOCK_MONOTONIC. Joining a dropped frame to a React
 * commit is therefore entirely device-side.
 */
export interface ClockAnchor {
  /** Device CLOCK_MONOTONIC ms. Domain of framestats vsync timestamps. */
  deviceMonotonicMs: number;
  /** Device CLOCK_REALTIME ms, midpoint of the bracketing reads. */
  deviceRealtimeMs: number;
  /** Half the on-device spread between the bracketing reads. */
  anchorErrorMs: number;
  /** Host `Date.now()` around the call, for reference only. */
  hostEpochMs: number;
  /**
   * Set when the device's realtime clock advanced far more than the host's
   * during the call — i.e. NTP stepped it mid-read and the anchor is suspect.
   */
  clockStepped?: boolean;
}

/**
 * Run `command` on the device bracketed by two CLOCK_REALTIME reads, in one
 * adb invocation. The caller supplies the monotonic reading by parsing it out
 * of `stdout` (for gfxinfo, its own `Uptime:` header line).
 */
export async function shellBracketed(
  deviceId: string,
  command: string
): Promise<
  | { stdout: string; realtimeStartMs: number; realtimeEndMs: number; hostElapsedMs: number }
  | undefined
> {
  const hostStart = Date.now();
  // One argument, not argv: adb joins everything after `shell` with spaces and
  // the device's own shell parses it, so the semicolons survive.
  const res = await adbShell(deviceId, [`date +%s%N; ${command}; date +%s%N`]);
  const hostElapsedMs = Date.now() - hostStart;
  if (!res.success) return undefined;
  const stamps = [...res.stdout.matchAll(/^\s*(\d{16,})\s*$/gm)].map((m) => Number(m[1]) / 1e6);
  if (stamps.length < 2) return undefined;
  const realtimeStartMs = stamps[0];
  const realtimeEndMs = stamps[stamps.length - 1];
  // Strip the two stamp lines so callers parse only the command's own output.
  const stdout = res.stdout
    .split(/\r?\n/)
    .filter((l) => !/^\s*\d{16,}\s*$/.test(l))
    .join('\n');
  return { stdout, realtimeStartMs, realtimeEndMs, hostElapsedMs };
}

export function buildClockAnchor(
  bracket: { realtimeStartMs: number; realtimeEndMs: number; hostElapsedMs: number },
  deviceMonotonicMs: number
): ClockAnchor {
  const spread = bracket.realtimeEndMs - bracket.realtimeStartMs;
  return {
    deviceMonotonicMs,
    deviceRealtimeMs: (bracket.realtimeStartMs + bracket.realtimeEndMs) / 2,
    anchorErrorMs: Math.round((spread / 2) * 100) / 100,
    hostEpochMs: Date.now(),
    // The device cannot have spent more wall time on this than the host did
    // waiting for it; if it claims to, the realtime clock was stepped.
    clockStepped: spread > bracket.hostElapsedMs + 50 ? true : undefined,
  };
}

/** Device CLOCK_MONOTONIC ms from /proc/uptime. Cheap (~1ms) but 10ms-grained. */
export function parseProcUptimeMs(out: string): number | undefined {
  const m = out.match(/^\s*(\d+\.\d+)\s+\d+\.\d+\s*$/m);
  return m ? Number(m[1]) * 1000 : undefined;
}

/** Convert a framestats vsync timestamp (ns, monotonic) to the app's Date.now() domain. */
export function toDeviceRealtimeMs(anchor: ClockAnchor, monotonicNs: number): number {
  return monotonicNs / 1e6 - anchor.deviceMonotonicMs + anchor.deviceRealtimeMs;
}
