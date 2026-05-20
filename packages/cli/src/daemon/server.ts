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
import { ensureAndroidEnv } from '../android/sdk.js';
import {
  detectPlatform,
  getDriverPort,
  getIOSDylibPort,
  getIOSSimDriverPort,
  installDriver,
  startIOSDriver,
  startIOSDylibDriver,
  startIOSSimDriver,
  startAndroidDriver,
  startTvOSDriver,
  stopIOSDriver,
  stopIOSDylibDriver,
  stopIOSSimDriver,
  stopAndroidDriver,
  uninstallDriver,
  isPortOpen,
  isSimulatorBooted,
  webBrowserName,
  ensurePlaywrightBrowser,
} from '../drivers/bootstrap.js';
import { AndroidDriver } from '../drivers/android.js';
import { startWebServer, stopWebServer, getCdpPort, getPageTargetId } from './web-server.js';
import { LogCollector } from './log-collector.js';
import { getSession } from '../session.js';

const sessionName = process.argv[2] ?? 'default';

/**
 * CDP URL for connecting to an external browser (e.g. Stagehand's embedded
 * webview). When set, the web driver attaches via Playwright's connectOverCDP
 * instead of launching its own browser.
 *
 * Set by the host IDE (Stagehand) via the agent subprocess environment.
 */
const cdpUrl = process.env.CONDUCTOR_CDP_URL || undefined;

/**
 * Optional CDP target ID to pick a specific page when the host app exposes
 * multiple webviews over one CDP endpoint (e.g. one per workspace in
 * Stagehand). When set, the web driver finds the page whose underlying
 * `Target.targetId` matches and attaches to it, instead of falling back to
 * URL heuristics.
 */
const cdpTargetId = process.env.CONDUCTOR_CDP_TARGET_ID || undefined;

/**
 * PID of the process that should be considered the daemon's "owner". When set,
 * the daemon polls for this process's existence and shuts down cleanly when it
 * disappears. This prevents orphaned daemons (and their Playwright browsers)
 * from piling up after the host app crashes or quits without calling
 * `daemon-stop`.
 *
 * The daemon runs detached, so `process.ppid` becomes 1 after the parent exits
 * and is useless for this purpose. The owner must be passed explicitly by the
 * host app via the env when it invokes `conductor daemon-start` (or whatever
 * code path ultimately triggers the daemon spawn).
 */
const parentPid = (() => {
  const raw = process.env.CONDUCTOR_PARENT_PID;
  if (!raw) return undefined;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
})();

const PARENT_POLL_INTERVAL_MS = 10_000;

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

/**
 * iOS driver impl selected at daemon-start. `xctest` (default) uses only the
 * bundled XCUITest driver. `dylib` adds the experimental in-process driver
 * alongside XCUITest and routes five interaction routes through it. Switching
 * impls requires daemon-stop first — we don't swap mid-flight.
 */
const iosDriverImpl: 'xctest' | 'dylib' =
  process.env.CONDUCTOR_IOS_DRIVER === 'dylib' ? 'dylib' : 'xctest';

/**
 * When `iosDriverImpl === 'dylib'`, the per-device port the in-process dylib
 * listens on. Allocated from `~/.conductor/ports.json` base 1076. Surfaced in
 * `/status` so `daemon-status` can show it.
 */
let iosDylibPort: number | null = null;

/**
 * Port the host-side sim-driver listens on. Always allocated on iOS sessions
 * (sim-driver is unconditional — not gated by --ios-driver dylib). Failure
 * to start the sim-driver is non-fatal: surfaced on /status and the CLI's
 * IOSDriver falls back to XCUITest for HID routes.
 */
let iosSimDriverPort: number | null = null;

const DRIVER_HEALTH_INTERVAL_MS = 10000; // Check driver health every 10s

let _restartInProgress = false;
let _driverStarted = false;
let _driverStartError: string | null = null;

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
        await startWebServer(driverPort, webBrowserName(sessionName), dlog, cdpUrl, cdpTargetId);
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
  ensureAndroidEnv();
  // Ensure per-session daemon directory exists
  fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
  fs.writeFileSync(PID_FILE, String(process.pid));
  dlog(`daemon started pid=${process.pid} session=${sessionName}`);
  dlog(
    `env CONDUCTOR_CDP_URL=${cdpUrl ?? '<unset>'} CONDUCTOR_CDP_TARGET_ID=${cdpTargetId ?? '<unset>'}`
  ); // kept intentionally — useful for future diagnosis of CDP attachment issues

  // Remove stale socket
  try {
    fs.unlinkSync(SOCKET_PATH);
  } catch {
    /* ok */
  }

  let idleTimer: NodeJS.Timeout | undefined;
  let healthTimer: NodeJS.Timeout | undefined;
  let parentWatchTimer: NodeJS.Timeout | undefined;

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
    if (parentWatchTimer) clearInterval(parentWatchTimer);
    if (idleTimer) clearTimeout(idleTimer);
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
            // Stop the host-side sim-driver process (unconditional on iOS).
            try {
              await stopIOSSimDriver(sessionName);
            } catch (err) {
              dlog(`Stop iOS sim-driver error: ${err instanceof Error ? err.message : String(err)}`);
            }
            if (iosDriverImpl === 'dylib') {
              try {
                await stopIOSDylibDriver(sessionName);
              } catch (err) {
                dlog(
                  `Stop iOS dylib error: ${err instanceof Error ? err.message : String(err)}`
                );
              }
            }
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

  // If the host app told us who it is, shut down when it disappears. This is
  // the primary defence against orphaned daemons + headless Chromiums when the
  // host app crashes or force-quits without calling daemon-stop.
  if (parentPid !== undefined) {
    dlog(`Watching parent pid ${parentPid}`);
    let shuttingDown = false;
    parentWatchTimer = setInterval(() => {
      if (shuttingDown) return;
      try {
        process.kill(parentPid, 0);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ESRCH') {
          shuttingDown = true;
          dlog(`Parent pid ${parentPid} exited — shutting down`);
          cleanup().then(() => process.exit(0));
        }
        // EPERM means the process exists but we can't signal it — still alive.
      }
    }, PARENT_POLL_INTERVAL_MS);
    parentWatchTimer.unref();
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
      jsonResponse(res, {
        ok: true,
        platform: driverPlatform,
        driverPort,
        // Active iOS driver impl. Always populated on iOS sessions; null elsewhere.
        iosDriverImpl: driverPlatform === 'ios' ? iosDriverImpl : null,
        // Port of the in-process dylib listener, when iosDriverImpl === 'dylib'.
        iosDylibPort,
        // Port of the host-side sim-driver HID listener (CoreSimulator-backed).
        // Always populated on iOS sessions when the sim-driver started OK.
        iosSimDriverPort,
        cdpUrl: cdpUrl ?? null,
        cdpTargetId: cdpTargetId ?? null,
        chromiumCdpPort: driverPlatform === 'web' ? getCdpPort() : null,
        pageTargetId: driverPlatform === 'web' ? getPageTargetId() : null,
        driverStartError: _driverStartError,
        metro: logCollector?.getMetroStatus() ?? null,
      });
      return;
    }

    if (req.method === 'GET' && parsed.pathname === '/logs') {
      if (!logCollector) {
        jsonResponse(res, { entries: [] });
        return;
      }
      const q = parsed.query;

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
            // Even if the XCUITest driver is already up, the sim-driver may
            // not be — try to allocate and start it so HID routes get the
            // fast path on subsequent commands.
            if (platform === 'ios') {
              try {
                iosSimDriverPort = await getIOSSimDriverPort(sessionName);
                if (!(await isPortOpen(iosSimDriverPort))) {
                  dlog(`Starting iOS sim-driver on port ${iosSimDriverPort}`);
                  await startIOSSimDriver(sessionName, iosSimDriverPort);
                } else {
                  dlog(`iOS sim-driver already running on port ${iosSimDriverPort}`);
                }
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                dlog(`iOS sim-driver startup failed (continuing with XCUITest-only HID): ${msg}`);
                iosSimDriverPort = null;
              }
            }
          } else {
            // Android: install APKs before starting the driver.
            // iOS/tvOS: xcodebuild installs silently via DependentProductPaths.
            // Web: ensure Playwright browser binary is installed.
            if (platform === 'android') {
              dlog(`Installing Android driver on ${sessionName}`);
              await installDriver(sessionName);
              dlog(`Driver installation complete`);
            } else if (platform === 'web' && !cdpUrl) {
              // Only install Playwright browser when launching standalone.
              // In CDP mode we attach to the host app's browser (e.g. Electron).
              const browser = webBrowserName(sessionName);
              await ensurePlaywrightBrowser(browser, dlog);
            }

            dlog(`Starting ${platform} driver on port ${driverPort}`);
            try {
              if (platform === 'ios') {
                await startIOSDriver(sessionName, driverPort);
                // Sim-driver: unconditional for iOS sessions. Failure is
                // non-fatal — log and continue with XCUITest-only HID. The
                // CLI's IOSDriver falls back transparently when the port
                // isn't reachable.
                try {
                  iosSimDriverPort = await getIOSSimDriverPort(sessionName);
                  dlog(`Starting iOS sim-driver on port ${iosSimDriverPort}`);
                  await startIOSSimDriver(sessionName, iosSimDriverPort);
                } catch (err) {
                  const msg = err instanceof Error ? err.message : String(err);
                  dlog(`iOS sim-driver startup failed (continuing with XCUITest-only HID): ${msg}`);
                  iosSimDriverPort = null;
                  // Don't overwrite a more important driver error.
                  if (!_driverStartError) {
                    _driverStartError = `iOS sim-driver: ${msg}`;
                  }
                }
                if (iosDriverImpl === 'dylib') {
                  iosDylibPort = await getIOSDylibPort(sessionName);
                  dlog(
                    `iOS dylib opt-in: allocating port ${iosDylibPort} and injecting DYLD_INSERT_LIBRARIES`
                  );
                  try {
                    await startIOSDylibDriver(sessionName, iosDylibPort);
                  } catch (err) {
                    // Dylib startup failure is non-fatal — the XCUITest driver
                    // is already up and will serve all routes. Surface it on
                    // /status via driverStartError so daemon-status flags it.
                    const msg = err instanceof Error ? err.message : String(err);
                    dlog(`iOS dylib injection failed (continuing with XCUITest only): ${msg}`);
                    _driverStartError = `iOS dylib injection failed: ${msg}`;
                  }
                }
              } else if (platform === 'tvos') {
                if (iosDriverImpl === 'dylib') {
                  // tvOS doesn't support DYLD_INSERT_LIBRARIES on the
                  // appletvsimulator the same way iphonesimulator does, and
                  // we don't ship a tvOS-targeted dylib. Surface the downgrade
                  // on /status so daemon-status can warn the user — silently
                  // falling back without telling anyone makes the flag look
                  // broken when it's actually a platform mismatch.
                  const msg =
                    '--ios-driver dylib was requested but tvOS is not supported — falling back to xctest';
                  dlog(msg);
                  _driverStartError = msg;
                }
                // First install — dismiss the runner app to return to homescreen
                await startTvOSDriver(sessionName, driverPort, /* dismissAfterLaunch */ true);
              } else if (platform === 'web') {
                await startWebServer(
                  driverPort,
                  webBrowserName(sessionName),
                  dlog,
                  cdpUrl,
                  cdpTargetId
                );
              } else {
                await startAndroidDriver(sessionName, driverPort);
              }
              _driverStarted = true;
              dlog(`Driver started successfully`);
            } catch (err) {
              _driverStartError = err instanceof Error ? err.message : String(err);
              dlog(`Driver startup error: ${_driverStartError}`);
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
