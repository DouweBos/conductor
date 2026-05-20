import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { socketPath, pidFile, logFile, nameFile } from './protocol.js';
import { log } from '../verbose.js';
import { webBrowserName } from '../drivers/bootstrap.js';
import type { LogEntry } from '../drivers/log-sources/types.js';

const STARTUP_POLL_MS = 200;
const STARTUP_MAX_WAIT_MS = 10000;

interface DaemonStatus {
  ok?: boolean;
  platform?: string;
  driverPort?: number;
  /** iOS driver impl reported by the daemon (only meaningful when platform === 'ios'). */
  iosDriverImpl?: 'xctest' | 'dylib' | null;
  /** Port the in-process dylib listens on, when iosDriverImpl === 'dylib'. */
  iosDylibPort?: number | null;
  /**
   * Port the host-side sim-driver listens on. Always populated on iOS
   * sessions when the sim-driver started OK (it is unconditional, not
   * gated by --ios-driver). Null when start-up failed — the CLI's
   * IOSDriver then routes HID through XCUITest only.
   */
  iosSimDriverPort?: number | null;
  /**
   * Last driver-startup error reported by the daemon. Used for non-fatal
   * degradations like "iOS dylib injection failed — running with XCUITest only"
   * or "--ios-driver dylib requested on tvOS — falling back".
   */
  driverStartError?: string | null;
  cdpUrl?: string | null;
  cdpTargetId?: string | null;
}

async function fetchStatus(sessionName: string): Promise<DaemonStatus | null> {
  return new Promise((resolve) => {
    const req = http.get({ socketPath: socketPath(sessionName), path: '/status' }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve(null);
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')) as DaemonStatus);
        } catch {
          resolve(null);
        }
      });
    });
    req.setTimeout(500);
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
  });
}

async function socketExists(sessionName: string): Promise<boolean> {
  return (await fetchStatus(sessionName)) !== null;
}

async function waitForDaemon(sessionName: string): Promise<boolean> {
  const deadline = Date.now() + STARTUP_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    if (await socketExists(sessionName)) return true;
    await new Promise((r) => setTimeout(r, STARTUP_POLL_MS));
  }
  return false;
}

/**
 * Wait until a process with the given PID is no longer running.
 * Uses `process.kill(pid, 0)` which throws if the process is gone.
 */
async function waitForProcessExit(pid: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * True when the running daemon's CDP attachment matches the current process's
 * `CONDUCTOR_CDP_URL` / `CONDUCTOR_CDP_TARGET_ID` env. A mismatch means the
 * daemon would control the wrong browser (e.g. a standalone Playwright
 * instance when the caller expects to drive an embedded webview), so the
 * daemon must be restarted with the correct env.
 */
function daemonMatchesCdpEnv(status: DaemonStatus): boolean {
  const expectedCdpUrl = process.env.CONDUCTOR_CDP_URL ?? '';
  const expectedCdpTargetId = process.env.CONDUCTOR_CDP_TARGET_ID ?? '';
  const actualCdpUrl = status.cdpUrl ?? '';
  const actualCdpTargetId = status.cdpTargetId ?? '';
  return actualCdpUrl === expectedCdpUrl && actualCdpTargetId === expectedCdpTargetId;
}

export async function startDaemon(
  sessionName = 'default',
  opts: { iosDriverImpl?: 'xctest' | 'dylib' } = {}
): Promise<boolean> {
  const existing = await fetchStatus(sessionName);
  if (existing) {
    // Refuse to swap iOS driver impl mid-flight — the daemon's lifecycle
    // (launchctl setenv DYLD_INSERT_LIBRARIES, port allocation) is set up
    // at start and can't be changed without a full restart. Tell the user
    // to daemon-stop first.
    if (
      opts.iosDriverImpl &&
      existing.iosDriverImpl &&
      existing.iosDriverImpl !== opts.iosDriverImpl
    ) {
      throw new Error(
        `daemon [${sessionName}] is running with --ios-driver ${existing.iosDriverImpl} ` +
          `but --ios-driver ${opts.iosDriverImpl} was requested. ` +
          `Stop the daemon first: conductor daemon-stop --device ${sessionName}`
      );
    }
    if (daemonMatchesCdpEnv(existing)) return true;

    log(
      `daemon [${sessionName}] CDP env mismatch ` +
        `(daemon cdpUrl="${existing.cdpUrl ?? ''}" targetId="${existing.cdpTargetId ?? ''}", ` +
        `env cdpUrl="${process.env.CONDUCTOR_CDP_URL ?? ''}" targetId="${process.env.CONDUCTOR_CDP_TARGET_ID ?? ''}") — restarting`
    );

    // Capture the PID before stopDaemon removes the pidfile so we can wait
    // for the old process to actually exit before respawning. Otherwise the
    // old daemon's cleanup handler may unlink the new daemon's socket.
    let oldPid: number | undefined;
    try {
      const raw = fs.readFileSync(pidFile(sessionName), 'utf-8').trim();
      const n = parseInt(raw, 10);
      if (!isNaN(n)) oldPid = n;
    } catch {
      /* no pid — continue */
    }

    await stopDaemon(sessionName);
    if (oldPid !== undefined) await waitForProcessExit(oldPid);
  }

  const serverScript = path.join(__dirname, 'server.js');
  log(`daemon [${sessionName}] not running — spawning ${serverScript}`);
  // Forward CONDUCTOR_IOS_DRIVER (explicit opt-in) into the spawned daemon's
  // env. The daemon reads it on startup; subsequent commands hit the running
  // daemon and inherit its choice.
  const daemonEnv: NodeJS.ProcessEnv = { ...process.env };
  if (opts.iosDriverImpl) {
    daemonEnv.CONDUCTOR_IOS_DRIVER = opts.iosDriverImpl;
  }
  const child = spawn(process.execPath, [serverScript, sessionName], {
    detached: true,
    stdio: 'ignore',
    env: daemonEnv,
  });
  child.unref();

  log(`waiting for daemon [${sessionName}] to be ready...`);
  const ready = await waitForDaemon(sessionName);
  log(
    ready
      ? `daemon [${sessionName}] ready`
      : `daemon [${sessionName}] failed to start within timeout`
  );
  return ready;
}

export async function stopDaemon(sessionName = 'default'): Promise<boolean> {
  let killed = false;
  try {
    const pid = parseInt(fs.readFileSync(pidFile(sessionName), 'utf-8').trim(), 10);
    if (!isNaN(pid)) {
      process.kill(pid, 'SIGTERM');
      killed = true;
    }
  } catch {
    /* pid file missing or process already gone */
  }

  // Clean up the daemon directory regardless — removes stale dirs from crashed daemons
  const dir = path.join(os.homedir(), '.conductor', 'daemons', sessionName);
  for (const file of [
    socketPath(sessionName),
    pidFile(sessionName),
    logFile(sessionName),
    nameFile(sessionName),
  ]) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* ok */
    }
  }
  try {
    fs.rmdirSync(dir);
  } catch {
    /* ok if non-empty or already gone */
  }

  return killed;
}

export function listDaemonSessions(): string[] {
  const daemonsDir = path.join(os.homedir(), '.conductor', 'daemons');
  try {
    return fs.readdirSync(daemonsDir).filter((name) => {
      return fs.statSync(path.join(daemonsDir, name)).isDirectory();
    });
  } catch {
    return [];
  }
}

export async function daemonStatus(sessionName = 'default'): Promise<{
  running: boolean;
  pid?: number;
  iosDriverImpl?: 'xctest' | 'dylib' | null;
  iosDylibPort?: number | null;
  iosSimDriverPort?: number | null;
  driverStartError?: string | null;
}> {
  const status = await fetchStatus(sessionName);
  const running = status !== null;
  if (!running) return { running: false };
  let pid: number | undefined;
  try {
    const n = parseInt(fs.readFileSync(pidFile(sessionName), 'utf-8').trim(), 10);
    if (!isNaN(n)) pid = n;
  } catch {
    /* ok */
  }
  return {
    running: true,
    pid,
    iosDriverImpl: status?.iosDriverImpl ?? null,
    iosDylibPort: status?.iosDylibPort ?? null,
    iosSimDriverPort: status?.iosSimDriverPort ?? null,
    driverStartError: status?.driverStartError ?? null,
  };
}

/**
 * Find a running web daemon session that matches the given browser type.
 * Scans `~/.conductor/daemons/` for `web:*` directories whose daemon socket
 * is still alive. Returns the session name, or undefined if none found.
 */
export async function findRunningWebSession(
  browserName: 'chromium' | 'firefox' | 'webkit'
): Promise<string | undefined> {
  for (const session of listDaemonSessions()) {
    if (!(session === 'web' || session.startsWith('web:'))) continue;
    if (webBrowserName(session) !== browserName) continue;

    if (await socketExists(session)) return session;
  }
  return undefined;
}

/**
 * Fetch buffered log entries from the daemon's /logs HTTP endpoint.
 * Used by `conductor logs --recent` for snapshot access.
 *
 * The daemon always auto-discovers Metro for the device in this session and
 * merges JS console entries (source='metro') alongside platform logs.
 */
export async function fetchDaemonLogs(
  sessionName: string,
  opts: { since?: string; level?: string; limit?: number } = {}
): Promise<LogEntry[]> {
  const params = new URLSearchParams();
  if (opts.since) params.set('since', opts.since);
  if (opts.level) params.set('level', opts.level);
  if (opts.limit) params.set('limit', String(opts.limit));
  const qs = params.toString();
  const reqPath = qs ? `/logs?${qs}` : '/logs';

  return new Promise((resolve, reject) => {
    const req = http.get({ socketPath: socketPath(sessionName), path: reqPath }, (res) => {
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
    });
    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error('Timeout fetching daemon logs'));
    });
    req.on('error', reject);
  });
}
