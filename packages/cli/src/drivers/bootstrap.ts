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
import crypto from 'crypto';
import http from 'http';
import net from 'net';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { log } from '../verbose.js';
import { sleep } from '../utils.js';

// ── Platform detection ────────────────────────────────────────────────────────

export type Platform = 'ios' | 'android' | 'tvos' | 'web';

/** Cache: deviceId → platform */
const _platformCache = new Map<string, Platform>();

export async function detectPlatform(deviceId: string): Promise<Platform> {
  if (_platformCache.has(deviceId)) return _platformCache.get(deviceId)!;

  // Web browser: "web", "web:chromium", "web:firefox", "web:webkit"
  if (deviceId === 'web' || deviceId.startsWith('web:')) {
    _platformCache.set(deviceId, 'web');
    return 'web';
  }

  // Check if it looks like an iOS/tvOS simulator UUID (8-4-4-4-12 hex chars)
  const iosUuidRe = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
  if (iosUuidRe.test(deviceId)) {
    // Query simctl to determine whether this UUID belongs to a tvOS runtime
    try {
      const out = await spawnCapture('xcrun', ['simctl', 'list', 'devices', '--json']);
      const parsed = JSON.parse(out) as { devices: Record<string, Array<{ udid: string }>> };
      for (const [runtime, sims] of Object.entries(parsed.devices)) {
        if (sims.some((s) => s.udid === deviceId)) {
          const platform: Platform = runtime.includes('tvOS') ? 'tvos' : 'ios';
          _platformCache.set(deviceId, platform);
          return platform;
        }
      }
    } catch {
      /* fall through to ios default */
    }
    _platformCache.set(deviceId, 'ios');
    return 'ios';
  }

  // Otherwise assume Android (serial like emulator-5554 or real device)
  _platformCache.set(deviceId, 'android');
  return 'android';
}

// ── Port management ───────────────────────────────────────────────────────────

const IOS_BASE_PORT = 1075;
const TVOS_BASE_PORT = 2075;
const ANDROID_BASE_PORT = 3763;
const WEB_BASE_PORT = 4075;

const PORT_FILE = path.join(os.homedir(), '.conductor', 'ports.json');
const PORT_LOCK = PORT_FILE + '.lock';
const PORT_LOCK_TIMEOUT_MS = 5000;

interface PortState {
  assignments: Record<string, number>;
  nextIosPort: number;
  nextTvosPort: number;
  nextAndroidPort: number;
  nextWebPort: number;
}

function readPortState(): PortState {
  try {
    return JSON.parse(fs.readFileSync(PORT_FILE, 'utf-8')) as PortState;
  } catch {
    return {
      assignments: {},
      nextIosPort: IOS_BASE_PORT,
      nextTvosPort: TVOS_BASE_PORT,
      nextAndroidPort: ANDROID_BASE_PORT,
      nextWebPort: WEB_BASE_PORT,
    };
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
    // Ensure counters are initialised for port files created before new platform support
    if (state.nextTvosPort === undefined) state.nextTvosPort = TVOS_BASE_PORT;
    if (state.nextWebPort === undefined) state.nextWebPort = WEB_BASE_PORT;
    let port: number;
    if (platform === 'ios') {
      port = state.nextIosPort++;
    } else if (platform === 'tvos') {
      port = state.nextTvosPort++;
    } else if (platform === 'web') {
      port = state.nextWebPort++;
    } else {
      port = state.nextAndroidPort++;
    }
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

  // Inject PORT into the xctestrun EnvironmentVariables so the XCTest runner
  // picks it up. Env vars on the spawn call don't reach the test process —
  // xcodebuild only passes what's declared in the xctestrun plist.
  await spawnAndWait('plutil', [
    '-replace',
    'conductor-driver-iosUITests.EnvironmentVariables.PORT',
    '-string',
    String(port),
    xctestrun,
  ]);

  const proc = spawn(
    'xcodebuild',
    ['test-without-building', '-xctestrun', xctestrun, '-destination', `id=${deviceId}`],
    {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
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

// ── tvOS bootstrap ────────────────────────────────────────────────────────────

const TVOS_RUNNER_BUNDLE_ID = 'dev.houwert.conductor-driver-tvosUITests.xctrunner';
const TVOS_STARTUP_TIMEOUT_MS = 120000;
const TVOS_STARTUP_POLL_MS = 500;

// Persistent cache for extracted tvOS driver files (~/.conductor/tvos-driver/).
// __TESTROOT__ in the xctestrun resolves to this directory, so both the xctestrun
// and the Debug-appletvsimulator/ folder must live here.
const TVOS_DRIVER_CACHE = path.join(os.homedir(), '.conductor', 'tvos-driver');

/**
 * Ensure the tvOS driver files are extracted from the bundled zips into the cache
 * dir. Re-extracts only when the bundled xctestrun has changed (tracked by mtime).
 */
export async function setupTvOSDriverCache(): Promise<void> {
  const bundledXctestrun = path.join(
    BUNDLED_DRIVERS_DIR,
    'tvos',
    'conductor-driver-tvos-config.xctestrun'
  );
  const bundledDriverZip = path.join(BUNDLED_DRIVERS_DIR, 'tvos', 'conductor-driver-tvos.zip');
  const bundledRunnerZip = path.join(
    BUNDLED_DRIVERS_DIR,
    'tvos',
    'conductor-driver-tvosUITests-Runner.zip'
  );

  if (
    !fs.existsSync(bundledXctestrun) ||
    !fs.existsSync(bundledDriverZip) ||
    !fs.existsSync(bundledRunnerZip)
  ) {
    throw new Error(
      `Conductor tvOS driver files not found at ${path.join(BUNDLED_DRIVERS_DIR, 'tvos')}.\n` +
        `Run 'make package-cli' from the repo root to build and bundle the drivers.`
    );
  }

  const versionFile = path.join(TVOS_DRIVER_CACHE, '.version');
  const xctestrunMtime = String(fs.statSync(bundledXctestrun).mtimeMs);

  let cachedMtime = '';
  try {
    cachedMtime = fs.readFileSync(versionFile, 'utf-8').trim();
  } catch {
    /* first run */
  }

  const runnerApp = path.join(
    TVOS_DRIVER_CACHE,
    'Debug-appletvsimulator',
    'conductor-driver-tvosUITests-Runner.app'
  );
  if (cachedMtime === xctestrunMtime && fs.existsSync(runnerApp)) return;

  log('Extracting tvOS driver files to cache...');
  fs.rmSync(TVOS_DRIVER_CACHE, { recursive: true, force: true });
  fs.mkdirSync(TVOS_DRIVER_CACHE, { recursive: true });

  // Copy xctestrun directly
  fs.copyFileSync(
    bundledXctestrun,
    path.join(TVOS_DRIVER_CACHE, 'conductor-driver-tvos-config.xctestrun')
  );

  // Unzip the two .app bundles
  const appsDir = path.join(TVOS_DRIVER_CACHE, 'Debug-appletvsimulator');
  await spawnAndWait('unzip', ['-q', '-o', bundledDriverZip, '-d', appsDir]);
  await spawnAndWait('unzip', ['-q', '-o', bundledRunnerZip, '-d', appsDir]);

  fs.writeFileSync(versionFile, xctestrunMtime);
  log('tvOS driver cache ready');
}

/**
 * Start the tvOS XCTest driver via `xcodebuild test-without-building`.
 * Mirrors startIOSDriver but targets the tvOS xctestrun.
 *
 * On first launch the runner app appears in the foreground, so we press the
 * home button to dismiss it. On subsequent restarts (e.g. health-check recovery)
 * we skip the dismiss to avoid disrupting the user's navigation state.
 */
export async function startTvOSDriver(
  deviceId: string,
  port = TVOS_BASE_PORT,
  dismissAfterLaunch = false
): Promise<void> {
  if (await isPortOpen(port)) {
    log(`tvOS driver already running on port ${port}`);
    return;
  }

  log(`Starting tvOS XCTest driver for device ${deviceId} on port ${port}`);
  await setupTvOSDriverCache();

  const xctestrun = path.join(TVOS_DRIVER_CACHE, 'conductor-driver-tvos-config.xctestrun');

  // Inject PORT into the xctestrun EnvironmentVariables so the XCTest runner
  // picks it up. Env vars on the spawn call don't reach the test process —
  // xcodebuild only passes what's declared in the xctestrun plist.
  await spawnAndWait('plutil', [
    '-replace',
    'conductor-driver-tvosUITests.EnvironmentVariables.PORT',
    '-string',
    String(port),
    xctestrun,
  ]);

  const proc = spawn(
    'xcodebuild',
    ['test-without-building', '-xctestrun', xctestrun, '-destination', `id=${deviceId}`],
    {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    }
  );
  proc.unref();

  const deadline = Date.now() + TVOS_STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(TVOS_STARTUP_POLL_MS);
    if (await isPortOpen(port)) {
      log(`tvOS driver ready on port ${port}`);
      if (dismissAfterLaunch) {
        try {
          await pressButtonViaDriver(port, 'home');
          log('Dismissed tvOS driver app');
        } catch {
          log('Could not dismiss tvOS driver app (non-fatal)');
        }
      }
      return;
    }
  }

  throw new Error(
    `tvOS XCTest driver did not start within ${TVOS_STARTUP_TIMEOUT_MS / 1000}s on port ${port}.`
  );
}

/**
 * Stop the tvOS XCTest driver by terminating the runner app.
 */
export async function stopTvOSDriver(deviceId: string): Promise<void> {
  await spawnAndWait('xcrun', ['simctl', 'terminate', deviceId, TVOS_RUNNER_BUNDLE_ID]);
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

// ── Web bootstrap ────────────────────────────────────────────────────────────

/**
 * Extract the browser name from a web device ID.
 * "web" → "chromium", "web:firefox" → "firefox", "web:webkit" → "webkit"
 *
 * Also handles instance-qualified IDs:
 * "web:chromium:abc1" → "chromium", "web:firefox:abc1" → "firefox"
 */
export function webBrowserName(deviceId: string): 'chromium' | 'firefox' | 'webkit' {
  if (deviceId.startsWith('web:')) {
    const browser = deviceId.slice(4).split(':')[0];
    if (browser === 'firefox' || browser === 'webkit') return browser;
  }
  return 'chromium';
}

/**
 * Generate a unique web session ID for parallel browser instances.
 * Format: "web:<browser>:<8-hex-char-id>"
 */
export function generateWebSessionId(
  browserName: 'chromium' | 'firefox' | 'webkit' = 'chromium'
): string {
  const id = crypto.randomBytes(4).toString('hex');
  return `web:${browserName}:${id}`;
}

/**
 * True when the device ID refers to a web browser but does NOT include
 * an instance qualifier — i.e. "web" or "web:<browser>" but not "web:<browser>:<id>".
 */
export function isUnqualifiedWebId(deviceId: string): boolean {
  if (deviceId === 'web') return true;
  if (!deviceId.startsWith('web:')) return false;
  return deviceId.split(':').length === 2;
}

/**
 * Check whether a Playwright browser is installed for the current playwright-core version.
 * Returns true if the executable exists, false otherwise.
 */
export function isPlaywrightBrowserInstalled(
  browserName: 'chromium' | 'firefox' | 'webkit'
): boolean {
  try {
    // Dynamic import to avoid pulling playwright-core into every code path
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pw = require('playwright-core') as typeof import('playwright-core');
    const execPath = pw[browserName].executablePath();
    return fs.existsSync(execPath);
  } catch {
    return false;
  }
}

/**
 * Install a Playwright browser if not already present.
 * Shells out to `npx playwright-core install <browser>` which downloads the
 * version-matched browser binary to the default cache (~/.cache/ms-playwright).
 */
export async function ensurePlaywrightBrowser(
  browserName: 'chromium' | 'firefox' | 'webkit',
  logger: (msg: string) => void = log
): Promise<void> {
  if (isPlaywrightBrowserInstalled(browserName)) {
    logger(`Playwright ${browserName} is already installed`);
    return;
  }

  logger(`Installing Playwright ${browserName} browser...`);

  // Use the playwright-core CLI to install the browser.
  // Resolve the playwright-core binary from node_modules.
  const pwCoreBin = path.join(
    path.dirname(require.resolve('playwright-core/package.json')),
    'cli.js'
  );

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(process.execPath, [pwCoreBin, 'install', browserName], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.stdout?.on('data', (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line) logger(line);
    });
    proc.on('close', (code) => {
      if (code === 0) {
        logger(`Playwright ${browserName} installed successfully`);
        resolve();
      } else {
        reject(
          new Error(
            `Failed to install Playwright ${browserName} (exit ${code}).\n${stderr.trim()}\n` +
              `You can install manually: npx playwright-core install ${browserName}`
          )
        );
      }
    });
    proc.on('error', (err) => {
      reject(
        new Error(
          `Failed to run Playwright installer: ${err.message}\n` +
            `You can install manually: npx playwright-core install ${browserName}`
        )
      );
    });
  });
}

/**
 * Stop the web driver by sending a shutdown request to its HTTP server.
 */
export async function stopWebDriver(port: number): Promise<void> {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: '/shutdown', method: 'POST' },
      () => resolve()
    );
    req.on('error', () => resolve());
    req.end();
  });
}

/**
 * Uninstall the Conductor driver app(s) from the device.
 */
export async function uninstallDriver(deviceId: string, platform: Platform): Promise<void> {
  log(`uninstallDriver: removing ${platform} driver from ${deviceId}`);
  if (platform === 'web') {
    // Web has no persistent driver to uninstall — the browser is managed by the daemon.
    // Stopping the web server is handled by the daemon cleanup.
    return;
  } else if (platform === 'ios') {
    await spawnAndWait('xcrun', [
      'simctl',
      'uninstall',
      deviceId,
      'dev.houwert.conductor-driver-iosUITests.xctrunner',
    ]).catch(() => {});
  } else if (platform === 'tvos') {
    await spawnAndWait('xcrun', ['simctl', 'uninstall', deviceId, TVOS_RUNNER_BUNDLE_ID]).catch(
      () => {}
    );
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

/** Send a pressButton command directly to the driver HTTP server. */
function pressButtonViaDriver(port: number, button: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ button });
    const options = {
      hostname: '127.0.0.1',
      port,
      path: '/pressButton',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const req = http.request(options, (res) => {
      res.resume();
      res.on('end', () =>
        res.statusCode && res.statusCode < 300
          ? resolve()
          : reject(new Error(`HTTP ${res.statusCode}`))
      );
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

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
