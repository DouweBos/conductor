/**
 * `xcrun devicectl` wrapper — the physical-device counterpart to `simctl`.
 *
 * Simulators and real devices share the XCTest driver (same HTTP protocol), but
 * everything around it differs: discovery, app install/launch, and reachability.
 * This module owns the devicectl half so the rest of the CLI can stay generic.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import dns from 'dns/promises';
import { log } from '../verbose.js';

export interface PhysicalDevice {
  /** CoreDevice identifier (UUID form) — what `-destination id=` and devicectl take. */
  identifier: string;
  /** Hardware UDID (40-hex form). Also accepted by xcodebuild. */
  udid: string;
  name: string;
  platform: 'ios' | 'tvos';
  /** True when the device is paired and currently reachable. */
  available: boolean;
  /** Hostnames devicectl advertises; these resolve over the CoreDevice tunnel only. */
  potentialHostnames: string[];
  osVersion: string;
  marketingName: string;
  developerModeEnabled: boolean;
}

export interface DevicectlDevice {
  identifier: string;
  deviceProperties?: {
    name?: string;
    osVersionNumber?: string;
    developerModeStatus?: string;
  };
  hardwareProperties?: {
    platform?: string;
    udid?: string;
    marketingName?: string;
    reality?: string;
  };
  connectionProperties?: {
    pairingState?: string;
    tunnelState?: string;
    transportType?: string;
    potentialHostnames?: string[];
  };
}

function devicectl(args: string[], timeoutMs = 30000): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('xcrun', ['devicectl', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`devicectl ${args[0]} ${args[1] ?? ''} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    proc.stdout?.on('data', (c: Buffer) => {
      out += c.toString();
    });
    proc.stderr?.on('data', (c: Buffer) => {
      err += c.toString();
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(out);
      } else {
        reject(new Error(`devicectl ${args.join(' ')} failed: ${err.trim() || out.trim()}`));
      }
    });
    proc.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

/**
 * Run a devicectl subcommand that reports its result as JSON. devicectl only
 * writes structured output to a file, never stdout, so every call round-trips
 * through a temp file.
 */
async function devicectlJson<T>(args: string[], timeoutMs = 30000): Promise<T> {
  const file = path.join(
    os.tmpdir(),
    `conductor-devicectl-${process.pid}-${Math.random().toString(36).slice(2)}.json`
  );
  try {
    await devicectl([...args, '--json-output', file], timeoutMs);
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } finally {
    fs.rmSync(file, { force: true });
  }
}

function toPlatform(raw: string | undefined): 'ios' | 'tvos' | null {
  if (!raw) return null;
  const v = raw.toLowerCase();
  if (v === 'ios' || v === 'ipados') return 'ios';
  if (v === 'tvos') return 'tvos';
  return null;
}

/** Map devicectl's device list onto PhysicalDevice, dropping anything we can't drive. */
export function parseDevicectlDevices(parsed: {
  result?: { devices?: DevicectlDevice[] };
}): PhysicalDevice[] {
  const devices: PhysicalDevice[] = [];
  for (const d of parsed.result?.devices ?? []) {
    const platform = toPlatform(d.hardwareProperties?.platform);
    // Skip simulators (reality: "simulator") — simctl already covers those.
    if (!platform || d.hardwareProperties?.reality !== 'physical') continue;
    devices.push({
      identifier: d.identifier,
      udid: d.hardwareProperties?.udid ?? d.identifier,
      name: d.deviceProperties?.name ?? d.identifier,
      platform,
      // Paired isn't enough: a device that's off or on another network stays
      // paired but reports no transport, and tunnelState goes 'unavailable'.
      available:
        d.connectionProperties?.pairingState === 'paired' &&
        d.connectionProperties?.tunnelState !== 'unavailable' &&
        !!d.connectionProperties?.transportType,
      potentialHostnames: d.connectionProperties?.potentialHostnames ?? [],
      osVersion: d.deviceProperties?.osVersionNumber ?? '',
      marketingName: d.hardwareProperties?.marketingName ?? '',
      developerModeEnabled: d.deviceProperties?.developerModeStatus === 'enabled',
    });
  }
  return devices;
}

/** List every paired physical iOS/tvOS device known to CoreDevice. */
export async function listPhysicalDevices(): Promise<PhysicalDevice[]> {
  try {
    return parseDevicectlDevices(await devicectlJson(['list', 'devices']));
  } catch (e) {
    log(`devicectl list devices failed: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

/** Cache: deviceId (identifier or udid) → device, or null when it isn't physical. */
const _deviceCache = new Map<string, PhysicalDevice | null>();

/** Look up a physical device by either its CoreDevice identifier or hardware UDID. */
export async function findPhysicalDevice(deviceId: string): Promise<PhysicalDevice | null> {
  if (_deviceCache.has(deviceId)) return _deviceCache.get(deviceId)!;
  const key = deviceId.toLowerCase();
  const match =
    (await listPhysicalDevices()).find(
      (d) => d.identifier.toLowerCase() === key || d.udid.toLowerCase() === key
    ) ?? null;
  _deviceCache.set(deviceId, match);
  return match;
}

/**
 * Resolve the address the host can reach the device's driver on.
 *
 * devicectl's `*.coredevice.local` hostnames only resolve inside Apple's
 * CoreDevice tunnel, so they're useless for a plain TCP connect. The device's
 * Bonjour name (`<name>.local`) is what actually resolves on the LAN, so we
 * derive that from the device name and resolve it to an IP once, since mDNS
 * lookups are slow enough to matter on every driver poll.
 */
const _hostCache = new Map<string, string>();

/**
 * The mDNS name a device advertises itself under, derived from its display name
 * the same way the device does: non-alphanumerics collapse to single dashes.
 */
export function bonjourHostname(deviceName: string): string {
  return (
    deviceName
      .replace(/[^A-Za-z0-9-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') + '.local'
  );
}

export async function resolveDeviceHost(device: PhysicalDevice): Promise<string> {
  const cached = _hostCache.get(device.identifier);
  if (cached) return cached;

  const candidates = [bonjourHostname(device.name), ...device.potentialHostnames];

  for (const host of candidates) {
    try {
      const { address } = await dns.lookup(host, { family: 4 });
      log(`Resolved ${device.name} → ${host} (${address})`);
      _hostCache.set(device.identifier, address);
      return address;
    } catch {
      /* try the next candidate */
    }
  }

  throw new Error(
    `Could not resolve a network address for "${device.name}".\n` +
      `Tried: ${candidates.join(', ')}\n` +
      `The device must be on the same network as this Mac for conductor to reach its driver.`
  );
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

export async function installApp(deviceId: string, appPath: string): Promise<void> {
  await devicectl(['device', 'install', 'app', '--device', deviceId, appPath], 300000);
}

export async function uninstallApp(deviceId: string, bundleId: string): Promise<void> {
  await devicectl(['device', 'uninstall', 'app', '--device', deviceId, bundleId], 60000);
}

/**
 * Launch an app. `env` is passed as devicectl's JSON environment dictionary,
 * which is the device-side equivalent of simctl's SIMCTL_CHILD_ vars.
 */
export async function launchApp(
  deviceId: string,
  bundleId: string,
  args: string[] = [],
  env?: Record<string, string>
): Promise<void> {
  const flags = ['device', 'process', 'launch', '--device', deviceId, '--terminate-existing'];
  if (env && Object.keys(env).length > 0) {
    flags.push('--environment-variables', JSON.stringify(env));
  }
  await devicectl([...flags, bundleId, ...args], 120000);
}

interface ProcessListResult {
  result?: { runningProcesses?: Array<{ processIdentifier: number; executable?: string }> };
}

/** Terminate an app by bundle id. devicectl only kills by PID, so resolve one first. */
export async function terminateApp(deviceId: string, bundleId: string): Promise<void> {
  const listed = await devicectlJson<ProcessListResult>([
    'device',
    'info',
    'processes',
    '--device',
    deviceId,
  ]);
  const match = (listed.result?.runningProcesses ?? []).find((p) =>
    p.executable?.includes(`${bundleId}`)
  );
  if (!match) return;
  await devicectl([
    'device',
    'process',
    'signal',
    '--device',
    deviceId,
    '--signal',
    'SIGKILL',
    '--pid',
    String(match.processIdentifier),
  ]);
}

interface AppListResult {
  result?: {
    apps?: Array<{ bundleIdentifier: string; name?: string; appClip?: boolean }>;
  };
}

export async function listApps(deviceId: string): Promise<Array<{ id: string; name: string }>> {
  const listed = await devicectlJson<AppListResult>([
    'device',
    'info',
    'apps',
    '--device',
    deviceId,
  ]);
  return (listed.result?.apps ?? []).map((a) => ({
    id: a.bundleIdentifier,
    name: a.name ?? a.bundleIdentifier,
  }));
}
