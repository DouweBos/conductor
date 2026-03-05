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

export const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
