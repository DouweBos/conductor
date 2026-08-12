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
  getInputPort,
  getStreamPort,
  getHidBinaryPath,
  getCaptureBinaryPath,
  installDriver,
  detectDeviceKind,
  resolveDriverHost,
  startDeviceDriver,
  stopDeviceDriver,
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
import { IOSDriver } from '../drivers/ios.js';
import { startWebServer, stopWebServer, getCdpPort, getPageTargetId } from './web-server.js';
import { startInputServer, type InputServerHandle } from './input-server.js';
import { InputRouter, type LivePointerBackend } from './input-router.js';
import { iosBackend, androidBackend, type InputBackend } from './input-backends.js';
import { IOSHidClient } from '../drivers/ios-hid.js';
import { startVideoServer, type VideoServerHandle } from './video-server.js';
import { IOSCaptureSource } from './video-source.js';
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
let driverPlatform: 'ios' | 'android' | 'tvos' | 'web' | 'vega' | 'roku' = 'ios';

/**
 * Host the driver is reachable on. Simulators and every non-Apple platform use
 * the host's loopback; a physical device runs the driver on its own, so we talk
 * to it over the network. Memoised — resolution goes through mDNS.
 */
let _driverHost: string | null = null;
async function driverHost(): Promise<string> {
  if (_driverHost) return _driverHost;
  if (driverPlatform !== 'ios' && driverPlatform !== 'tvos') return '127.0.0.1';
  _driverHost = await resolveDriverHost(sessionName).catch(() => '127.0.0.1');
  return _driverHost;
}
let logCollector: LogCollector | null = null;
let inputServer: InputServerHandle | null = null;
let inputPort: number | null = null;
let hidClient: IOSHidClient | null = null;
let videoServer: VideoServerHandle | null = null;
let streamPort: number | null = null;

/**
 * Start the streaming-input WebSocket server for the current device, once its
 * driver is up. iOS/tvOS/Android only — web keeps its per-event REST path.
 * Each connection gets a fresh router (its own pointer state) over a shared
 * driver instance.
 */
async function startInputServerForPlatform(): Promise<void> {
  if (inputServer) return;
  if (driverPlatform !== 'ios' && driverPlatform !== 'tvos' && driverPlatform !== 'android') return;

  let makeBackend: () => InputBackend;
  let livePointer: LivePointerBackend | undefined;
  if (driverPlatform === 'android') {
    const driver = new AndroidDriver(sessionName, driverPort);
    await driver.connect();
    makeBackend = () => androidBackend(driver);
  } else {
    const driver = new IOSDriver(
      driverPort,
      await driverHost(),
      sessionName,
      driverPlatform,
      (await detectDeviceKind(sessionName)) === 'physical'
    );
    makeBackend = () => iosBackend(driver);
    // Opt-in native held-touch backend for live drags (iOS only; single-touch).
    if (driverPlatform === 'ios' && process.env.CONDUCTOR_IOS_HID === '1') {
      const bin = await getHidBinaryPath();
      if (bin) {
        const client = new IOSHidClient(bin, sessionName);
        client.start();
        if (await client.ping().catch(() => false)) {
          hidClient = client;
          livePointer = client.asLivePointer();
          dlog('iOS HID injector active — live drags use CoreSimulator HID');
        } else {
          client.stop();
          dlog('iOS HID injector present but not responding — falling back to buffered drag');
        }
      } else {
        dlog('CONDUCTOR_IOS_HID=1 but no HID binary built — falling back to buffered drag');
      }
    }
  }

  const port = await getInputPort(sessionName);
  inputServer = await startInputServer({
    port,
    device: sessionName,
    platform: driverPlatform,
    makeRouter: () => new InputRouter(makeBackend(), { livePointer }),
    dlog,
  });
  inputPort = port;
  dlog(`input server listening on ${port}`);
}

/**
 * Start the streaming-video WebSocket server for the current device, once its
 * driver is up. iOS/tvOS only for now (host-side SimulatorKit capture); the
 * binary must be built/downloaded. Capture is lazy: it doesn't spawn until the
 * first subscriber connects, and stops when the last one leaves.
 */
async function startVideoServerForPlatform(): Promise<void> {
  if (videoServer) return;
  if (driverPlatform !== 'ios' && driverPlatform !== 'tvos') return;
  // Capture attaches to the Simulator's framebuffer via SimulatorKit, which has
  // no counterpart on real hardware.
  if ((await detectDeviceKind(sessionName)) === 'physical') {
    dlog('video capture is simulator-only — stream server disabled for this device');
    return;
  }

  const binary = await getCaptureBinaryPath();
  if (!binary) {
    dlog('video capture binary not present — stream server disabled for this device');
    return;
  }

  const port = await getStreamPort(sessionName);
  videoServer = await startVideoServer({
    port,
    device: sessionName,
    platform: driverPlatform,
    makeSource: (hub) => new IOSCaptureSource(binary, sessionName, hub, dlog),
    dlog,
  });
  streamPort = port;
  dlog(`video server listening on ${port}`);
}

const DRIVER_HEALTH_INTERVAL_MS = 10000; // Check driver health every 10s

let _restartInProgress = false;
let _driverStarted = false;
let _driverStartError: string | null = null;

async function ensureDriverRunning(): Promise<void> {
  if (_restartInProgress || !_driverStarted) return;
  // Vega and Roku have no driver process/port to health-check — control is
  // host-side (the vega CLI) or over the network (Roku ECP).
  if (driverPlatform === 'vega' || driverPlatform === 'roku') return;

  let alive: boolean;
  if (driverPlatform === 'android') {
    const probe = new AndroidDriver(sessionName, driverPort);
    await probe.connect();
    alive = await probe.isAlive().catch(() => false);
    probe.close();
  } else {
    // 'ios', 'tvos', and 'web' all use an HTTP server — port open = alive.
    // Physical devices answer on the LAN rather than the host's loopback.
    alive = await isPortOpen(driverPort, await driverHost());
  }

  if (!alive) {
    if (
      (driverPlatform === 'ios' || driverPlatform === 'tvos') &&
      (await detectDeviceKind(sessionName)) === 'simulator' &&
      !(await isSimulatorBooted(sessionName))
    ) {
      dlog(`Simulator ${sessionName} is not booted — skipping driver restart`);
      return;
    }
    _restartInProgress = true;
    dlog(`Driver on port ${driverPort} not responding — restarting`);
    try {
      if (
        (driverPlatform === 'ios' || driverPlatform === 'tvos') &&
        (await detectDeviceKind(sessionName)) === 'physical'
      ) {
        await startDeviceDriver(sessionName, driverPlatform, driverPort);
      } else if (driverPlatform === 'ios') {
        await startIOSDriver(sessionName, driverPort);
      } else if (driverPlatform === 'tvos') {
        // Health-check restart — don't dismiss, to avoid disrupting user's app
        await startTvOSDriver(sessionName, driverPort, /* restoreFocusAfterLaunch */ false);
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
    if (inputServer) {
      try {
        await inputServer.close();
      } catch {
        /* ok */
      }
      inputServer = null;
    }
    if (videoServer) {
      try {
        await videoServer.close();
      } catch {
        /* ok */
      }
      videoServer = null;
    }
    if (hidClient) {
      hidClient.stop();
      hidClient = null;
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
      } else if (driverPlatform === 'vega') {
        dlog('vega: no driver process to stop (control is host-side via the CLI)');
      } else if (driverPlatform === 'roku') {
        dlog('roku: no driver process to stop (control is ECP over the network)');
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
          if (driverPlatform === 'ios' && (await detectDeviceKind(sessionName)) === 'physical') {
            await stopDeviceDriver(sessionName, 'ios');
          } else if (driverPlatform === 'ios') {
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
        inputPort,
        streamPort,
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

          // Vega has no driver process — control is host-side via the vega CLI.
          // The daemon exists only to collect device + Metro logs.
          if (platform === 'vega') {
            _driverStarted = true;
            dlog('vega: no driver process to start; collecting logs only');
          } else if (platform === 'roku') {
            // Roku has neither a driver process nor a log stream to collect, so
            // the daemon has nothing to do — commands drive the device directly.
            _driverStarted = true;
            dlog('roku: no driver process and no device logs; daemon is idle');
          } else {
            await startDriverForPlatform(platform);
          }

          // Start the streaming-input socket once the driver is up.
          if (_driverStarted) {
            try {
              await startInputServerForPlatform();
            } catch (err) {
              dlog(
                `Input server startup error: ${err instanceof Error ? err.message : String(err)}`
              );
            }
            try {
              await startVideoServerForPlatform();
            } catch (err) {
              dlog(
                `Video server startup error: ${err instanceof Error ? err.message : String(err)}`
              );
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

/**
 * Bring up the driver process for a platform that has one. Sets `_driverStarted` /
 * `_driverStartError`. Extracted so the vega and roku paths can skip it entirely.
 */
async function startDriverForPlatform(platform: 'ios' | 'android' | 'tvos' | 'web'): Promise<void> {
  let driverAlive: boolean;
  if (platform === 'android') {
    const probe = new AndroidDriver(sessionName, driverPort);
    await probe.connect();
    driverAlive = await probe.isAlive().catch(() => false);
    probe.close();
  } else {
    // 'ios', 'tvos', and 'web' all use an HTTP server — port open = alive
    driverAlive = await isPortOpen(driverPort, await driverHost());
  }
  if (driverAlive) {
    _driverStarted = true;
    dlog(`Driver already running on port ${driverPort}`);
    return;
  }

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
    if (
      (platform === 'ios' || platform === 'tvos') &&
      (await detectDeviceKind(sessionName)) === 'physical'
    ) {
      await startDeviceDriver(sessionName, platform, driverPort);
    } else if (platform === 'ios') {
      await startIOSDriver(sessionName, driverPort);
    } else if (platform === 'tvos') {
      // First install — the runner takes foreground; ask it to hand
      // focus back to whatever app the user had open.
      await startTvOSDriver(sessionName, driverPort, /* restoreFocusAfterLaunch */ true);
    } else if (platform === 'web') {
      await startWebServer(driverPort, webBrowserName(sessionName), dlog, cdpUrl, cdpTargetId);
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

main().catch((err) => {
  console.error('Daemon error:', err);
  process.exit(1);
});
