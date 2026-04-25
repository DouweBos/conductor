export const HELP = `  logs [--source <source>] [--level <level>]  Stream app logs (console, Metro, or device)
    --source <source>               Filter by source: metro, device (default: both)
    --level <level>                 Minimum level: verbose, debug, log, info, warn, error
    --list                          List Metro debugger targets for this device and exit
    --recent <n>                    Return the last N buffered log entries and exit (agent-friendly)
    --duration <seconds>            Stream logs for N seconds, then exit
    --json                          Output as NDJSON (one JSON object per line)`;

import { OutputOptions } from '../output.js';
import { getDriver } from '../runner.js';
import { IOSDriver } from '../drivers/ios.js';
import { AndroidDriver } from '../drivers/android.js';
import { WebDriver } from '../drivers/web.js';
import { LogEntry, LEVEL_SEVERITY } from '../drivers/log-sources/types.js';
import { fetchTargets } from '../drivers/log-sources/metro.js';
import {
  discoverMetroPortForDevice,
  getDeviceDisplayName,
  targetsForDevice,
} from '../drivers/log-sources/metro-discovery.js';
import { DaemonLogSource } from '../drivers/log-sources/daemon.js';
import { fetchDaemonLogs } from '../daemon/client.js';
import { detectPlatform } from '../drivers/bootstrap.js';

export interface LogsOptions {
  source?: string;
  level?: string;
  list?: boolean;
  recent?: number;
  duration?: number;
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleTimeString('en-GB', { hour12: false });
  } catch {
    return iso;
  }
}

function formatEntry(entry: LogEntry, opts: OutputOptions): string {
  if (opts.json) {
    return JSON.stringify(entry);
  }

  const time = formatTimestamp(entry.timestamp);
  const lvl = entry.level.padEnd(7);
  let line = `[${lvl}] ${time}  ${entry.message}`;
  if (entry.stackTrace) {
    line += '\n' + entry.stackTrace;
  }
  return line;
}

async function resolvePlatformAndDevice(
  sessionName: string
): Promise<{ platform: string; deviceId: string } | null> {
  try {
    const driver = await getDriver(sessionName);
    let platform = 'unknown';
    if (driver instanceof IOSDriver) platform = driver.platform;
    else if (driver instanceof AndroidDriver) platform = 'android';
    else if (driver instanceof WebDriver) platform = 'web';
    else platform = await detectPlatform(sessionName);
    return { platform, deviceId: sessionName };
  } catch {
    return null;
  }
}

export async function logs(
  opts: OutputOptions = {},
  sessionName = 'default',
  { source, level, list, recent, duration }: LogsOptions = {}
): Promise<number> {
  const sourceFilter = source === 'metro' || source === 'device' ? source : undefined;

  // --list: resolve the device's Metro port deterministically, then print its targets.
  if (list) {
    try {
      const ctx = await resolvePlatformAndDevice(sessionName);
      if (!ctx) {
        const msg = 'Could not resolve device session for --list';
        if (opts.json) console.log(JSON.stringify({ status: 'error', message: msg }));
        else console.error(`✗ logs --list — ${msg}`);
        return 1;
      }

      const port = await discoverMetroPortForDevice(ctx.platform, ctx.deviceId);
      if (port === null) {
        if (opts.json) console.log(JSON.stringify({ status: 'ok', port: null, targets: [] }));
        else {
          console.log(
            'No Metro connection detected for this device. The daemon will keep trying — ' +
              'launch the React Native app on this device and retry, or confirm the app is not RN.'
          );
        }
        return 0;
      }

      const allTargets = await fetchTargets(port, 'localhost');
      const displayName = await getDeviceDisplayName(ctx.platform, ctx.deviceId);
      const deviceTargets = displayName ? targetsForDevice(allTargets, displayName) : [];

      if (opts.json) {
        console.log(
          JSON.stringify({
            status: 'ok',
            port,
            deviceName: displayName,
            targets: deviceTargets.map((t, i) => ({
              index: i,
              title: t.title ?? null,
              description: t.description ?? null,
              deviceName: t.deviceName ?? null,
              appId: t.appId ?? null,
              logicalDeviceId: t.reactNative?.logicalDeviceId ?? null,
              webSocketDebuggerUrl: t.webSocketDebuggerUrl ?? null,
            })),
          })
        );
      } else {
        console.log(`Metro on port ${port} (device: ${displayName ?? 'unknown'})`);
        if (deviceTargets.length === 0) {
          console.log('  No targets for this device.');
        } else {
          for (let i = 0; i < deviceTargets.length; i++) {
            const t = deviceTargets[i];
            const desc = t.description ? `  — ${t.description}` : '';
            console.log(`  ${i}: ${t.title ?? '(unnamed)'}${desc}`);
          }
        }
      }
      return 0;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (opts.json) console.log(JSON.stringify({ status: 'error', message: msg }));
      else console.error(`✗ logs --list — ${msg}`);
      return 1;
    }
  }

  try {
    // ── Snapshot mode (--recent N) ──────────────────────────────────────────
    if (recent !== undefined) {
      await getDriver(sessionName);

      const minSeverity = level ? (LEVEL_SEVERITY[level] ?? 0) : 0;
      const entries = await fetchDaemonLogs(sessionName, { limit: recent, level });

      for (const entry of entries) {
        if (sourceFilter && entry.source !== sourceFilter) continue;
        const entrySeverity = LEVEL_SEVERITY[entry.level] ?? 0;
        if (entrySeverity < minSeverity) continue;
        console.log(formatEntry(entry, opts));
      }
      return 0;
    }

    // ── Streaming modes ─────────────────────────────────────────────────────
    // Ensure daemon is running; its log collector auto-discovers Metro.
    await getDriver(sessionName);

    const minSeverity = level ? (LEVEL_SEVERITY[level] ?? 0) : 0;
    const logSource = new DaemonLogSource(sessionName);
    await logSource.connect();

    const cleanup = (): void => {
      logSource.disconnect();
      process.exit(0);
    };
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);

    logSource.onEntry((entry: LogEntry) => {
      if (sourceFilter && entry.source !== sourceFilter) return;
      const entrySeverity = LEVEL_SEVERITY[entry.level] ?? 0;
      if (entrySeverity < minSeverity) return;
      console.log(formatEntry(entry, opts));
    });

    if (duration !== undefined) {
      await new Promise<void>((resolve) => {
        setTimeout(() => {
          logSource.disconnect();
          resolve();
        }, duration * 1000);
      });
      return 0;
    }

    // Streaming — never resolves; exits via SIGINT/SIGTERM
    await new Promise<void>(() => {});

    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (opts.json) {
      console.log(JSON.stringify({ status: 'error', message: msg }));
    } else {
      console.error(`✗ logs — ${msg}`);
    }
    return 1;
  }
}
