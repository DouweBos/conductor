export const HELP = `  device-pool --list                  List all devices and pool status
  device-pool --acquire               Claim a free device (prints device ID)
  device-pool --release <id>          Release a device back to the pool`;

/**
 * device-pool: Manage a pool of available devices for concurrent multi-agent use.
 *
 * Pool state is stored in ~/.conductor/device-pool.json with file-based locking.
 *
 * Usage:
 *   conductor device-pool --list             # list all devices and pool status
 *   conductor device-pool --acquire          # claim a free device, print its ID
 *   conductor device-pool --release <id>     # release a device back to the pool
 */
import os from 'os';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { printSuccess, printError, OutputOptions } from '../output.js';

function poolFilePath(): string {
  return (
    process.env.__CONDUCTOR_POOL_FILE ?? path.join(os.homedir(), '.conductor', 'device-pool.json')
  );
}
const LOCK_TIMEOUT_MS = 5000;

interface PoolEntry {
  deviceId: string;
  acquiredBy?: string; // process PID that acquired it
  acquiredAt?: number; // timestamp
}

interface PoolState {
  devices: PoolEntry[];
}

// ── File locking ──────────────────────────────────────────────────────────────

async function withLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const lockFile = poolFilePath() + '.lock';
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const fd = fs.openSync(lockFile, 'wx'); // exclusive create
      fs.closeSync(fd);
      try {
        return await Promise.resolve(fn());
      } finally {
        try {
          fs.unlinkSync(lockFile);
        } catch {
          /* ok */
        }
      }
    } catch {
      await sleep(50);
    }
  }
  throw new Error('Could not acquire device pool lock');
}

function readPool(): PoolState {
  try {
    const raw = fs.readFileSync(poolFilePath(), 'utf-8');
    return JSON.parse(raw) as PoolState;
  } catch {
    return { devices: [] };
  }
}

function writePool(state: PoolState): void {
  const p = poolFilePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(state, null, 2));
}

// ── Device discovery ──────────────────────────────────────────────────────────

/** Override for tests — when set, discoverAllDevices() returns this instead of probing. */
export let _testDeviceOverride: string[] | undefined;

async function discoverAllDevices(): Promise<string[]> {
  if (_testDeviceOverride) return _testDeviceOverride;
  const devices: string[] = [];

  // Android: adb devices
  try {
    const out = await spawnCapture('adb', ['devices', '-l']);
    for (const line of out.split('\n').slice(1)) {
      const id = line.trim().split(/\s+/)[0];
      if (id && !line.includes('offline') && id !== '') {
        devices.push(id);
      }
    }
  } catch {
    /* adb not available */
  }

  // iOS: xcrun simctl list booted
  try {
    const out = await spawnCapture('xcrun', ['simctl', 'list', 'devices', 'booted', '--json']);
    const parsed = JSON.parse(out) as {
      devices: Record<string, Array<{ udid: string; state: string }>>;
    };
    for (const sims of Object.values(parsed.devices)) {
      for (const sim of sims) {
        if (sim.state === 'Booted') devices.push(sim.udid);
      }
    }
  } catch {
    /* xcrun not available */
  }

  return devices;
}

function pruneStaleAcquisitions(state: PoolState): void {
  for (const entry of state.devices) {
    if (entry.acquiredBy) {
      try {
        process.kill(parseInt(entry.acquiredBy, 10), 0);
      } catch {
        delete entry.acquiredBy;
        delete entry.acquiredAt;
      }
    }
  }
}

// ── Commands ──────────────────────────────────────────────────────────────────

export async function devicePool(
  action: 'list' | 'acquire' | 'release',
  releaseId?: string,
  opts: OutputOptions = {}
): Promise<number> {
  if (action === 'list') {
    const allDevices = await discoverAllDevices();
    const pool = await withLock(() => {
      const state = readPool();
      pruneStaleAcquisitions(state);
      writePool(state);
      return state;
    });

    const rows = allDevices.map((id) => {
      const entry = pool.devices.find((e) => e.deviceId === id);
      const status = entry?.acquiredBy ? `acquired by PID ${entry.acquiredBy}` : 'free';
      return `${id}  ${status}`;
    });

    if (opts.json) {
      const data = allDevices.map((id) => {
        const entry = pool.devices.find((e) => e.deviceId === id);
        return { deviceId: id, free: !entry?.acquiredBy, acquiredBy: entry?.acquiredBy };
      });
      console.log(JSON.stringify({ status: 'ok', devices: data }));
    } else {
      if (rows.length === 0) {
        console.log('No devices found.');
      } else {
        console.log(rows.join('\n'));
      }
    }
    return 0;
  }

  if (action === 'acquire') {
    const allDevices = await discoverAllDevices();
    if (allDevices.length === 0) {
      printError('No devices available', opts);
      return 1;
    }

    const result = await withLock(() => {
      const state = readPool();
      pruneStaleAcquisitions(state);

      // Ensure all discovered devices are in the pool
      for (const id of allDevices) {
        if (!state.devices.find((e) => e.deviceId === id)) {
          state.devices.push({ deviceId: id });
        }
      }

      // Find a free device
      const free = state.devices.find((e) => allDevices.includes(e.deviceId) && !e.acquiredBy);
      if (!free) return null;

      free.acquiredBy = String(process.pid);
      free.acquiredAt = Date.now();
      writePool(state);
      return free.deviceId;
    });

    if (!result) {
      printError('No free devices available in pool', opts);
      return 1;
    }

    if (opts.json) {
      console.log(JSON.stringify({ status: 'ok', deviceId: result }));
    } else {
      console.log(result);
    }
    return 0;
  }

  if (action === 'release') {
    if (!releaseId) {
      printError('device-pool --release requires a device ID', opts);
      return 1;
    }

    await withLock(() => {
      const state = readPool();
      const entry = state.devices.find((e) => e.deviceId === releaseId);
      if (entry) {
        delete entry.acquiredBy;
        delete entry.acquiredAt;
        writePool(state);
      }
    });

    printSuccess(`Released device ${releaseId}`, opts);
    return 0;
  }

  printError('device-pool: unknown action', opts);
  return 1;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function spawnCapture(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    proc.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${cmd} failed (${code})`))
    );
    proc.on('error', reject);
  });
}
