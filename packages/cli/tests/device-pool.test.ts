/**
 * Tests for device-pool command.
 *
 * Covers:
 *  - acquire returns a device from discovered list
 *  - acquire marks device as not free
 *  - release frees a previously acquired device
 *  - acquire skips already-acquired devices
 *  - all-acquired returns exit code 1
 *  - list prunes stale (dead PID) acquisitions
 *  - acquire prunes stale acquisitions and reclaims freed device
 *  - no devices returns exit code 1
 *  - release without id returns exit code 1
 *  - list --json output format
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { devicePool, _testDeviceOverride } from '../src/commands/device-pool.js';
import { TestSuite, assert, runAll } from './runner.js';

const FAKE_DEVICES = ['AAAA-1111', 'BBBB-2222', 'CCCC-3333'];
// A PID that is (almost certainly) not running
const DEAD_PID = '999999';

let tmpDir: string;
let poolFile: string;

function setup(devices: string[] = FAKE_DEVICES): void {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-pool-test-'));
  poolFile = path.join(tmpDir, 'device-pool.json');
  process.env.__CONDUCTOR_POOL_FILE = poolFile;
  // Overwrite the mutable export — TypeScript import bindings are live
  (devicePoolModule()  as { _testDeviceOverride: string[] | undefined })._testDeviceOverride = devices;
}

function teardown(): void {
  delete process.env.__CONDUCTOR_POOL_FILE;
  (devicePoolModule() as { _testDeviceOverride: string[] | undefined })._testDeviceOverride = undefined;
  try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* ok */ }
}

/** Re-import to get the live module namespace so we can mutate _testDeviceOverride */
function devicePoolModule(): typeof import('../src/commands/device-pool.js') {
  // ESM live bindings: the imported _testDeviceOverride is read-only.
  // We need the module namespace object to write to it.
  // Since we already imported it at the top level, we can grab it from the require cache.
  // But in ESM-compiled-to-CJS (which this project uses), require works fine.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../src/commands/device-pool.js') as typeof import('../src/commands/device-pool.js');
}

function readPoolFile(): { devices: Array<{ deviceId: string; acquiredBy?: string; acquiredAt?: number }> } {
  return JSON.parse(fs.readFileSync(poolFile, 'utf-8'));
}

function writePoolFile(state: { devices: Array<{ deviceId: string; acquiredBy?: string; acquiredAt?: number }> }): void {
  fs.mkdirSync(path.dirname(poolFile), { recursive: true });
  fs.writeFileSync(poolFile, JSON.stringify(state, null, 2));
}

/** Capture console.log output during a callback */
async function captureLog(fn: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '));
  try { await fn(); } finally { console.log = orig; }
  return lines;
}

export const devicePoolSuite = new TestSuite('device-pool');

// ── acquire ──────────────────────────────────────────────────────────────────

devicePoolSuite.test('acquire returns a device and exit code 0', async () => {
  setup();
  try {
    const lines = await captureLog(async () => {
      const code = await devicePool('acquire');
      assert(code === 0, `expected exit 0, got ${code}`);
    });
    assert(FAKE_DEVICES.includes(lines[0]), `expected a fake device id, got "${lines[0]}"`);
  } finally { teardown(); }
});

devicePoolSuite.test('acquire marks device as acquired in pool file', async () => {
  setup();
  try {
    await captureLog(() => devicePool('acquire'));
    const pool = readPoolFile();
    const acquired = pool.devices.filter((d) => d.acquiredBy);
    assert(acquired.length === 1, `expected 1 acquired, got ${acquired.length}`);
    assert(acquired[0].acquiredBy === String(process.pid), `expected current PID, got ${acquired[0].acquiredBy}`);
  } finally { teardown(); }
});

devicePoolSuite.test('acquire skips already-acquired devices', async () => {
  setup();
  try {
    // Seed pool with first device acquired by current process
    writePoolFile({
      devices: [
        { deviceId: 'AAAA-1111', acquiredBy: String(process.pid), acquiredAt: Date.now() },
      ],
    });
    const lines = await captureLog(() => devicePool('acquire'));
    assert(lines[0] !== 'AAAA-1111', 'should not return already-acquired device');
    assert(FAKE_DEVICES.includes(lines[0]), `expected a different fake device, got "${lines[0]}"`);
  } finally { teardown(); }
});

devicePoolSuite.test('acquire returns exit 1 when all devices are acquired', async () => {
  setup(['AAAA-1111']);
  try {
    writePoolFile({
      devices: [{ deviceId: 'AAAA-1111', acquiredBy: String(process.pid), acquiredAt: Date.now() }],
    });
    const code = await devicePool('acquire');
    assert(code === 1, `expected exit 1, got ${code}`);
  } finally { teardown(); }
});

devicePoolSuite.test('acquire returns exit 1 when no devices exist', async () => {
  setup([]);
  try {
    const code = await devicePool('acquire');
    assert(code === 1, `expected exit 1, got ${code}`);
  } finally { teardown(); }
});

// ── release ──────────────────────────────────────────────────────────────────

devicePoolSuite.test('release frees a previously acquired device', async () => {
  setup();
  try {
    writePoolFile({
      devices: [{ deviceId: 'AAAA-1111', acquiredBy: String(process.pid), acquiredAt: Date.now() }],
    });
    const code = await devicePool('release', 'AAAA-1111');
    assert(code === 0, `expected exit 0, got ${code}`);
    const pool = readPoolFile();
    const entry = pool.devices.find((d) => d.deviceId === 'AAAA-1111');
    assert(entry !== undefined, 'device should still exist in pool');
    assert(entry!.acquiredBy === undefined, 'device should no longer be acquired');
  } finally { teardown(); }
});

devicePoolSuite.test('release without id returns exit 1', async () => {
  setup();
  try {
    const code = await devicePool('release');
    assert(code === 1, `expected exit 1, got ${code}`);
  } finally { teardown(); }
});

// ── list ─────────────────────────────────────────────────────────────────────

devicePoolSuite.test('list shows all discovered devices', async () => {
  setup();
  try {
    const lines = await captureLog(() => devicePool('list'));
    for (const id of FAKE_DEVICES) {
      assert(lines.some((l) => l.includes(id)), `expected device ${id} in output`);
    }
  } finally { teardown(); }
});

devicePoolSuite.test('list --json returns structured output', async () => {
  setup();
  try {
    writePoolFile({
      devices: [{ deviceId: 'AAAA-1111', acquiredBy: String(process.pid), acquiredAt: Date.now() }],
    });
    const lines = await captureLog(() => devicePool('list', undefined, { json: true }));
    const parsed = JSON.parse(lines[0]);
    assert(parsed.status === 'ok', `expected status ok, got ${parsed.status}`);
    assert(Array.isArray(parsed.devices), 'expected devices array');
    const a = parsed.devices.find((d: { deviceId: string }) => d.deviceId === 'AAAA-1111');
    assert(a && a.free === false, 'AAAA-1111 should be not free');
    const b = parsed.devices.find((d: { deviceId: string }) => d.deviceId === 'BBBB-2222');
    assert(b && b.free === true, 'BBBB-2222 should be free');
  } finally { teardown(); }
});

// ── stale PID pruning ────────────────────────────────────────────────────────

devicePoolSuite.test('list prunes stale acquisitions from dead PIDs', async () => {
  setup();
  try {
    writePoolFile({
      devices: [{ deviceId: 'AAAA-1111', acquiredBy: DEAD_PID, acquiredAt: Date.now() }],
    });
    const lines = await captureLog(() => devicePool('list'));
    const line = lines.find((l) => l.includes('AAAA-1111'));
    assert(line !== undefined, 'should list AAAA-1111');
    assert(line!.includes('free'), `expected "free" after prune, got "${line}"`);
  } finally { teardown(); }
});

devicePoolSuite.test('acquire reclaims device from dead PID', async () => {
  setup(['AAAA-1111']);
  try {
    writePoolFile({
      devices: [{ deviceId: 'AAAA-1111', acquiredBy: DEAD_PID, acquiredAt: Date.now() }],
    });
    const lines = await captureLog(async () => {
      const code = await devicePool('acquire');
      assert(code === 0, `expected exit 0, got ${code}`);
    });
    assert(lines[0] === 'AAAA-1111', `expected reclaimed device, got "${lines[0]}"`);
  } finally { teardown(); }
});

if (require.main === module) runAll([devicePoolSuite]);
