/**
 * Integration tests for daemon idle-timeout shutdown.
 *
 * Spawns a real daemon process with a short CONDUCTOR_IDLE_TIMEOUT_MS so we
 * don't wait 5 minutes.  Uses a dedicated session name to avoid interfering
 * with any real daemon that may be running.
 */
import http from 'http';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import { TestSuite } from './runner.js';
import { socketPath, pidFile } from '../src/daemon/protocol.js';

// ── constants ─────────────────────────────────────────────────────────────────

const SESSION = '__test_idle__';
const SOCKET = socketPath(SESSION);
const PID_FILE = pidFile(SESSION);
const SHORT_TIMEOUT_MS = 400;
const POLL_MS = 50;

// ── helpers ───────────────────────────────────────────────────────────────────

/** Path to the compiled daemon server script (mirrors how client.ts resolves it). */
function serverScript(): string {
  // __dirname is dist-tests/tests/ at runtime; server compiles to dist-tests/src/daemon/
  return path.join(__dirname, '../src/daemon/server.js');
}

function spawnDaemon(): ChildProcess {
  return spawn(process.execPath, [serverScript(), SESSION], {
    detached: false,
    stdio: 'ignore',
    env: { ...process.env, CONDUCTOR_IDLE_TIMEOUT_MS: String(SHORT_TIMEOUT_MS) },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Wait for the daemon process to exit, with a timeout. */
function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) { done = true; resolve(false); }
    }, timeoutMs);
    child.once('exit', () => {
      if (!done) { done = true; clearTimeout(timer); resolve(true); }
    });
  });
}

/** Poll until the socket accepts connections, or deadline passes. */
async function waitForSocket(timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await socketConnectable()) return true;
    await sleep(POLL_MS);
  }
  return false;
}

function socketConnectable(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      { socketPath: SOCKET, path: '/status' },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      }
    );
    req.setTimeout(300);
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

/** Clean up the test session directory so each test starts fresh. */
function cleanupSession(): void {
  const dir = path.join(os.homedir(), '.conductor', 'daemons', SESSION);
  for (const f of [SOCKET, PID_FILE]) {
    try { fs.unlinkSync(f); } catch { /* ok */ }
  }
  try { fs.rmdirSync(dir); } catch { /* ok */ }
}

// ── suite ─────────────────────────────────────────────────────────────────────

export const daemonIdle = new TestSuite('Daemon idle-timeout');

daemonIdle.test('shuts down after idle timeout with no connections', async () => {
  cleanupSession();
  const child = spawnDaemon();

  try {
    const started = await waitForSocket();
    if (!started) throw new Error('daemon did not start within 5 s');

    // No connections after startup — idle timer fires after SHORT_TIMEOUT_MS.
    // Give it 3× as headroom. We track process exit (not socket) to avoid
    // resetting the timer via polling connections.
    const exited = await waitForExit(child, SHORT_TIMEOUT_MS * 3);
    if (!exited) throw new Error(`daemon still running ${SHORT_TIMEOUT_MS * 3} ms after last connection`);
  } finally {
    try { child.kill(); } catch { /* already exited */ }
    cleanupSession();
  }
});

daemonIdle.test('resets idle timer on each connection', async () => {
  cleanupSession();
  const child = spawnDaemon();

  try {
    const started = await waitForSocket();
    if (!started) throw new Error('daemon did not start within 5 s');

    // Connect every SHORT_TIMEOUT_MS/2 ms for 3 full timeout periods.
    // Each connection resets the timer, so the daemon must stay alive.
    const keepAliveEnd = Date.now() + SHORT_TIMEOUT_MS * 3;
    while (Date.now() < keepAliveEnd) {
      await socketConnectable();
      await sleep(SHORT_TIMEOUT_MS / 2);
    }

    // Daemon must still be running right after the keep-alive period.
    const stillUp = await socketConnectable();
    if (!stillUp) throw new Error('daemon exited early despite periodic connections');

    // Now stop connecting — daemon should shut down within SHORT_TIMEOUT_MS.
    // Use process exit event so we don't accidentally reset the timer by polling.
    const exited = await waitForExit(child, SHORT_TIMEOUT_MS * 3);
    if (!exited) throw new Error('daemon did not shut down after connections stopped');
  } finally {
    try { child.kill(); } catch { /* already exited */ }
    cleanupSession();
  }
});
