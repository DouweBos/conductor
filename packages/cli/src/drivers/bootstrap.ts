/**
 * Driver lifecycle manager.
 *
 * Manages the underlying device driver processes:
 *   iOS:     xcodebuild test-without-building → XCTest HTTP server on port 1075
 *   Android: adb forward + adb shell am instrument → gRPC server on port 3763
 *
 * Driver binaries are bundled inside the npm package under drivers/android/ and
 * drivers/ios/ — no separate Conductor/JVM installation required.
 */
import { spawn } from 'child_process';
import net from 'net';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { log } from '../verbose.js';
import { sleep } from '../utils.js';

// ── Platform detection ────────────────────────────────────────────────────────

export type Platform = 'ios' | 'android';

/** Cache: deviceId → platform */
const _platformCache = new Map<string, Platform>();

export async function detectPlatform(deviceId: string): Promise<Platform> {
  if (_platformCache.has(deviceId)) return _platformCache.get(deviceId)!;

  // Check if it looks like an iOS simulator UUID (8-4-4-4-12 hex chars)
  const iosUuidRe = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
  if (iosUuidRe.test(deviceId)) {
    _platformCache.set(deviceId, 'ios');
    return 'ios';
  }

  // Otherwise assume Android (serial like emulator-5554 or real device)
  _platformCache.set(deviceId, 'android');
  return 'android';
}

// ── Port management ───────────────────────────────────────────────────────────

const IOS_BASE_PORT = 1075;
const ANDROID_BASE_PORT = 3763;

const PORT_FILE = path.join(os.homedir(), '.conductor', 'ports.json');
const PORT_LOCK = PORT_FILE + '.lock';
const PORT_LOCK_TIMEOUT_MS = 5000;

interface PortState {
  assignments: Record<string, number>;
  nextIosPort: number;
  nextAndroidPort: number;
}

function readPortState(): PortState {
  try {
    return JSON.parse(fs.readFileSync(PORT_FILE, 'utf-8')) as PortState;
  } catch {
    return { assignments: {}, nextIosPort: IOS_BASE_PORT, nextAndroidPort: ANDROID_BASE_PORT };
  }
}

function writePortState(state: PortState): void {
  fs.mkdirSync(path.dirname(PORT_FILE), { recursive: true });
  fs.writeFileSync(PORT_FILE, JSON.stringify(state, null, 2));
}

async function withPortLock<T>(fn: () => T): Promise<T> {
  fs.mkdirSync(path.dirname(PORT_LOCK), { recursive: true });
  const deadline = Date.now() + PORT_LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const fd = fs.openSync(PORT_LOCK, 'wx');
      fs.closeSync(fd);
      try {
        return fn();
      } finally {
        try {
          fs.unlinkSync(PORT_LOCK);
        } catch {
          /* ok */
        }
      }
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error('Could not acquire port registry lock');
}

/**
 * Assign and persist a driver port for a device.
 * Safe to call concurrently from multiple processes — uses a file lock.
 * iOS devices get unique ports starting from 1075; Android from 3763.
 */
export async function getDriverPort(platform: Platform, deviceId: string): Promise<number> {
  return withPortLock(() => {
    const state = readPortState();
    if (state.assignments[deviceId] !== undefined) {
      return state.assignments[deviceId];
    }
    const port = platform === 'ios' ? state.nextIosPort++ : state.nextAndroidPort++;
    state.assignments[deviceId] = port;
    writePortState(state);
    return port;
  });
}

// ── Bundled driver paths ───────────────────────────────────────────────────────

/**
 * Root of the bundled drivers directory (packages/cli/drivers/).
 *
 * Walk up from __dirname to find the package root (the directory containing
 * package.json). This handles both the normal build (dist/drivers/bootstrap.js)
 * and the test build (dist-tests/src/drivers/bootstrap.js) where __dirname has
 * an extra src/ level, making a fixed relative path incorrect.
 */
function findBundledDriversDir(): string {
  let dir = __dirname;
  while (true) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      return path.join(dir, 'drivers');
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback to original relative path
  return path.join(__dirname, '..', '..', 'drivers');
}
const BUNDLED_DRIVERS_DIR = findBundledDriversDir();

/**
 * Install the Conductor Android driver APKs on the device.
 * Reads pre-built APKs directly from the bundled drivers directory.
 */
export async function installDriver(deviceId: string): Promise<void> {
  log(`installDriver: installing Android driver on ${deviceId}`);

  const appApk = path.join(BUNDLED_DRIVERS_DIR, 'android', 'conductor-app.apk');
  const serverApk = path.join(BUNDLED_DRIVERS_DIR, 'android', 'conductor-server.apk');

  if (!fs.existsSync(appApk) || !fs.existsSync(serverApk)) {
    throw new Error(
      `Conductor driver APKs not found at ${path.join(BUNDLED_DRIVERS_DIR, 'android')}.\n` +
        `Run 'make package-cli' from the repo root to build and bundle the drivers.`
    );
  }

  await spawnAndWait('adb', ['-s', deviceId, 'install', '-r', '-t', '-g', appApk]);
  await spawnAndWait('adb', ['-s', deviceId, 'install', '-r', '-t', '-g', serverApk]);
  log(`installDriver: done`);
}

// ── iOS bootstrap ─────────────────────────────────────────────────────────────

const IOS_RUNNER_BUNDLE_ID = 'dev.houwert.conductor-driver-iosUITests.xctrunner';
const IOS_STARTUP_TIMEOUT_MS = 120000;
const IOS_STARTUP_POLL_MS = 500;

// Persistent cache for extracted iOS driver files (~/.conductor/ios-driver/).
// __TESTROOT__ in the xctestrun resolves to this directory, so both the xctestrun
// and the Debug-iphonesimulator/ folder must live here.
const IOS_DRIVER_CACHE = path.join(os.homedir(), '.conductor', 'ios-driver');

/**
 * Ensure the iOS driver files are extracted from the bundled zips into the cache
 * dir. Re-extracts only when the bundled xctestrun has changed (tracked by mtime).
 */
async function setupIOSDriverCache(): Promise<void> {
  const bundledXctestrun = path.join(
    BUNDLED_DRIVERS_DIR,
    'ios',
    'conductor-driver-ios-config.xctestrun'
  );
  const bundledDriverZip = path.join(BUNDLED_DRIVERS_DIR, 'ios', 'conductor-driver-ios.zip');
  const bundledRunnerZip = path.join(
    BUNDLED_DRIVERS_DIR,
    'ios',
    'conductor-driver-iosUITests-Runner.zip'
  );

  if (
    !fs.existsSync(bundledXctestrun) ||
    !fs.existsSync(bundledDriverZip) ||
    !fs.existsSync(bundledRunnerZip)
  ) {
    throw new Error(
      `Conductor iOS driver files not found at ${path.join(BUNDLED_DRIVERS_DIR, 'ios')}.\n` +
        `Run 'make package-cli' from the repo root to build and bundle the drivers.`
    );
  }

  const versionFile = path.join(IOS_DRIVER_CACHE, '.version');
  const xctestrunMtime = String(fs.statSync(bundledXctestrun).mtimeMs);

  let cachedMtime = '';
  try {
    cachedMtime = fs.readFileSync(versionFile, 'utf-8').trim();
  } catch {
    /* first run */
  }

  const runnerApp = path.join(
    IOS_DRIVER_CACHE,
    'Debug-iphonesimulator',
    'conductor-driver-iosUITests-Runner.app'
  );
  if (cachedMtime === xctestrunMtime && fs.existsSync(runnerApp)) return;

  log('Extracting iOS driver files to cache...');
  fs.rmSync(IOS_DRIVER_CACHE, { recursive: true, force: true });
  fs.mkdirSync(IOS_DRIVER_CACHE, { recursive: true });

  // Copy xctestrun directly
  fs.copyFileSync(
    bundledXctestrun,
    path.join(IOS_DRIVER_CACHE, 'conductor-driver-ios-config.xctestrun')
  );

  // Unzip the two .app bundles
  const appsDir = path.join(IOS_DRIVER_CACHE, 'Debug-iphonesimulator');
  await spawnAndWait('unzip', ['-q', '-o', bundledDriverZip, '-d', appsDir]);
  await spawnAndWait('unzip', ['-q', '-o', bundledRunnerZip, '-d', appsDir]);

  fs.writeFileSync(versionFile, xctestrunMtime);
  log('iOS driver cache ready');
}

/** Returns true if the iOS simulator with the given UDID is in the Booted state. */
export async function isSimulatorBooted(deviceId: string): Promise<boolean> {
  try {
    const out = await spawnCapture('xcrun', ['simctl', 'list', 'devices', 'booted', '--json']);
    const parsed = JSON.parse(out) as { devices: Record<string, Array<{ udid: string }>> };
    return Object.values(parsed.devices).some((sims) => sims.some((s) => s.udid === deviceId));
  } catch {
    return false;
  }
}

/** Check if something is listening on the given TCP port. */
export function isPortOpen(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port });
    sock.setTimeout(500);
    sock.on('connect', () => {
      sock.destroy();
      resolve(true);
    });
    sock.on('error', () => resolve(false));
    sock.on('timeout', () => {
      sock.destroy();
      resolve(false);
    });
  });
}

/**
 * Start the iOS XCTest driver via `xcodebuild test-without-building`.
 *
 * Unlike `xcrun simctl launch`, xcodebuild runs the XCTest runner as a
 * background test process — no app appears in the simulator foreground.
 * It also installs both driver apps silently via DependentProductPaths.
 *
 * The port is injected into the xctestrun EnvironmentVariables with plutil.
 */
export async function startIOSDriver(deviceId: string, port = IOS_BASE_PORT): Promise<void> {
  if (await isPortOpen(port)) {
    log(`iOS driver already running on port ${port}`);
    return;
  }

  log(`Starting iOS XCTest driver for device ${deviceId} on port ${port}`);
  await setupIOSDriverCache();

  const xctestrun = path.join(IOS_DRIVER_CACHE, 'conductor-driver-ios-config.xctestrun');

  const proc = spawn(
    'xcodebuild',
    ['test-without-building', '-xctestrun', xctestrun, '-destination', `id=${deviceId}`],
    {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
      env: { ...process.env, TEST_RUNNER_PORT: String(port) },
    }
  );
  proc.unref();

  const deadline = Date.now() + IOS_STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(IOS_STARTUP_POLL_MS);
    if (await isPortOpen(port)) {
      log(`iOS driver ready on port ${port}`);
      return;
    }
  }

  throw new Error(
    `iOS XCTest driver did not start within ${IOS_STARTUP_TIMEOUT_MS / 1000}s on port ${port}.`
  );
}

/**
 * Stop the iOS XCTest driver by terminating the runner app.
 */
export async function stopIOSDriver(deviceId: string): Promise<void> {
  await spawnAndWait('xcrun', ['simctl', 'terminate', deviceId, IOS_RUNNER_BUNDLE_ID]);
}

// ── Android bootstrap ─────────────────────────────────────────────────────────

const ANDROID_STARTUP_TIMEOUT_MS = 30000;
const ANDROID_STARTUP_POLL_MS = 500;
const CONDUCTOR_INSTRUMENTATION_CLASS = 'dev.houwert.conductor.ConductorDriverService#grpcServer';
const CONDUCTOR_TEST_RUNNER = 'dev.houwert.conductor.test/androidx.test.runner.AndroidJUnitRunner';

/**
 * Start the Android gRPC driver for the given device.
 * Runs: adb -s <id> forward tcp:3763 tcp:3763 + adb shell am instrument
 */
export async function startAndroidDriver(
  deviceId: string,
  port = ANDROID_BASE_PORT
): Promise<void> {
  if (await isPortOpen(port)) {
    log(`Android driver already running on port ${port}`);
    return;
  }

  log(`Starting Android driver for device ${deviceId} on port ${port}`);

  // Step 1: ADB port forward
  await spawnAndWait('adb', ['-s', deviceId, 'forward', `tcp:${port}`, `tcp:${port}`]);

  // Step 2: Get device API level to decide instrumentation flags
  const apiResult = await spawnCapture('adb', [
    '-s',
    deviceId,
    'shell',
    'getprop ro.build.version.sdk',
  ]);
  const apiLevel = parseInt(apiResult.trim(), 10);
  const mFlag = apiLevel >= 26 ? ['-m'] : [];

  // Step 3: Start instrumentation in background (it blocks the shell, so detach)
  const instrArgs = [
    '-s',
    deviceId,
    'shell',
    'am',
    'instrument',
    '-w',
    ...mFlag,
    '-e',
    'debug',
    'false',
    '-e',
    'class',
    CONDUCTOR_INSTRUMENTATION_CLASS,
    '-e',
    'port',
    String(port),
    CONDUCTOR_TEST_RUNNER,
  ];

  const proc = spawn('adb', instrArgs, {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  proc.unref();

  // Wait for gRPC port to open
  const deadline = Date.now() + ANDROID_STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(ANDROID_STARTUP_POLL_MS);
    if (await isPortOpen(port)) {
      log(`Android driver ready on port ${port}`);
      return;
    }
  }

  throw new Error(
    `Android driver did not start within ${ANDROID_STARTUP_TIMEOUT_MS / 1000}s on port ${port}.\n` +
      `Make sure the Conductor driver APK is installed on device ${deviceId}.\n` +
      `Try running: conductor install --device ${deviceId}`
  );
}

export async function stopAndroidDriver(deviceId: string, port = ANDROID_BASE_PORT): Promise<void> {
  await spawnAndWait('adb', [
    '-s',
    deviceId,
    'shell',
    'am',
    'force-stop',
    'dev.houwert.conductor',
  ]).catch(() => {});
  await spawnAndWait('adb', ['-s', deviceId, 'forward', '--remove', `tcp:${port}`]).catch(() => {});
}

/**
 * Uninstall the Conductor driver app(s) from the device.
 */
export async function uninstallDriver(deviceId: string, platform: Platform): Promise<void> {
  log(`uninstallDriver: removing ${platform} driver from ${deviceId}`);
  if (platform === 'ios') {
    await spawnAndWait('xcrun', [
      'simctl',
      'uninstall',
      deviceId,
      'dev.houwert.conductor-driver-iosUITests.xctrunner',
    ]).catch(() => {});
  } else {
    await spawnAndWait('adb', ['-s', deviceId, 'uninstall', 'dev.houwert.conductor']).catch(
      () => {}
    );
    await spawnAndWait('adb', ['-s', deviceId, 'uninstall', 'dev.houwert.conductor.test']).catch(
      () => {}
    );
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function spawnAndWait(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: 'ignore' });
    proc.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}`))
    );
    proc.on('error', reject);
  });
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
