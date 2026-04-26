/**
 * Deterministic Metro discovery helpers — shared between the daemon's
 * log collector and CLI-side commands that need to query Metro for a
 * specific device.
 *
 * The flow:
 *   1. From a device ID (simulator UDID / emulator serial), find which Metro
 *      port the device is connected to via `lsof` (iOS/tvOS) or
 *      `adb reverse` (Android). No scanning / probing required.
 *   2. From the same device ID, resolve the human-readable display name
 *      (`xcrun simctl list` / `adb getprop`).
 *   3. Query Metro's /json and filter targets whose `deviceName` matches.
 *
 * Matching by `deviceName` handles the case where multiple devices share a
 * single Metro instance. It is deterministic unless the user has created
 * two devices with the exact same display name.
 */
import { spawn } from 'child_process';
import { fetchTargets, MetroTarget } from './metro.js';
import { resolveAndroidTool } from '../../android/sdk.js';

/** Metro dev-server port ranges we consider. */
const METRO_PORT_RANGES: [number, number][] = [
  [8080, 8099], // Metro default range
  [19000, 19002], // Expo
];

export function isMetroPort(port: number): boolean {
  return METRO_PORT_RANGES.some(([lo, hi]) => port >= lo && port <= hi);
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

/**
 * Deterministically locate the Metro port this specific device is connected
 * to. Returns null if the device isn't connected to Metro.
 */
export async function discoverMetroPortForDevice(
  platform: string,
  deviceId: string
): Promise<number | null> {
  if (platform === 'android') {
    return discoverMetroPortAndroid(deviceId);
  }
  if (platform === 'ios' || platform === 'tvos') {
    return discoverMetroPortIOS(deviceId);
  }
  return null;
}

async function discoverMetroPortAndroid(deviceId: string): Promise<number | null> {
  try {
    const output = await spawnCapture(resolveAndroidTool('adb'), [
      '-s',
      deviceId,
      'reverse',
      '--list',
    ]);
    // Lines look like: host-13 tcp:8082 tcp:8082
    for (const line of output.split('\n')) {
      const match = line.match(/tcp:(\d+)\s+tcp:(\d+)/);
      if (!match) continue;
      const hostPort = parseInt(match[2], 10);
      if (isMetroPort(hostPort)) return hostPort;
    }
  } catch {
    // adb not available or device not connected
  }
  return null;
}

async function discoverMetroPortIOS(deviceId: string): Promise<number | null> {
  const pids = await getSimAppPIDs(deviceId);
  if (pids.length === 0) return null;

  const ports = new Set<number>();
  for (const pid of pids) {
    try {
      const output = await spawnCapture('lsof', [
        '-a',
        '-p',
        String(pid),
        '-iTCP',
        '-sTCP:ESTABLISHED',
        '-n',
        '-P',
      ]);
      for (const line of output.split('\n')) {
        // e.g. "Plex 18684 douwe 24u IPv6 ... TCP [::1]:55493->[::1]:8082 (ESTABLISHED)"
        const match = line.match(/->(?:\[::1\]|127\.0\.0\.1):(\d+)\b/);
        if (!match) continue;
        const port = parseInt(match[1], 10);
        if (isMetroPort(port)) ports.add(port);
      }
    } catch {
      // lsof failed for this pid — try the next
    }
  }
  if (ports.size === 0) return null;

  // Always verify each candidate is actually Metro (not some other service
  // that happens to be in the Metro port range). A single candidate is
  // still verified — otherwise a phantom port would be returned repeatedly.
  for (const port of ports) {
    try {
      const targets = await fetchTargets(port, 'localhost');
      if (targets.length > 0) return port;
    } catch {
      // not Metro — skip
    }
  }
  return null;
}

/**
 * Enumerate PIDs of all foreground apps running inside an iOS/tvOS simulator.
 * We don't filter by appId — the session's appId may be stale (the user might
 * have launched the RN app outside conductor), and detecting Metro only needs
 * to find *any* app with an established socket to a Metro port.
 */
async function getSimAppPIDs(deviceId: string): Promise<number[]> {
  try {
    const output = await spawnCapture('xcrun', ['simctl', 'spawn', deviceId, 'launchctl', 'list']);
    const pids: number[] = [];
    for (const line of output.split('\n')) {
      // "18684\t0\tUIKitApplication:tv.plex.rn.app.dev[f218][rb-legacy]"
      const match = line.match(/^(\d+)\s+\d+\s+UIKitApplication:/);
      if (!match) continue;
      const pid = parseInt(match[1], 10);
      if (pid <= 0) continue;
      pids.push(pid);
    }
    return pids;
  } catch {
    return [];
  }
}

/**
 * Resolve a device's display name — the same string Metro reports as
 * `deviceName` on /json targets.
 *
 * iOS/tvOS: the simulator's name from `xcrun simctl list devices`.
 * Android: `ro.product.model` via adb.
 */
export async function getDeviceDisplayName(
  platform: string,
  deviceId: string
): Promise<string | null> {
  if (platform === 'ios' || platform === 'tvos') {
    try {
      const output = await spawnCapture('xcrun', ['simctl', 'list', 'devices', '--json']);
      const parsed = JSON.parse(output) as {
        devices: Record<string, Array<{ udid: string; name: string }>>;
      };
      for (const sims of Object.values(parsed.devices)) {
        const match = sims.find((s) => s.udid === deviceId);
        if (match) return match.name;
      }
    } catch {
      // fall through
    }
    return null;
  }
  if (platform === 'android') {
    try {
      const output = await spawnCapture(resolveAndroidTool('adb'), [
        '-s',
        deviceId,
        'shell',
        'getprop',
        'ro.product.model',
      ]);
      const name = output.trim();
      return name || null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Filter Metro /json targets to those belonging to this device (by display
 * name), preferring the fusebox runtime if present. Returns undefined when
 * no matching target is found — the device may not be connected to Metro,
 * or may share its display name with another device.
 */
export function selectTargetForDevice(
  targets: MetroTarget[],
  displayName: string
): MetroTarget | undefined {
  const withWs = targets.filter((t) => t.webSocketDebuggerUrl);
  const matches = withWs.filter((t) => t.deviceName === displayName);
  if (matches.length === 0) return undefined;
  const fusebox = matches.find((t) => t.reactNative?.capabilities?.prefersFuseboxFrontend);
  return fusebox ?? matches[0];
}

/** Convenience: all /json targets belonging to this device. */
export function targetsForDevice(targets: MetroTarget[], displayName: string): MetroTarget[] {
  return targets.filter((t) => t.webSocketDebuggerUrl && t.deviceName === displayName);
}
