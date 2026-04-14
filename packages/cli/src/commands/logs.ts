export const HELP = `  logs [--source <source>] [--level <level>]  Stream app logs (console, Metro, or device)
    --source <source>               Log source: metro, device, or auto (default: auto)
    --level <level>                 Minimum level: verbose, debug, log, info, warn, error
    --metro                         Enable Metro logs for React Native apps (auto-discovers port)
    --metro-port <port>             Override Metro dev server port (skips auto-discovery)
    --target <n>                    Metro debugger target index (when multiple devices share one Metro)
    --list                          List available Metro debugger targets and exit
    --recent <n>                    Return the last N buffered log entries and exit (agent-friendly)
    --duration <seconds>            Stream logs for N seconds, then exit
    --json                          Output as NDJSON (one JSON object per line)`;

import { OutputOptions } from '../output.js';
import { getDriver } from '../runner.js';
import { IOSDriver } from '../drivers/ios.js';
import { AndroidDriver } from '../drivers/android.js';
import { WebDriver } from '../drivers/web.js';
import { LogEntry, LEVEL_SEVERITY } from '../drivers/log-sources/types.js';
import { MetroLogSource, fetchTargets } from '../drivers/log-sources/metro.js';
import { DaemonLogSource } from '../drivers/log-sources/daemon.js';
import { fetchDaemonLogs } from '../daemon/client.js';
import { detectPlatform } from '../drivers/bootstrap.js';

export interface LogsOptions {
  source?: string;
  level?: string;
  metro?: boolean;
  metroPort?: number;
  target?: number;
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

export async function logs(
  opts: OutputOptions = {},
  sessionName = 'default',
  { source = 'auto', level, metro, metroPort, target, list, recent, duration }: LogsOptions = {}
): Promise<number> {
  // --list: query Metro targets and print them without starting a log stream
  if (list) {
    try {
      const targets = await fetchTargets(metroPort ?? 8081, 'localhost');
      const withWs = targets.filter((t) => t.webSocketDebuggerUrl);
      if (withWs.length === 0) {
        if (opts.json) {
          console.log(JSON.stringify({ status: 'ok', targets: [] }));
        } else {
          console.log('No Metro debugger targets found. Is the app running?');
        }
        return 0;
      }
      if (opts.json) {
        const items = withWs.map((t, i) => ({
          index: i,
          title: t.title ?? null,
          description: t.description ?? null,
          deviceName: t.deviceName ?? null,
          deviceId: t.deviceId ?? null,
          appId: t.appId ?? null,
          logicalDeviceId: t.reactNative?.logicalDeviceId ?? null,
        }));
        console.log(JSON.stringify({ status: 'ok', targets: items }));
      } else {
        console.log('Metro debugger targets:');
        for (let i = 0; i < withWs.length; i++) {
          const t = withWs[i];
          const label = t.title ?? t.deviceName ?? '(unnamed)';
          const desc = t.description ? `  — ${t.description}` : '';
          console.log(`  ${i}: ${label}${desc}`);
        }
      }
      return 0;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (opts.json) {
        console.log(JSON.stringify({ status: 'error', message: msg }));
      } else {
        console.error(`\u2717 logs --list \u2014 ${msg}`);
      }
      return 1;
    }
  }

  try {
    // ── Snapshot mode (--recent N) ──────────────────────────────────────────
    // Single fetch from the daemon's log buffer, print, and exit immediately.
    // This is the primary agent-friendly mode.
    if (recent !== undefined) {
      // Ensure daemon is running (starts it if needed)
      await getDriver(sessionName);

      const minSeverity = level ? (LEVEL_SEVERITY[level] ?? 0) : 0;
      // --metro with explicit port → use that port; --metro without port → auto-discover
      const metroOpt: number | 'auto' | undefined = metro ? (metroPort ?? 'auto') : undefined;
      const entries = await fetchDaemonLogs(sessionName, {
        limit: recent,
        level,
        metro: metroOpt,
      });

      for (const entry of entries) {
        const entrySeverity = LEVEL_SEVERITY[entry.level] ?? 0;
        if (entrySeverity < minSeverity) continue;
        console.log(formatEntry(entry, opts));
      }
      return 0;
    }

    // ── Determine platform for streaming modes ─────────────────────────────
    // When source is explicitly 'metro', skip device resolution entirely —
    // Metro runs on the host, so we don't need a running driver or session.
    let _platform = 'unknown';
    if (source !== 'metro') {
      const driver = await getDriver(sessionName);
      if (driver instanceof IOSDriver) {
        _platform = driver.platform;
      } else if (driver instanceof AndroidDriver) {
        _platform = 'android';
      } else if (driver instanceof WebDriver) {
        _platform = 'web';
      } else {
        _platform = await detectPlatform(sessionName);
      }
    }

    const minSeverity = level ? (LEVEL_SEVERITY[level] ?? 0) : 0;

    // ── Create log source ──────────────────────────────────────────────────
    let logSource: MetroLogSource | DaemonLogSource;

    if (source === 'metro') {
      // Explicit --source metro: connect directly to Metro via CLI
      logSource = new MetroLogSource(metroPort ?? 8081, 'localhost', target);
      await logSource.connect();
    } else {
      // Device logs via daemon. When --metro is set, pass the metro port
      // (or 'auto' for auto-discovery) so the daemon finds Metro for this device.
      const metroOpt: number | 'auto' | undefined = metro ? (metroPort ?? 'auto') : undefined;
      logSource = new DaemonLogSource(sessionName, metroOpt);
      await logSource.connect();
    }

    // Set up graceful shutdown
    const cleanup = (): void => {
      logSource.disconnect();
      process.exit(0);
    };
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);

    logSource.onEntry((entry: LogEntry) => {
      const entrySeverity = LEVEL_SEVERITY[entry.level] ?? 0;
      if (entrySeverity < minSeverity) return;
      console.log(formatEntry(entry, opts));
    });

    // ── Duration mode (--duration N) ───────────────────────────────────────
    if (duration !== undefined) {
      await new Promise<void>((resolve) => {
        setTimeout(() => {
          logSource.disconnect();
          resolve();
        }, duration * 1000);
      });
      return 0;
    }

    // ── Streaming mode (default) ───────────────────────────────────────────
    // Keep the process alive — the log source streams entries via callbacks
    await new Promise<void>(() => {
      // Never resolves — exits via SIGINT/SIGTERM
    });

    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (opts.json) {
      console.log(JSON.stringify({ status: 'error', message: msg }));
    } else {
      console.error(`\u2717 logs \u2014 ${msg}`);
    }
    return 1;
  }
}
