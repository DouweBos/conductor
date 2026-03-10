export const HELP = `  start-device
    --platform <ios|android>          Boot a simulator or emulator
    --os-version <n>                  iOS version (e.g. 18) or Android API level (e.g. 33)
    --avd <name>                      Android AVD name (default: first available)
    --name <name>                     Set a custom name on the simulator after boot (iOS only)
    --device-type <name>              iOS device type (e.g. "iPhone 16 Pro"); creates if needed`;

import { spawn } from 'child_process';
import { spawnCommand } from '../runner.js';
import { printSuccess, printError, OutputOptions } from '../output.js';
import { sleep } from '../utils.js';

const IOS_BOOT_TIMEOUT_MS = 120_000;
const ANDROID_BOOT_TIMEOUT_MS = 120_000;
const POLL_MS = 1000;

// ── iOS ───────────────────────────────────────────────────────────────────────

interface SimDevice {
  udid: string;
  name: string;
  state: string;
  isAvailable: boolean;
}

interface SimDeviceType {
  name: string;
  identifier: string;
  minRuntimeVersion?: number;
  maxRuntimeVersion?: number;
}

interface SimRuntime {
  version: string;
  identifier: string;
  isAvailable: boolean;
}

async function listIOSSimulators(): Promise<Record<string, SimDevice[]>> {
  const result = await spawnCommand('xcrun', ['simctl', 'list', 'devices', '--json']);
  if (!result.success) throw new Error(`xcrun simctl list failed: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout) as { devices: Record<string, SimDevice[]> };
  return parsed.devices;
}

async function listDeviceTypes(): Promise<SimDeviceType[]> {
  const result = await spawnCommand('xcrun', ['simctl', 'list', 'devicetypes', '--json']);
  if (!result.success) throw new Error(`xcrun simctl list devicetypes failed: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout) as { devicetypes: SimDeviceType[] };
  return parsed.devicetypes;
}

async function listRuntimes(): Promise<SimRuntime[]> {
  const result = await spawnCommand('xcrun', ['simctl', 'list', 'runtimes', '--json']);
  if (!result.success) throw new Error(`xcrun simctl list runtimes failed: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout) as { runtimes: SimRuntime[] };
  return parsed.runtimes;
}

function runtimeVersionNumber(version: string): number {
  // Convert "18.2" → 180200, "17.0.1" → 170001 for numeric comparison
  const parts = version.split('.').map(Number);
  return (parts[0] ?? 0) * 10000 + (parts[1] ?? 0) * 100 + (parts[2] ?? 0);
}

async function createIOSSimulator(deviceType: string, osVersion?: string): Promise<string> {
  const deviceTypes = await listDeviceTypes();
  const runtimes = await listRuntimes();

  const matchedType = deviceTypes.find((dt) => dt.name.toLowerCase() === deviceType.toLowerCase());
  if (!matchedType) {
    const iPhoneTypes = deviceTypes
      .filter((dt) => dt.name.toLowerCase().includes('iphone'))
      .map((dt) => dt.name);
    throw new Error(
      `Unknown device type "${deviceType}". Available iPhone types:\n  ${iPhoneTypes.join('\n  ')}`
    );
  }

  // Filter to available iOS runtimes
  let candidates = runtimes.filter(
    (r) => r.isAvailable && r.identifier.startsWith('com.apple.CoreSimulator.SimRuntime.iOS')
  );

  if (osVersion) {
    candidates = candidates.filter((r) => r.version.startsWith(osVersion));
  }

  if (candidates.length === 0) {
    const hint = osVersion ? ` matching version ${osVersion}` : '';
    throw new Error(
      `No available iOS runtime found${hint}. Install one via Xcode → Settings → Platforms.`
    );
  }

  // Sort by version descending to pick the latest
  candidates.sort((a, b) => runtimeVersionNumber(b.version) - runtimeVersionNumber(a.version));

  // Filter by device type compatibility if min/max runtime version is specified
  const compatible = candidates.filter((r) => {
    const ver = runtimeVersionNumber(r.version);
    if (matchedType.minRuntimeVersion && ver < matchedType.minRuntimeVersion) return false;
    if (matchedType.maxRuntimeVersion && ver > matchedType.maxRuntimeVersion) return false;
    return true;
  });

  const runtime = compatible.length > 0 ? compatible[0] : candidates[0];

  const createResult = await spawnCommand('xcrun', [
    'simctl',
    'create',
    deviceType,
    matchedType.identifier,
    runtime.identifier,
  ]);
  if (!createResult.success) {
    throw new Error(`Failed to create simulator: ${createResult.stderr.trim()}`);
  }

  return createResult.stdout.trim(); // UDID
}

async function bootIOSSimulator(udid: string): Promise<void> {
  const result = await spawnCommand('xcrun', ['simctl', 'boot', udid]);
  // exit 149 = already booted, that's fine
  if (!result.success && !result.stderr.includes('already booted')) {
    throw new Error(`xcrun simctl boot failed: ${result.stderr.trim()}`);
  }
}

async function waitForIOSBoot(udid: string): Promise<void> {
  const deadline = Date.now() + IOS_BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await spawnCommand('xcrun', ['simctl', 'list', 'devices', 'booted', '--json']);
    if (result.success) {
      const parsed = JSON.parse(result.stdout) as { devices: Record<string, SimDevice[]> };
      const booted = Object.values(parsed.devices)
        .flat()
        .some((d) => d.udid === udid);
      if (booted) return;
    }
    await sleep(POLL_MS);
  }
  throw new Error(`Simulator ${udid} did not boot within ${IOS_BOOT_TIMEOUT_MS / 1000}s`);
}

async function renameIOSSimulator(udid: string, name: string): Promise<void> {
  const result = await spawnCommand('xcrun', ['simctl', 'rename', udid, name]);
  if (!result.success) {
    throw new Error(`xcrun simctl rename failed: ${result.stderr.trim()}`);
  }
}

async function startIOS(
  osVersion: string | undefined,
  opts: OutputOptions,
  name?: string,
  deviceType?: string
): Promise<number> {
  let devices: Record<string, SimDevice[]>;
  try {
    devices = await listIOSSimulators();
  } catch (e) {
    printError(`Failed to list simulators: ${e instanceof Error ? e.message : String(e)}`, opts);
    return 1;
  }

  // Filter to available (installable) simulators, optionally by OS version and device type
  const candidates: { runtime: string; device: SimDevice }[] = [];
  for (const [runtime, sims] of Object.entries(devices)) {
    if (osVersion && !runtime.includes(osVersion)) continue;
    for (const sim of sims) {
      if (deviceType && sim.name.toLowerCase() !== deviceType.toLowerCase()) continue;
      if (sim.isAvailable && sim.state !== 'Booted') {
        candidates.push({ runtime, device: sim });
      }
      // If already booted, just report it
      if (sim.isAvailable && sim.state === 'Booted') {
        if (!osVersion || runtime.includes(osVersion)) {
          if (name) {
            try {
              await renameIOSSimulator(sim.udid, name);
            } catch (e) {
              printError(e instanceof Error ? e.message : String(e), opts);
              return 1;
            }
          }
          const displayName = name ?? sim.name;
          printSuccess(`Simulator already booted: ${displayName} (${sim.udid})`, opts);
          return 0;
        }
      }
    }
  }

  if (candidates.length === 0) {
    // If a device type was requested, try to create the simulator
    if (deviceType) {
      console.log(`No existing simulator found for "${deviceType}". Creating one...`);
      let udid: string;
      try {
        udid = await createIOSSimulator(deviceType, osVersion);
      } catch (e) {
        printError(e instanceof Error ? e.message : String(e), opts);
        return 1;
      }

      console.log(`Created simulator: ${deviceType} (${udid}). Booting...`);
      try {
        await bootIOSSimulator(udid);
        await waitForIOSBoot(udid);
      } catch (e) {
        printError(e instanceof Error ? e.message : String(e), opts);
        return 1;
      }

      if (name) {
        try {
          await renameIOSSimulator(udid, name);
        } catch (e) {
          printError(e instanceof Error ? e.message : String(e), opts);
          return 1;
        }
      }

      spawn('open', ['-a', 'Simulator'], { detached: true, stdio: 'ignore' }).unref();

      const displayName = name ?? deviceType;
      printSuccess(`Booted: ${displayName} (${udid})`, opts);
      return 0;
    }

    const hint = osVersion ? ` for iOS ${osVersion}` : '';
    printError(
      `No available iOS simulator found${hint}. Install one via Xcode → Settings → Platforms.`,
      opts
    );
    return 1;
  }

  // Prefer iPhone models over iPad
  const sorted = candidates.sort((a, b) => {
    const ai = a.device.name.toLowerCase().includes('iphone') ? 0 : 1;
    const bi = b.device.name.toLowerCase().includes('iphone') ? 0 : 1;
    return ai - bi;
  });

  const { device } = sorted[0];
  console.log(`Booting simulator: ${device.name} (${device.udid})...`);

  try {
    await bootIOSSimulator(device.udid);
    await waitForIOSBoot(device.udid);
  } catch (e) {
    printError(e instanceof Error ? e.message : String(e), opts);
    return 1;
  }

  if (name) {
    try {
      await renameIOSSimulator(device.udid, name);
    } catch (e) {
      printError(e instanceof Error ? e.message : String(e), opts);
      return 1;
    }
  }

  // Open the Simulator.app so the window appears
  spawn('open', ['-a', 'Simulator'], { detached: true, stdio: 'ignore' }).unref();

  const displayName = name ?? device.name;
  printSuccess(`Booted: ${displayName} (${device.udid})`, opts);
  return 0;
}

// ── Android ───────────────────────────────────────────────────────────────────

async function listAVDs(): Promise<string[]> {
  const result = await spawnCommand('emulator', ['-list-avds']);
  if (!result.success) throw new Error(`emulator -list-avds failed: ${result.stderr}`);
  return result.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

async function waitForAndroidBoot(avdName: string): Promise<string> {
  const deadline = Date.now() + ANDROID_BOOT_TIMEOUT_MS;
  const connectedBefore = new Set<string>();

  // Snapshot currently connected devices so we can identify the new one
  const before = await spawnCommand('adb', ['devices']);
  for (const line of before.stdout.split('\n').slice(1)) {
    const id = line.trim().split(/\s+/)[0];
    if (id) connectedBefore.add(id);
  }

  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const result = await spawnCommand('adb', ['devices']);
    if (!result.success) continue;
    for (const line of result.stdout.split('\n').slice(1)) {
      const parts = line.trim().split(/\s+/);
      const id = parts[0];
      const status = parts[1];
      if (id && status === 'device' && !connectedBefore.has(id)) {
        // Check boot completed
        const boot = await spawnCommand('adb', [
          '-s',
          id,
          'shell',
          'getprop',
          'sys.boot_completed',
        ]);
        if (boot.stdout.trim() === '1') return id;
      }
    }
  }
  throw new Error(
    `Android emulator (${avdName}) did not appear within ${ANDROID_BOOT_TIMEOUT_MS / 1000}s`
  );
}

async function startAndroid(avdName: string | undefined, opts: OutputOptions): Promise<number> {
  let avds: string[];
  try {
    avds = await listAVDs();
  } catch (e) {
    printError(`Failed to list AVDs: ${e instanceof Error ? e.message : String(e)}`, opts);
    return 1;
  }

  if (avds.length === 0) {
    printError('No Android AVDs found. Create one in Android Studio → Device Manager.', opts);
    return 1;
  }

  const target = avdName ?? avds[0];
  if (!avds.includes(target)) {
    printError(`AVD "${target}" not found. Available: ${avds.join(', ')}`, opts);
    return 1;
  }

  console.log(`Launching emulator: ${target}...`);

  const proc = spawn('emulator', ['-avd', target, '-netdelay', 'none', '-netspeed', 'full'], {
    detached: true,
    stdio: 'ignore',
  });
  proc.unref();

  let deviceId: string;
  try {
    deviceId = await waitForAndroidBoot(target);
  } catch (e) {
    printError(e instanceof Error ? e.message : String(e), opts);
    return 1;
  }

  printSuccess(`Emulator ready: ${target} (${deviceId})`, opts);
  return 0;
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function startDevice(
  platform: string | undefined,
  opts: OutputOptions,
  flags: { osVersion?: string; avd?: string; name?: string; deviceType?: string }
): Promise<number> {
  if (!platform) {
    printError('start-device requires --platform ios|android', opts);
    return 1;
  }

  switch (platform.toLowerCase()) {
    case 'ios':
      return startIOS(flags.osVersion, opts, flags.name, flags.deviceType);
    case 'android':
      return startAndroid(flags.avd, opts);
    default:
      printError(`Unknown platform "${platform}". Use ios or android.`, opts);
      return 1;
  }
}
