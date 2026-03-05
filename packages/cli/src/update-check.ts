import fs from 'fs';
import https from 'https';
import os from 'os';
import path from 'path';
import { findPkgRoot } from './pkg-root.js';

const CACHE_FILE = path.join(os.homedir(), '.conductor', 'update-check.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const REGISTRY_URL = 'https://registry.npmjs.org/@houwert/conductor/latest';

interface UpdateCache {
  checkedAt: number;
  latestVersion: string;
}

function readCache(): UpdateCache | null {
  try {
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    return JSON.parse(raw) as UpdateCache;
  } catch {
    return null;
  }
}

function writeCache(data: UpdateCache): void {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data));
  } catch {
    // ignore write failures
  }
}

function fetchLatestVersion(): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(REGISTRY_URL, { timeout: 3000 }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      res.on('end', () => {
        try {
          const data = JSON.parse(body) as { version: string };
          resolve(data.version);
        } catch {
          reject(new Error('Failed to parse registry response'));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Registry request timed out'));
    });
  });
}

function parseVersion(v: string): number[] {
  return v.split('.').map(Number);
}

function isNewer(latest: string, current: string): boolean {
  const l = parseVersion(latest);
  const c = parseVersion(current);
  for (let i = 0; i < 3; i++) {
    const li = l[i] ?? 0;
    const ci = c[i] ?? 0;
    if (li > ci) return true;
    if (li < ci) return false;
  }
  return false;
}

function getOwnVersion(): string {
  try {
    const pkgPath = path.join(findPkgRoot(__dirname), 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version: string };
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

export function checkForUpdates(): void {
  if (process.env['CONDUCTOR_NO_UPDATE_CHECK'] === '1') return;

  // Fire-and-forget: run async without blocking
  void (async () => {
    try {
      const now = Date.now();
      const cache = readCache();
      let latestVersion: string;

      if (cache && now - cache.checkedAt < CACHE_TTL_MS) {
        latestVersion = cache.latestVersion;
      } else {
        latestVersion = await fetchLatestVersion();
        writeCache({ checkedAt: now, latestVersion });
      }

      const currentVersion = getOwnVersion();
      if (isNewer(latestVersion, currentVersion)) {
        process.stderr.write(
          `\nA new version of conductor is available: ${latestVersion} (you have ${currentVersion})\n` +
            `Run: npm install -g @houwert/conductor\n`
        );
      }
    } catch {
      // Never surface update-check errors to the user
    }
  })();
}
