import fs from 'fs';
import os from 'os';
import path from 'path';

const DIR = path.join(os.homedir(), '.conductor');

function daemonDir(sessionName = 'default'): string {
  return path.join(DIR, 'daemons', sessionName);
}

export function socketPath(sessionName = 'default'): string {
  return path.join(daemonDir(sessionName), 'daemon.sock');
}

export function pidFile(sessionName = 'default'): string {
  return path.join(daemonDir(sessionName), 'daemon.pid');
}

export function logFile(sessionName = 'default'): string {
  return path.join(daemonDir(sessionName), 'daemon.log');
}

export function nameFile(sessionName = 'default'): string {
  return path.join(daemonDir(sessionName), 'name');
}

export const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Identifies the daemon code on disk (its server.js mtime), so a client can
 * tell a daemon still running code from before an upgrade or rebuild.
 */
export function daemonBuildId(): number {
  try {
    return Math.round(fs.statSync(path.join(__dirname, 'server.js')).mtimeMs);
  } catch {
    return 0;
  }
}
