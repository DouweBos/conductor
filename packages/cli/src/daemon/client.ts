import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { socketPath, pidFile, logFile } from './protocol.js';
import { log } from '../verbose.js';
import { webBrowserName } from '../drivers/bootstrap.js';

const STARTUP_POLL_MS = 200;
const STARTUP_MAX_WAIT_MS = 10000;

async function socketExists(sessionName: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection(socketPath(sessionName));
    sock.on('connect', () => {
      sock.destroy();
      resolve(true);
    });
    sock.on('error', () => resolve(false));
    sock.setTimeout(500);
    sock.on('timeout', () => {
      sock.destroy();
      resolve(false);
    });
  });
}

async function waitForDaemon(sessionName: string): Promise<boolean> {
  const deadline = Date.now() + STARTUP_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    if (await socketExists(sessionName)) return true;
    await new Promise((r) => setTimeout(r, STARTUP_POLL_MS));
  }
  return false;
}

export async function startDaemon(sessionName = 'default'): Promise<boolean> {
  if (await socketExists(sessionName)) return true;

  const serverScript = path.join(__dirname, 'server.js');
  log(`daemon [${sessionName}] not running — spawning ${serverScript}`);
  const child = spawn(process.execPath, [serverScript, sessionName], {
    detached: true,
    stdio: 'ignore',
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
  for (const file of [socketPath(sessionName), pidFile(sessionName), logFile(sessionName)]) {
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

export async function daemonStatus(
  sessionName = 'default'
): Promise<{ running: boolean; pid?: number }> {
  const running = await socketExists(sessionName);
  if (!running) return { running: false };
  try {
    const pid = parseInt(fs.readFileSync(pidFile(sessionName), 'utf-8').trim(), 10);
    return { running: true, pid: isNaN(pid) ? undefined : pid };
  } catch {
    return { running: true };
  }
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
