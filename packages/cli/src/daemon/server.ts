/**
 * Daemon process — run as a detached background process.
 *
 * Repurposed from the MCP proxy: now manages the underlying device driver process
 * (iOS XCTest HTTP server or Android gRPC instrumentation).
 *
 * The Unix socket is kept alive purely for status checks (daemonStatus() tests
 * if the socket is connectable). No tool-call proxying happens here.
 *
 * Spawned by: node dist/daemon/server.js [sessionName]
 */
import http from 'http';
import url from 'url';
import fs from 'fs';
import path from 'path';
import { socketPath, pidFile, logFile, IDLE_TIMEOUT_MS } from './protocol.js';
import {
  detectPlatform,
  getDriverPort,
  installDriver,
  startIOSDriver,
  startAndroidDriver,
  startTvOSDriver,
  stopIOSDriver,
  stopAndroidDriver,
  uninstallDriver,
  isPortOpen,
  isSimulatorBooted,
  webBrowserName,
  ensurePlaywrightBrowser,
} from '../drivers/bootstrap.js';
import { AndroidDriver } from '../drivers/android.js';
import { startWebServer, stopWebServer } from './web-server.js';
import { LogCollector } from './log-collector.js';
import { getSession } from '../session.js';

const sessionName = process.argv[2] ?? 'default';

const SOCKET_PATH = socketPath(sessionName);
const PID_FILE = pidFile(sessionName);
const LOG_FILE = logFile(sessionName);

function dlog(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    /* ignore */
  }
}

// ── Driver lifecycle ──────────────────────────────────────────────────────────

let driverPort = 1075;
let driverPlatform: 'ios' | 'android' | 'tvos' | 'web' = 'ios';
let logCollector: LogCollector | null = null;

const DRIVER_HEALTH_INTERVAL_MS = 10000; // Check driver health every 10s

let _restartInProgress = false;
let _driverStarted = false;

async function ensureDriverRunning(): Promise<void> {
  if (_restartInProgress || !_driverStarted) return;

  let alive: boolean;
  if (driverPlatform === 'android') {
    const probe = new AndroidDriver(sessionName, driverPort);
    await probe.connect();
    alive = await probe.isAlive().catch(() => false);
    probe.close();
  } else {
    // 'ios', 'tvos', and 'web' all use an HTTP server — port open = alive
    alive = await isPortOpen(driverPort);
  }

  if (!alive) {
    if (
      (driverPlatform === 'ios' || driverPlatform === 'tvos') &&
      !(await isSimulatorBooted(sessionName))
    ) {
      dlog(`Simulator ${sessionName} is not booted — skipping driver restart`);
      return;
    }
    _restartInProgress = true;
    dlog(`Driver on port ${driverPort} not responding — restarting`);
    try {
      if (driverPlatform === 'ios') {
        await startIOSDriver(sessionName, driverPort);
      } else if (driverPlatform === 'tvos') {
        // Health-check restart — don't dismiss, to avoid disrupting user's app
        await startTvOSDriver(sessionName, driverPort, /* dismissAfterLaunch */ false);
      } else if (driverPlatform === 'web') {
        await startWebServer(driverPort, webBrowserName(sessionName), dlog);
      } else {
        await startAndroidDriver(sessionName, driverPort);
      }
      dlog(`Driver restarted on port ${driverPort}`);
    } catch (err) {
      dlog(`Failed to restart driver: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      _restartInProgress = false;
    }
  }
}

// ── Daemon main ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Ensure per-session daemon directory exists
  fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
  fs.writeFileSync(PID_FILE, String(process.pid));
  dlog(`daemon started pid=${process.pid} session=${sessionName}`);

  // Remove stale socket
  try {
    fs.unlinkSync(SOCKET_PATH);
  } catch {
    /* ok */
  }

  let idleTimer: NodeJS.Timeout | undefined;
  let healthTimer: NodeJS.Timeout | undefined;

  const idleTimeoutMs = Number(process.env.CONDUCTOR_IDLE_TIMEOUT_MS) || IDLE_TIMEOUT_MS;

  function resetIdleTimer(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      dlog('Idle timeout reached — shutting down');
      cleanup().then(() => process.exit(0));
    }, idleTimeoutMs);
  }

  async function cleanup(): Promise<void> {
    if (healthTimer) clearInterval(healthTimer);
    if (logCollector) {
      logCollector.stop();
      logCollector = null;
    }
    try {
      fs.unlinkSync(SOCKET_PATH);
    } catch {
      /* ok */
    }
    try {
      fs.unlinkSync(PID_FILE);
    } catch {
      /* ok */
    }
    try {
      fs.unlinkSync(LOG_FILE);
    } catch {
      /* ok if non-empty or already gone */
    }
    try {
      fs.rmdirSync(path.dirname(PID_FILE));
    } catch {
      /* ok */
    }

    if (_driverStarted) {
      // tvOS: keep the driver process alive across daemon restarts.
      // Stopping/reinstalling steals foreground focus and destroys
      // the user's navigation state in the target app.
      if (driverPlatform === 'tvos') {
        dlog('tvOS: leaving driver running to preserve app state');
      } else if (driverPlatform === 'web') {
        dlog('Stopping web driver');
        try {
          await stopWebServer();
        } catch (err) {
          dlog(`Stop web driver error: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        dlog(`Stopping driver on port ${driverPort}`);
        try {
          if (driverPlatform === 'ios') {
            await stopIOSDriver(sessionName);
          } else {
            await stopAndroidDriver(sessionName, driverPort);
          }
        } catch (err) {
          dlog(`Stop driver error: ${err instanceof Error ? err.message : String(err)}`);
        }

        dlog(`Uninstalling driver from ${sessionName}`);
        try {
          await uninstallDriver(sessionName, driverPlatform);
        } catch (err) {
          dlog(`Uninstall driver error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  process.on('SIGTERM', () => {
    cleanup().then(() => process.exit(0));
  });
  process.on('SIGINT', () => {
    cleanup().then(() => process.exit(0));
  });

  // Periodically check driver health and restart if needed
  if (sessionName !== 'default') {
    healthTimer = setInterval(() => {
      ensureDriverRunning().catch((err) => dlog(`Health check error: ${err.message}`));
    }, DRIVER_HEALTH_INTERVAL_MS);
    healthTimer.unref(); // Don't keep the process alive just for health checks
  }

  // ── HTTP server on Unix socket ─────────────────────────────────────────────
  // Replaces the old raw-TCP accept-and-close with a proper HTTP server so we
  // can serve /status (aliveness) and /logs (buffered log entries).

  function jsonResponse(res: http.ServerResponse, body: unknown, status = 200): void {
    const json = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(json),
    });
    res.end(json);
  }

  const server = http.createServer((req, res) => {
    resetIdleTimer();

    const parsed = url.parse(req.url ?? '/', true);

    if (req.method === 'GET' && parsed.pathname === '/status') {
      jsonResponse(res, { ok: true, platform: driverPlatform, driverPort });
      return;
    }

    if (req.method === 'GET' && parsed.pathname === '/logs') {
      if (!logCollector) {
        jsonResponse(res, { entries: [] });
        return;
      }
      const q = parsed.query;

      // Opt-in Metro discovery: ?metro=8081 uses that port directly,
      // ?metro (no value) or ?metro=auto triggers auto-discovery.
      if (q.metro !== undefined) {
        const metroPort = typeof q.metro === 'string' ? parseInt(q.metro, 10) : NaN;
        if (metroPort > 0) {
          logCollector.enableMetro(metroPort);
        } else {
          logCollector.enableMetro(); // auto-discover
        }
      }

      const entries = logCollector.query({
        since: typeof q.since === 'string' ? q.since : undefined,
        level: typeof q.level === 'string' ? q.level : undefined,
        limit: typeof q.limit === 'string' ? parseInt(q.limit, 10) || undefined : undefined,
      });
      jsonResponse(res, { entries });
      return;
    }

    jsonResponse(res, { error: 'not found' }, 404);
  });

  server.listen(SOCKET_PATH, () => {
    dlog(`HTTP socket ready at ${SOCKET_PATH}`);
    resetIdleTimer();

    // Start driver in the background after the socket is ready (so the client
    // doesn't time out waiting for the socket while the driver is starting).
    if (sessionName !== 'default') {
      detectPlatform(sessionName)
        .then(async (platform) => {
          driverPlatform = platform;
          driverPort = await getDriverPort(platform, sessionName);
          dlog(`Platform: ${platform}, port: ${driverPort}`);

          let driverAlive: boolean;
          if (platform === 'android') {
            const probe = new AndroidDriver(sessionName, driverPort);
            await probe.connect();
            driverAlive = await probe.isAlive().catch(() => false);
            probe.close();
          } else {
            // 'ios', 'tvos', and 'web' all use an HTTP server — port open = alive
            driverAlive = await isPortOpen(driverPort);
          }
          if (driverAlive) {
            _driverStarted = true;
            dlog(`Driver already running on port ${driverPort}`);
          } else {
            // Android: install APKs before starting the driver.
            // iOS/tvOS: xcodebuild installs silently via DependentProductPaths.
            // Web: ensure Playwright browser binary is installed.
            if (platform === 'android') {
              dlog(`Installing Android driver on ${sessionName}`);
              await installDriver(sessionName);
              dlog(`Driver installation complete`);
            } else if (platform === 'web') {
              const browser = webBrowserName(sessionName);
              await ensurePlaywrightBrowser(browser, dlog);
            }

            dlog(`Starting ${platform} driver on port ${driverPort}`);
            try {
              if (platform === 'ios') {
                await startIOSDriver(sessionName, driverPort);
              } else if (platform === 'tvos') {
                // First install — dismiss the runner app to return to homescreen
                await startTvOSDriver(sessionName, driverPort, /* dismissAfterLaunch */ true);
              } else if (platform === 'web') {
                await startWebServer(driverPort, webBrowserName(sessionName), dlog);
              } else {
                await startAndroidDriver(sessionName, driverPort);
              }
              _driverStarted = true;
              dlog(`Driver started successfully`);
            } catch (err) {
              dlog(`Driver startup error: ${err instanceof Error ? err.message : String(err)}`);
            }
          }

          // Start collecting logs once the driver is (or was already) running.
          if (_driverStarted) {
            try {
              const session = await getSession(sessionName);
              logCollector = new LogCollector(
                platform,
                sessionName,
                driverPort,
                session.appId,
                dlog
              );
              await logCollector.start();
              dlog(`Log collector started${session.appId ? ` (appId=${session.appId})` : ''}`);
            } catch (err) {
              dlog(
                `Log collector startup error: ${err instanceof Error ? err.message : String(err)}`
              );
            }
          }
        })
        .catch((err) => {
          dlog(`Platform detection error: ${err instanceof Error ? err.message : String(err)}`);
        });
    }
  });
}

main().catch((err) => {
  console.error('Daemon error:', err);
  process.exit(1);
});
