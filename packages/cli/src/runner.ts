import { spawn } from 'child_process';
import { resolveAndroidTool, androidSpawnEnv } from './android/sdk.js';
import { getSession } from './session.js';
import { parseFlowString, executeFlow } from './drivers/flow-runner.js';
import { log } from './verbose.js';
import { IOSDriver } from './drivers/ios.js';
import { AndroidDriver } from './drivers/android.js';
import { WebDriver } from './drivers/web.js';
import { VegaDriver } from './drivers/vega.js';
import { VegaCli } from './drivers/vega/cli.js';
import { RokuDriver } from './drivers/roku.js';
import { discoverRokuDevices } from './drivers/roku/discovery.js';
import {
  detectPlatform,
  getDriverPort,
  isPortOpen,
  webBrowserName,
  generateWebSessionId,
  isUnqualifiedWebId,
} from './drivers/bootstrap.js';
import {
  startDaemon,
  findRunningWebSession,
  listDaemonSessions,
  daemonStatus,
  fetchDaemonStatus,
} from './daemon/client.js';

/**
 * Detect the first booted device/emulator without requiring a session.
 * Checks Android (adb) and iOS simulators (xcrun simctl).
 * Result is cached for the process lifetime to avoid repeated subprocess calls.
 */
let _cachedDeviceId: string | null | undefined; // undefined = not yet queried, null = none found

export async function detectFirstDevice(): Promise<string | undefined> {
  if (_cachedDeviceId !== undefined) return _cachedDeviceId ?? undefined;

  // Android: adb devices
  const adb = await spawnCommand(resolveAndroidTool('adb'), ['devices', '-l'], {
    env: androidSpawnEnv(),
  }).catch(() => null);
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

  // Web: check for running daemon web sessions
  for (const session of listDaemonSessions()) {
    if (!(session === 'web' || session.startsWith('web:'))) continue;
    const status = await daemonStatus(session);
    if (status.running) {
      log(`detectFirstDevice: found running web session "${session}"`);
      _cachedDeviceId = session;
      return session;
    }
  }

  // Vega (Amazon Fire TV): query the vega CLI for a booted device. Best-effort —
  // the CLI is absent unless the Vega SDK is installed.
  try {
    const devices = await new VegaCli().listDevices();
    const device = devices[0];
    if (device) {
      log(`detectFirstDevice: found Vega device "${device.serial}"`);
      _cachedDeviceId = `vega:${device.serial}`;
      return _cachedDeviceId;
    }
  } catch {
    /* vega CLI not installed */
  }

  // Roku: pinned via CONDUCTOR_ROKU_HOST (or an opt-in SSDP scan). Best-effort —
  // neither is configured unless the user set up a Roku device.
  const roku = (await discoverRokuDevices().catch(() => []))[0];
  if (roku) {
    log(`detectFirstDevice: found Roku device "${roku.host}"`);
    _cachedDeviceId = `roku:${roku.host}`;
    return _cachedDeviceId;
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

type AnyDriver = IOSDriver | AndroidDriver | WebDriver | VegaDriver | RokuDriver;

/** Strip the `vega:` prefix to recover the bare Vega selector. */
function vegaSerial(deviceId: string): string {
  return deviceId.startsWith('vega:') ? deviceId.slice('vega:'.length) : deviceId;
}

/** Strip the `roku:` prefix to recover the bare device host. */
export function rokuHost(deviceId: string): string {
  return deviceId.startsWith('roku:') ? deviceId.slice('roku:'.length) : deviceId;
}

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
  // Web daemons resolve their own port after generating a unique session ID,
  // so we defer getDriverPort for them to avoid allocating an unused port.
  const port = platform !== 'web' ? await getDriverPort(platform, deviceId) : 0;
  log(`getDriver: platform=${platform} deviceId=${deviceId} port=${port || '(deferred)'}`);

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
  } else if (platform === 'web') {
    const browser = webBrowserName(deviceId);
    let webSession = deviceId;

    if (isUnqualifiedWebId(deviceId)) {
      const existing = await findRunningWebSession(browser);
      if (existing) {
        webSession = existing;
        log(`Reusing running web session ${webSession}`);
      } else {
        webSession = generateWebSessionId(browser);
        log(`Generated new web session ${webSession}`);
      }
    }

    const webPort = await getDriverPort('web', webSession);

    if (!(await isPortOpen(webPort))) {
      log(`Web driver not running — starting daemon for ${webSession}...`);
      await startDaemon(webSession);
      await waitForPort(webPort);
    }
    const webDriver = new WebDriver(webPort, '127.0.0.1', webSession);
    if (!(await webDriver.isAlive())) {
      throw new Error(
        `Web browser driver on port ${webPort} is not responding.\n` +
          `Run: conductor daemon-start --device ${webSession}`
      );
    }
    driver = webDriver;
  } else if (platform === 'vega') {
    // Vega has no driver process/port — control is host-side via the vega CLI.
    // Start the daemon best-effort for log collection, but never block control on it.
    startDaemon(deviceId).catch(() => {});
    const vegaDriver = new VegaDriver(vegaSerial(deviceId));
    if (!(await vegaDriver.isAlive())) {
      throw new Error(
        `No running Vega device matches "${vegaSerial(deviceId)}".\n` +
          `Boot a VVD and check \`vega device list\`, or install the Vega SDK (\`vega\`/\`kepler\`).`
      );
    }
    driver = vegaDriver;
  } else if (platform === 'roku') {
    // Roku has no driver process and no daemon: control is ECP over the network,
    // and the device exposes no log stream to collect.
    const host = rokuHost(deviceId);
    if (!host || host === 'roku') {
      throw new Error(
        'No Roku device specified. Set CONDUCTOR_ROKU_HOST=<device-ip>, or pass ' +
          '--device roku:<device-ip>.'
      );
    }
    const rokuDriver = new RokuDriver(host);
    if (!(await rokuDriver.isAlive())) {
      throw new Error(
        `Cannot reach the Roku device at ${host} on ECP port 8060.\n` +
          `Check that it is on this network and in developer mode, and that ` +
          `Settings > System > Advanced system settings > Control by mobile apps > ` +
          `Network access is set to "Permissive".`
      );
    }
    driver = rokuDriver;
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
 * Eagerly start the device daemon (and its XCTest driver) for `deviceId` so
 * the runner is already warm by the time the first interaction command runs.
 *
 * `start-device` is the natural prewarm point: bringing the driver up there
 * moves the one-off startup cost off the first `tap-on` / `assert-visible`.
 * Best-effort — failures are swallowed since a real command will surface any
 * genuine startup error with a proper message.
 */
export async function prewarmDriver(deviceId: string): Promise<void> {
  try {
    await startDaemon(deviceId);
  } catch {
    /* best-effort: a later command will report a real failure */
  }
}

export interface InputServerInfo {
  device: string;
  platform: string;
  inputPort: number;
  url: string;
}

/**
 * Resolve the streaming-input socket for a session's device, starting the
 * daemon (and its driver + input server) if needed. Returns the loopback
 * WebSocket URL the host IDE connects to. Throws if the platform has no
 * streaming input (web/vega) or the port never comes up.
 */
export async function inputServerInfo(sessionName = 'default'): Promise<InputServerInfo> {
  const deviceId = await resolveDeviceId(sessionName);
  if (!deviceId) {
    throw new Error('No device found. Connect a device or start a simulator, then run again.');
  }
  const platform = await detectPlatform(deviceId);
  if (platform !== 'ios' && platform !== 'tvos' && platform !== 'android') {
    throw new Error(`Streaming input is not available for ${platform} devices.`);
  }

  await startDaemon(deviceId);

  // The input server starts just after the driver — poll status until its port appears.
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const status = await fetchDaemonStatus(deviceId);
    if (status && typeof status.inputPort === 'number') {
      return {
        device: deviceId,
        platform,
        inputPort: status.inputPort,
        url: `ws://127.0.0.1:${status.inputPort}/input`,
      };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Input server for ${deviceId} did not come up within timeout.`);
}

export interface StreamServerInfo {
  device: string;
  platform: string;
  streamPort: number;
  url: string;
  codec: string;
}

/**
 * Resolve the streaming-video socket for a session's device, starting the
 * daemon (and its driver + video server) if needed. Returns the loopback
 * WebSocket URL a viewer subscribes to. Throws if the platform has no live
 * stream, the capture binary isn't built, or the port never comes up.
 */
export async function streamServerInfo(sessionName = 'default'): Promise<StreamServerInfo> {
  const deviceId = await resolveDeviceId(sessionName);
  if (!deviceId) {
    throw new Error('No device found. Connect a device or start a simulator, then run again.');
  }
  const platform = await detectPlatform(deviceId);
  if (platform !== 'ios' && platform !== 'tvos') {
    throw new Error(`Live video streaming is not yet available for ${platform} devices.`);
  }

  await startDaemon(deviceId);

  // The video server starts just after the input server — poll status until its port appears.
  const start = Date.now();
  const deadline = start + 60_000;
  while (Date.now() < deadline) {
    const status = await fetchDaemonStatus(deviceId);
    if (status && typeof status.streamPort === 'number') {
      return {
        device: deviceId,
        platform,
        streamPort: status.streamPort,
        url: `ws://127.0.0.1:${status.streamPort}/stream?device=${encodeURIComponent(deviceId)}&platform=${platform}`,
        codec: 'h264',
      };
    }
    // A daemon whose input server is up but that still reports no streamPort
    // after a grace period means the capture binary isn't built/available —
    // fail fast rather than waiting out the full timeout.
    if (
      status &&
      status.streamPort === null &&
      typeof status.inputPort === 'number' &&
      Date.now() - start > 5_000
    ) {
      throw new Error(
        `Video capture backend is not available for ${deviceId} ` +
          `(the conductor-capture binary is missing from the installed drivers).`
      );
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Video server for ${deviceId} did not come up within timeout.`);
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

export async function spawnCommand(
  cmd: string,
  args: string[],
  options?: { env?: NodeJS.ProcessEnv }
): Promise<RunResult> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: options?.env,
    });
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
