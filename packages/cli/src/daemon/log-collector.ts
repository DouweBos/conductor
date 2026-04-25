/**
 * Daemon-side log collector — manages a platform-specific log source and
 * buffers entries in a circular buffer for HTTP query access.
 *
 * Reuses the existing IOSLogSource / AndroidLogSource classes (which spawn
 * simctl / adb logcat). For web, polls the co-located web-server's
 * /consoleLogs endpoint.
 *
 * Also deterministically detects whether this device is connected to a Metro
 * dev server and, if so, connects to it. Metro entries are merged into the
 * same buffer with source='metro'. Discovery is automatic — callers do not
 * pass a port.
 *
 * iOS/tvOS discovery: locate PIDs running inside the simulator via
 *   `xcrun simctl spawn <UDID> launchctl list`, then `lsof` each PID for
 *   ESTABLISHED TCP connections to a Metro port on localhost. The remote
 *   port is the Metro port for this specific simulator.
 * Android discovery: `adb -s <serial> reverse --list` for forwarded Metro
 *   ports — already device-scoped.
 * Target selection: Metro's /json exposes `deviceName` (e.g. the simulator
 *   display name, or Android Build.MODEL). We resolve the device's display
 *   name from its UDID/serial and filter targets to only those matching —
 *   this disambiguates multiple devices sharing a single Metro instance.
 */
import http from 'http';
import { LogEntry, LogSource, LEVEL_SEVERITY } from '../drivers/log-sources/types.js';
import { IOSLogSource } from '../drivers/log-sources/ios.js';
import { AndroidLogSource } from '../drivers/log-sources/android.js';
import { MetroLogSource, fetchTargets } from '../drivers/log-sources/metro.js';
import {
  discoverMetroPortForDevice,
  getDeviceDisplayName,
  selectTargetForDevice,
} from '../drivers/log-sources/metro-discovery.js';

const MAX_BUFFER = 5000;
const RESTART_DELAY_MS = 2000;
const WEB_POLL_INTERVAL_MS = 500;
// Metro discovery retries forever while the daemon is alive — the app may be
// launched long after the daemon starts. Backoff grows to a ceiling so we're
// not wasteful when discovery keeps failing (e.g. native-only app).
const METRO_DISCOVERY_MIN_INTERVAL_MS = 1_500;
const METRO_DISCOVERY_MAX_INTERVAL_MS = 15_000;

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
  private metroDiscoveryAttempts = 0;
  private cachedDeviceName: string | null = null;
  private lastAnnouncedState: 'none' | 'searching' | 'connected' = 'none';

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

    // Metro is always auto-discovered. Discovery retries forever with a
    // backoff ceiling — the app may be launched long after the daemon starts,
    // and the cost per attempt is tiny (a few spawns + one HTTP call).
    if (this.platform === 'ios' || this.platform === 'tvos' || this.platform === 'android') {
      this.startMetroAutoDiscovery();
    }
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

  // ── Metro auto-discovery (deterministic) ─────────────────────────────────

  private startMetroAutoDiscovery(): void {
    if (this.stopped || this.metroConnected) return;
    void this.tryDiscoverAndConnect();
  }

  private async tryDiscoverAndConnect(): Promise<void> {
    if (this.stopped || this.metroConnected) return;

    this.metroDiscoveryAttempts++;
    try {
      const port = await discoverMetroPortForDevice(this.platform, this.deviceId);
      if (port !== null) {
        const connected = await this.connectMetro(port);
        if (connected) return;
      }
    } catch {
      // fall through to retry
    }

    // Announce "searching" exactly once so callers can tell discovery is live.
    if (this.lastAnnouncedState === 'none' && this.metroDiscoveryAttempts >= 3) {
      this.lastAnnouncedState = 'searching';
      this.pushSyntheticMetroEntry(
        `[conductor] Searching for Metro connection on device ${this.deviceId}… (this is normal for native apps — ignore if not using React Native)`
      );
    }

    if (!this.stopped) {
      const delay = Math.min(
        METRO_DISCOVERY_MIN_INTERVAL_MS * Math.pow(1.5, this.metroDiscoveryAttempts - 1),
        METRO_DISCOVERY_MAX_INTERVAL_MS
      );
      this.metroDiscoveryTimer = setTimeout(() => {
        this.metroDiscoveryTimer = null;
        void this.tryDiscoverAndConnect();
      }, delay);
    }
  }

  /**
   * Push a synthetic log entry into the buffer so that Metro connection state
   * is visible to anyone reading the log stream.
   */
  private pushSyntheticMetroEntry(message: string): void {
    this.pushEntry({
      timestamp: new Date().toISOString(),
      level: 'info',
      message,
      stackTrace: null,
      source: 'metro',
    });
  }

  /** Metro connection state for the /status endpoint. */
  getMetroStatus(): { connected: boolean; port: number | null; attempts: number } {
    return {
      connected: this.metroConnected,
      port: this.metroPort,
      attempts: this.metroDiscoveryAttempts,
    };
  }

  /**
   * Connect to Metro on the given port, picking the target matching this
   * device's display name. Returns true on success.
   */
  private async connectMetro(port: number): Promise<boolean> {
    if (this.stopped || this.metroConnected) return false;

    try {
      const targets = await fetchTargets(port, 'localhost');
      const displayName =
        this.cachedDeviceName ?? (await getDeviceDisplayName(this.platform, this.deviceId));
      if (!displayName) return false;
      this.cachedDeviceName = displayName;

      const target = selectTargetForDevice(targets, displayName);
      if (!target?.webSocketDebuggerUrl) return false;

      const withWs = targets.filter((t) => t.webSocketDebuggerUrl);
      const targetIndex = withWs.indexOf(target);

      this.metroSource = new MetroLogSource(
        port,
        'localhost',
        targetIndex >= 0 ? targetIndex : undefined
      );
      this.metroSource.onEntry((entry) => this.pushEntry(entry));
      await this.metroSource.connect();
      this.metroConnected = true;
      this.metroPort = port;
      this.lastAnnouncedState = 'connected';
      this.pushSyntheticMetroEntry(
        `[conductor] Metro connected on port ${port} for device "${displayName}"`
      );
      this.dlog?.(`Metro connected for device ${this.deviceId} on port ${port}`);
      return true;
    } catch {
      return false;
    }
  }
}
