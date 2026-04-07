import { spawn } from 'child_process';
import { getSession } from './session.js';
import { parseFlowString, executeFlow } from './drivers/flow-runner.js';
import { log } from './verbose.js';
import { IOSDriver } from './drivers/ios.js';
import { AndroidDriver } from './drivers/android.js';
import { detectPlatform, getDriverPort, isPortOpen } from './drivers/bootstrap.js';
import { startDaemon } from './daemon/client.js';

/**
 * Detect the first booted device/emulator without requiring a session.
 * Checks Android (adb) and iOS simulators (xcrun simctl).
 * Result is cached for the process lifetime to avoid repeated subprocess calls.
 */
let _cachedDeviceId: string | null | undefined; // undefined = not yet queried, null = none found

export async function detectFirstDevice(): Promise<string | undefined> {
  if (_cachedDeviceId !== undefined) return _cachedDeviceId ?? undefined;

  // Android: adb devices
  const adb = await spawnCommand('adb', ['devices', '-l']).catch(() => null);
  if (adb) {
    for (const line of adb.stdout.split('\n').slice(1)) {
      const id = line.trim().split(/\s+/)[0];
      if (id && !line.includes('offline')) {
        log(`detectFirstDevice: found Android device "${id}"`);
        _cachedDeviceId = id;
        return id;
      }
    }
  }

  // iOS: xcrun simctl list booted
  const xcrun = await spawnCommand('xcrun', [
    'simctl',
    'list',
    'devices',
    'booted',
    '--json',
  ]).catch(() => null);
  if (xcrun?.success) {
    try {
      const parsed = JSON.parse(xcrun.stdout) as {
        devices: Record<string, Array<{ udid: string; state: string }>>;
      };
      for (const sims of Object.values(parsed.devices)) {
        for (const sim of sims) {
          if (sim.state === 'Booted') {
            log(`detectFirstDevice: found iOS simulator "${sim.udid}"`);
            _cachedDeviceId = sim.udid;
            return sim.udid;
          }
        }
      }
    } catch {
      /* ignore */
    }
  }

  _cachedDeviceId = null;
  return undefined;
}

export interface RunResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

// ── Driver management ─────────────────────────────────────────────────────────

type AnyDriver = IOSDriver | AndroidDriver;

/** Per-session driver cache (process lifetime). */
const _driverCache = new Map<string, AnyDriver>();

/**
 * Resolve a session name to a device ID.
 * If sessionName is not 'default', treat it as a device ID directly.
 */
async function resolveDeviceId(sessionName: string): Promise<string | undefined> {
  if (sessionName !== 'default') return sessionName;
  const session = await getSession(sessionName);
  return session.deviceId ?? (await detectFirstDevice());
}

/**
 * Get or create a driver for the given session.
 * Auto-starts the driver process if it's not already running.
 */
export async function getDriver(sessionName = 'default'): Promise<AnyDriver> {
  if (_driverCache.has(sessionName)) {
    const cached = _driverCache.get(sessionName)!;
    // Quick alive check — if still alive, reuse
    const alive = await cached.isAlive().catch(() => false);
    if (alive) return cached;
    _driverCache.delete(sessionName);
  }

  const deviceId = await resolveDeviceId(sessionName);
  if (!deviceId) {
    throw new Error('No device found. Connect a device or start a simulator, then run again.');
  }

  const platform = await detectPlatform(deviceId);
  const port = await getDriverPort(platform, deviceId);
  log(`getDriver: platform=${platform} deviceId=${deviceId} port=${port}`);

  let driver: AnyDriver;

  if (platform === 'ios') {
    if (!(await isPortOpen(port))) {
      log(`Driver not running — starting daemon for ${deviceId}...`);
      await startDaemon(deviceId);
      await waitForPort(port);
    }
    const iosDriver = new IOSDriver(port, '127.0.0.1', deviceId, 'ios');
    if (!(await iosDriver.isAlive())) {
      throw new Error(
        `iOS XCTest driver on port ${port} is not responding.\n` +
          `Run: conductor daemon-start --device ${deviceId}`
      );
    }
    driver = iosDriver;
  } else if (platform === 'tvos') {
    if (!(await isPortOpen(port))) {
      log(`tvOS driver not running — starting daemon for ${deviceId}...`);
      await startDaemon(deviceId);
      await waitForPort(port);
    }
    const tvosDriver = new IOSDriver(port, '127.0.0.1', deviceId, 'tvos');
    if (!(await tvosDriver.isAlive())) {
      throw new Error(
        `tvOS XCTest driver on port ${port} is not responding.\n` +
          `Run: conductor daemon-start --device ${deviceId}`
      );
    }
    driver = tvosDriver;
  } else {
    // Ensure the daemon is running — it handles APK install and driver startup.
    await startDaemon(deviceId);

    // Poll isAlive() directly instead of isPortOpen(): with ADB port forwarding the
    // local port appears open as soon as `adb forward` runs, before the gRPC server
    // on the device is ready, making isPortOpen() unreliable as a readiness signal.
    const ANDROID_READY_TIMEOUT_MS = 180_000;
    const deadline = Date.now() + ANDROID_READY_TIMEOUT_MS;
    let alive = false;
    while (Date.now() < deadline) {
      const probe = new AndroidDriver(deviceId, port);
      await probe.connect();
      alive = await probe.isAlive().catch(() => false);
      probe.close();
      if (alive) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!alive) {
      throw new Error(
        `Android gRPC driver on port ${port} is not responding.\n` +
          `Make sure the Conductor driver APK is installed: conductor install --device ${deviceId}`
      );
    }
    const androidDriver = new AndroidDriver(deviceId, port);
    await androidDriver.connect();
    driver = androidDriver;
  }

  _driverCache.set(sessionName, driver);
  return driver;
}

/**
 * Execute a function with the driver for the given session.
 * Returns a RunResult for consistent error handling across commands.
 */
export async function runDirect(
  fn: (driver: AnyDriver) => Promise<string | void>,
  sessionName = 'default'
): Promise<RunResult> {
  try {
    const driver = await getDriver(sessionName);
    const output = await fn(driver);
    return {
      success: true,
      stdout: output ?? '',
      stderr: '',
      exitCode: 0,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      stdout: '',
      stderr: msg,
      exitCode: 1,
    };
  }
}

// ── Spawn helpers ─────────────────────────────────────────────────────────────

export async function spawnCommand(cmd: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      const exitCode = code ?? 1;
      resolve({ success: exitCode === 0, stdout, stderr, exitCode });
    });

    proc.on('error', (err) => {
      resolve({ success: false, stdout: '', stderr: err.message, exitCode: 1 });
    });
  });
}

/** Poll until a TCP port is open, or throw after timeout. */
async function waitForPort(port: number, timeoutMs = 180_000, pollMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortOpen(port)) return;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`Driver port ${port} did not open within ${timeoutMs / 1000}s`);
}

export async function runInlineFlow(
  commands: string,
  sessionName = 'default',
  benchmark = false
): Promise<RunResult> {
  const session = await getSession(sessionName);
  const appId = session.appId ?? 'com.placeholder';
  const yamlContent = `appId: ${appId}\n---\n${commands}`;
  log(`runInlineFlow: executing inline flow:\n${yamlContent}`);

  try {
    const driver = await getDriver(sessionName);
    const flow = parseFlowString(yamlContent);
    await executeFlow(flow, driver, { benchmark });
    return { success: true, stdout: '', stderr: '', exitCode: 0 };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, stdout: '', stderr: msg, exitCode: 1 };
  }
}
