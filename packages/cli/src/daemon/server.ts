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
import net from 'net';
import fs from 'fs';
import path from 'path';
import { socketPath, pidFile, logFile, IDLE_TIMEOUT_MS } from './protocol.js';
import {
  detectPlatform,
  getDriverPort,
  installDriver,
  startIOSDriver,
  startAndroidDriver,
  stopIOSDriver,
  stopAndroidDriver,
  uninstallDriver,
  isPortOpen,
  isSimulatorBooted,
} from '../drivers/bootstrap.js';

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
let driverPlatform: 'ios' | 'android' = 'ios';

const DRIVER_HEALTH_INTERVAL_MS = 10000; // Check driver health every 10s

let _restartInProgress = false;

async function ensureDriverRunning(): Promise<void> {
  if (_restartInProgress) return;
  const alive = await isPortOpen(driverPort);
  if (!alive) {
    if (driverPlatform === 'ios' && !(await isSimulatorBooted(sessionName))) {
      dlog(`Simulator ${sessionName} is not booted — skipping driver restart`);
      return;
    }
    _restartInProgress = true;
    dlog(`Driver on port ${driverPort} not responding — restarting`);
    try {
      if (driverPlatform === 'ios') {
        await startIOSDriver(sessionName, driverPort);
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

    if (sessionName !== 'default') {
      dlog(`Stopping driver on port ${driverPort}`);
      try {
        if (driverPlatform === 'ios') {
          await stopIOSDriver(sessionName);
        } else {
          await stopAndroidDriver(sessionName);
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

  // Create socket — accept connections as aliveness pings (no message exchange needed)
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    resetIdleTimer();
    // Close immediately — the connect/accept is enough for daemonStatus()
    socket.end();
    socket.on('error', () => {
      /* ignore */
    });
  });

  server.listen(SOCKET_PATH, () => {
    dlog(`socket ready at ${SOCKET_PATH}`);
    resetIdleTimer();

    // Start driver in the background after the socket is ready (so the client
    // doesn't time out waiting for the socket while the driver is starting).
    if (sessionName !== 'default') {
      detectPlatform(sessionName)
        .then(async (platform) => {
          driverPlatform = platform;
          driverPort = await getDriverPort(platform, sessionName);
          dlog(`Platform: ${platform}, port: ${driverPort}`);

          if (await isPortOpen(driverPort)) {
            dlog(`Driver already running on port ${driverPort}`);
            return;
          }

          // Android: install APKs before starting the driver.
          // iOS: startIOSDriver uses xcodebuild which installs silently via DependentProductPaths.
          if (platform === 'android') {
            dlog(`Installing Android driver on ${sessionName}`);
            await installDriver(sessionName);
            dlog(`Driver installation complete`);
          }

          dlog(`Starting ${platform} driver on port ${driverPort}`);
          try {
            if (platform === 'ios') {
              await startIOSDriver(sessionName, driverPort);
            } else {
              await startAndroidDriver(sessionName, driverPort);
            }
            dlog(`Driver started successfully`);
          } catch (err) {
            dlog(`Driver startup error: ${err instanceof Error ? err.message : String(err)}`);
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
