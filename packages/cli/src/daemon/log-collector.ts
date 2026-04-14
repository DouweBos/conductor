/**
 * Daemon-side log collector — manages a platform-specific log source and
 * buffers entries in a circular buffer for HTTP query access.
 *
 * Reuses the existing IOSLogSource / AndroidLogSource classes (which spawn
 * simctl / adb logcat). For web, polls the co-located web-server's
 * /consoleLogs endpoint.
 *
 * Optionally discovers and connects to a Metro dev server for React Native
 * JS-level console logs. This is opt-in: call enableMetro(port) to start
 * background discovery. Metro entries are merged into the same buffer with
 * source='metro'.
 */
import http from 'http';
import { spawn } from 'child_process';
import { LogEntry, LogSource, LEVEL_SEVERITY } from '../drivers/log-sources/types.js';
import { IOSLogSource } from '../drivers/log-sources/ios.js';
import { AndroidLogSource } from '../drivers/log-sources/android.js';
import { MetroLogSource, fetchTargets, MetroTarget } from '../drivers/log-sources/metro.js';

const MAX_BUFFER = 5000;
const RESTART_DELAY_MS = 2000;
const WEB_POLL_INTERVAL_MS = 500;
const METRO_DISCOVERY_INTERVAL_MS = 3000;
const METRO_AUTO_DISCOVERY_MAX_ATTEMPTS = 10;

/** Known Metro dev server port ranges. */
const METRO_PORT_RANGES: [number, number][] = [
  [8080, 8099], // Metro default range
  [19000, 19002], // Expo
];

function isMetroPort(port: number): boolean {
  return METRO_PORT_RANGES.some(([lo, hi]) => port >= lo && port <= hi);
}

function spawnCapture(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    proc.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${cmd} failed (${code})`))
    );
    proc.on('error', reject);
  });
}

export interface LogQueryOptions {
  since?: string;
  level?: string;
  limit?: number;
}

export class LogCollector {
  private buffer: LogEntry[] = [];
  private source: LogSource | null = null;
  private stopped = false;
  private restartTimer: NodeJS.Timeout | null = null;

  // Web polling state
  private webPollTimer: NodeJS.Timeout | null = null;
  private webSince = new Date().toISOString();

  // Metro auto-discovery state
  private metroSource: MetroLogSource | null = null;
  private metroDiscoveryTimer: NodeJS.Timeout | null = null;
  private metroPort: number | null = null;
  private metroConnected = false;
  private metroAutoDiscovery = false;
  private metroAutoDiscoveryAttempts = 0;

  constructor(
    private readonly platform: string,
    private readonly deviceId: string,
    private readonly driverPort: number,
    private readonly appId?: string,
    private readonly dlog?: (msg: string) => void
  ) {}

  async start(): Promise<void> {
    this.stopped = false;

    if (this.platform === 'web') {
      this.startWebPolling();
      return;
    }

    await this.startSource();
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.webPollTimer) {
      clearTimeout(this.webPollTimer);
      this.webPollTimer = null;
    }
    if (this.metroDiscoveryTimer) {
      clearTimeout(this.metroDiscoveryTimer);
      this.metroDiscoveryTimer = null;
    }
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
    if (this.metroSource) {
      this.metroSource.disconnect();
      this.metroSource = null;
      this.metroConnected = false;
    }
  }

  /**
   * Enable Metro log collection for React Native apps.
   *
   * When `port` is given, connects directly to that Metro port.
   * When omitted, auto-discovers the Metro port by probing the device:
   *   - Android: parses `adb reverse --list` for forwarded Metro ports
   *   - iOS/tvOS: scans `lsof` for node listeners in Metro port ranges,
   *     then probes `/json` and matches by deviceId (strict — no appId fallback)
   *
   * This is opt-in — only call this for React Native apps.
   */
  enableMetro(port?: number): void {
    if (this.platform === 'web') return; // Web already has console logs

    if (port !== undefined) {
      // Explicit port — same as before
      if (this.metroPort === port) return;
      this.teardownMetro();
      this.metroAutoDiscovery = false;
      this.metroPort = port;
      this.startMetroDiscovery();
    } else {
      // Auto-discover
      if (this.metroAutoDiscovery || this.metroConnected) return;
      this.teardownMetro();
      this.metroAutoDiscovery = true;
      this.metroAutoDiscoveryAttempts = 0;
      this.startAutoDiscovery();
    }
  }

  private teardownMetro(): void {
    if (this.metroSource) {
      this.metroSource.disconnect();
      this.metroSource = null;
      this.metroConnected = false;
    }
    if (this.metroDiscoveryTimer) {
      clearTimeout(this.metroDiscoveryTimer);
      this.metroDiscoveryTimer = null;
    }
  }

  query(opts: LogQueryOptions = {}): LogEntry[] {
    let entries = this.buffer;

    if (opts.since) {
      const since = opts.since;
      entries = entries.filter((e) => e.timestamp > since);
    }

    if (opts.level) {
      const minSeverity = LEVEL_SEVERITY[opts.level] ?? 0;
      entries = entries.filter((e) => (LEVEL_SEVERITY[e.level] ?? 0) >= minSeverity);
    }

    if (opts.limit && opts.limit > 0) {
      // Return the most recent N entries
      entries = entries.slice(-opts.limit);
    }

    return entries;
  }

  private pushEntry(entry: LogEntry): void {
    this.buffer.push(entry);
    if (this.buffer.length > MAX_BUFFER) {
      this.buffer.splice(0, this.buffer.length - MAX_BUFFER);
    }
  }

  private async startSource(): Promise<void> {
    if (this.stopped) return;

    try {
      if (this.platform === 'ios' || this.platform === 'tvos') {
        this.source = new IOSLogSource(this.deviceId, this.appId);
      } else if (this.platform === 'android') {
        this.source = new AndroidLogSource(this.deviceId, this.appId);
      } else {
        return; // Unsupported platform for device log collection
      }

      this.source.onEntry((entry) => this.pushEntry(entry));
      await this.source.connect();
    } catch {
      // Source failed to start — schedule a retry
      this.scheduleRestart();
    }
  }

  private scheduleRestart(): void {
    if (this.stopped) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.startSource().catch(() => this.scheduleRestart());
    }, RESTART_DELAY_MS);
  }

  // ── Web polling ──────────────────────────────────────────────────────────

  private startWebPolling(): void {
    const poll = async (): Promise<void> => {
      if (this.stopped) return;
      try {
        const entries = await this.fetchWebLogs();
        for (const entry of entries) {
          this.pushEntry(entry);
        }
        if (entries.length > 0) {
          this.webSince = entries[entries.length - 1].timestamp;
        }
      } catch {
        // Web driver may be restarting — keep polling
      }
      if (!this.stopped) {
        this.webPollTimer = setTimeout(poll, WEB_POLL_INTERVAL_MS);
      }
    };
    poll();
  }

  private fetchWebLogs(): Promise<LogEntry[]> {
    return new Promise((resolve, reject) => {
      const req = http.get(
        `http://127.0.0.1:${this.driverPort}/consoleLogs?since=${encodeURIComponent(this.webSince)}`,
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            try {
              const data = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as {
                entries: LogEntry[];
              };
              resolve(data.entries ?? []);
            } catch {
              resolve([]);
            }
          });
        }
      );
      req.setTimeout(5000, () => {
        req.destroy();
        reject(new Error('Timeout polling web console logs'));
      });
      req.on('error', reject);
    });
  }

  // ── Metro auto-discovery ─────────────────────────────────────────────────

  private async startAutoDiscovery(): Promise<void> {
    if (this.stopped || this.metroConnected) return;

    this.metroAutoDiscoveryAttempts++;
    try {
      const port = await this.discoverMetroPort();
      if (port !== null) {
        this.dlog?.(`Metro auto-discovered on port ${port} for device ${this.deviceId}`);
        this.metroPort = port;
        this.startMetroDiscovery();
        return;
      }
    } catch {
      // Discovery failed — retry
    }

    if (this.metroAutoDiscoveryAttempts >= METRO_AUTO_DISCOVERY_MAX_ATTEMPTS) {
      this.dlog?.(
        `Metro auto-discovery: no Metro instance found for device ${this.deviceId} after ${this.metroAutoDiscoveryAttempts} attempts. Use --metro-port to specify.`
      );
      this.metroAutoDiscovery = false;
      return;
    }

    // Retry — app may not have started yet
    if (!this.stopped) {
      this.metroDiscoveryTimer = setTimeout(() => {
        this.metroDiscoveryTimer = null;
        this.startAutoDiscovery();
      }, METRO_DISCOVERY_INTERVAL_MS);
    }
  }

  /**
   * Discover the Metro dev server port by probing the device.
   *
   * Android: parse `adb reverse --list` for forwarded ports in Metro ranges.
   * iOS/tvOS: scan `lsof` for node listeners in Metro ranges, probe `/json`,
   * and strictly match by deviceId (no appId/single-target fallback).
   */
  private async discoverMetroPort(): Promise<number | null> {
    if (this.platform === 'android') {
      return this.discoverMetroPortAndroid();
    }
    if (this.platform === 'ios' || this.platform === 'tvos') {
      return this.discoverMetroPortIOS();
    }
    return null;
  }

  private async discoverMetroPortAndroid(): Promise<number | null> {
    try {
      const output = await spawnCapture('adb', ['-s', this.deviceId, 'reverse', '--list']);
      // Lines look like: host-13 tcp:8082 tcp:8082
      for (const line of output.split('\n')) {
        const match = line.match(/tcp:(\d+)\s+tcp:(\d+)/);
        if (!match) continue;
        const hostPort = parseInt(match[2], 10);
        if (isMetroPort(hostPort)) return hostPort;
      }
    } catch {
      // adb not available or device not connected
    }
    return null;
  }

  private async discoverMetroPortIOS(): Promise<number | null> {
    try {
      const output = await spawnCapture('lsof', ['-iTCP', '-sTCP:LISTEN', '-n', '-P']);
      const ports = new Set<number>();
      for (const line of output.split('\n')) {
        if (!line.startsWith('node')) continue;
        // Column 9 is NAME, e.g. "*:8082" or "[::1]:8082" or "127.0.0.1:8082"
        const match = line.match(/:(\d+)\s/);
        if (!match) continue;
        const port = parseInt(match[1], 10);
        if (isMetroPort(port)) ports.add(port);
      }

      if (ports.size === 0) return null;

      // Probe all candidate ports in parallel
      const results = await Promise.all(
        [...ports].map(async (port) => {
          try {
            const targets = await fetchTargets(port, 'localhost');
            const withWs = targets.filter((t) => t.webSocketDebuggerUrl);
            // Strict deviceId match only — no appId or single-target fallback
            const match = withWs.find(
              (t) =>
                t.deviceId === this.deviceId || t.reactNative?.logicalDeviceId === this.deviceId
            );
            return match ? port : null;
          } catch {
            return null;
          }
        })
      );

      return results.find((p) => p !== null) ?? null;
    } catch {
      // lsof not available
    }
    return null;
  }

  private startMetroDiscovery(): void {
    if (this.stopped || this.metroPort === null) return;
    this.tryConnectMetro();
  }

  private async tryConnectMetro(): Promise<void> {
    if (this.stopped || this.metroPort === null || this.metroConnected) return;

    try {
      const targets = await fetchTargets(this.metroPort, 'localhost');
      const target = this.findTargetForDevice(targets);

      if (!target || !target.webSocketDebuggerUrl) {
        // Target not found yet — app may still be starting. Retry later.
        this.scheduleMetroDiscovery();
        return;
      }

      // Found a matching target — connect
      const targetIndex = targets.filter((t) => t.webSocketDebuggerUrl).indexOf(target);

      this.metroSource = new MetroLogSource(
        this.metroPort,
        'localhost',
        targetIndex >= 0 ? targetIndex : undefined
      );
      this.metroSource.onEntry((entry) => this.pushEntry(entry));
      await this.metroSource.connect();
      this.metroConnected = true;
      this.dlog?.(`Metro connected for device ${this.deviceId} on port ${this.metroPort}`);
    } catch {
      // Metro not running or connection failed — retry
      this.scheduleMetroDiscovery();
    }
  }

  /**
   * Find a Metro debugger target that matches this daemon's device.
   * Checks deviceId (simulator UDID / emulator serial) first,
   * then falls back to matching by appId if available.
   */
  private findTargetForDevice(targets: MetroTarget[]): MetroTarget | undefined {
    const withWs = targets.filter((t) => t.webSocketDebuggerUrl);
    if (withWs.length === 0) return undefined;

    // Prefer exact deviceId match (simulator UDID / emulator serial)
    const byDevice = withWs.find(
      (t) => t.deviceId === this.deviceId || t.reactNative?.logicalDeviceId === this.deviceId
    );
    if (byDevice) return byDevice;

    // Fall back to appId match if we know the app
    if (this.appId) {
      const byApp = withWs.find((t) => t.appId === this.appId);
      if (byApp) return byApp;
    }

    // Single target — safe to use without matching
    if (withWs.length === 1) return withWs[0];

    // Multiple targets, no match — don't guess
    return undefined;
  }

  private scheduleMetroDiscovery(): void {
    if (this.stopped || this.metroConnected) return;
    this.metroDiscoveryTimer = setTimeout(() => {
      this.metroDiscoveryTimer = null;
      this.tryConnectMetro();
    }, METRO_DISCOVERY_INTERVAL_MS);
  }
}
