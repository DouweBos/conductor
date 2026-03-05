import fs from 'fs/promises';
import os from 'os';
import path from 'path';

export interface Session {
  appId?: string;
  deviceId?: string;
}

const CONDUCTOR_DIR = path.join(os.homedir(), '.conductor');
const SESSIONS_DIR = path.join(CONDUCTOR_DIR, 'sessions');
const LEGACY_SESSION_FILE = path.join(CONDUCTOR_DIR, 'session.json');

export function sessionFilePath(sessionName = 'default'): string {
  return path.join(SESSIONS_DIR, `${sessionName}.json`);
}

export async function getSession(sessionName = 'default'): Promise<Session> {
  try {
    const data = await fs.readFile(sessionFilePath(sessionName), 'utf-8');
    return JSON.parse(data) as Session;
  } catch {
    // For the default session, fall back to the legacy session.json
    if (sessionName === 'default') {
      try {
        const data = await fs.readFile(LEGACY_SESSION_FILE, 'utf-8');
        return JSON.parse(data) as Session;
      } catch {
        return {};
      }
    }
    return {};
  }
}

export async function saveSession(session: Session, sessionName = 'default'): Promise<void> {
  await fs.mkdir(SESSIONS_DIR, { recursive: true });
  await fs.writeFile(sessionFilePath(sessionName), JSON.stringify(session, null, 2));
}

export async function updateSession(
  updates: Partial<Session>,
  sessionName = 'default'
): Promise<Session> {
  const current = await getSession(sessionName);
  const updated = { ...current, ...updates };
  await saveSession(updated, sessionName);
  return updated;
}

export async function clearSession(sessionName = 'default'): Promise<void> {
  try {
    await fs.unlink(sessionFilePath(sessionName));
  } catch {
    // File doesn't exist — nothing to clear
  }
}

export async function listSessions(): Promise<string[]> {
  try {
    const files = await fs.readdir(SESSIONS_DIR);
    return files.filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
  } catch {
    return [];
  }
}
