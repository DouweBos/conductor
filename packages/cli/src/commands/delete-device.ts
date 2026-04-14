export const HELP = `  delete-device <name-or-id>
    --platform <ios|tvos|android>  Scope to a single platform
    --all                          Delete all shutdown simulators / non-running AVDs`;

import { spawnCommand } from '../runner.js';
import { printSuccess, printError, printData, OutputOptions } from '../output.js';

// ── iOS / tvOS ───────────────────────────────────────────────────────────────

interface SimDevice {
  udid: string;
  name: string;
  state: string;
  isAvailable: boolean;
}

async function listSimulators(): Promise<{ runtime: string; device: SimDevice }[]> {
  const result = await spawnCommand('xcrun', ['simctl', 'list', 'devices', '--json']);
  if (!result.success) throw new Error(`xcrun simctl list failed: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout) as { devices: Record<string, SimDevice[]> };
  const flat: { runtime: string; device: SimDevice }[] = [];
  for (const [runtime, sims] of Object.entries(parsed.devices)) {
    for (const sim of sims) {
      if (sim.isAvailable) flat.push({ runtime, device: sim });
    }
  }
  return flat;
}

function simPlatform(runtime: string): 'ios' | 'tvos' {
  return runtime.includes('tvOS') ? 'tvos' : 'ios';
}

async function shutdownSimulator(udid: string): Promise<void> {
  const result = await spawnCommand('xcrun', ['simctl', 'shutdown', udid]);
  if (!result.success && !result.stderr.includes('current state: Shutdown')) {
    throw new Error(`Failed to shutdown simulator: ${result.stderr.trim()}`);
  }
}

async function deleteSimulator(udid: string): Promise<void> {
  const result = await spawnCommand('xcrun', ['simctl', 'delete', udid]);
  if (!result.success) {
    throw new Error(`Failed to delete simulator: ${result.stderr.trim()}`);
  }
}

// ── Android ──────────────────────────────────────────────────────────────────

async function listAVDs(): Promise<string[]> {
  const result = await spawnCommand('emulator', ['-list-avds']);
  if (!result.success) return [];
  return result.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Map running emulator serial → AVD name */
async function runningAVDs(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const result = await spawnCommand('adb', ['devices']);
  if (!result.success) return map;

  const serials = result.stdout
    .split('\n')
    .slice(1)
    .map((l) => l.trim().split(/\s+/)[0])
    .filter((s) => s && s.startsWith('emulator-'));

  for (const serial of serials) {
    const name = await spawnCommand('adb', ['-s', serial, 'emu', 'avd', 'name']);
    if (name.success) {
      const avdName = name.stdout.trim().split('\n')[0];
      if (avdName) map.set(avdName, serial);
    }
  }
  return map;
}

async function killEmulator(serial: string): Promise<void> {
  const result = await spawnCommand('adb', ['-s', serial, 'emu', 'kill']);
  if (!result.success) {
    throw new Error(`Failed to kill emulator ${serial}: ${result.stderr.trim()}`);
  }
}

async function deleteAVD(name: string): Promise<void> {
  const result = await spawnCommand('avdmanager', ['delete', 'avd', '-n', name]);
  if (!result.success) {
    throw new Error(`Failed to delete AVD "${name}": ${result.stderr.trim()}`);
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────

export async function deleteDevice(
  nameOrId: string | undefined,
  opts: OutputOptions,
  flags: { platform?: string; all?: boolean }
): Promise<number> {
  if (!nameOrId && !flags.all) {
    printError('delete-device requires a device name/ID, or --all', opts);
    return 1;
  }

  const platform = flags.platform?.toLowerCase();
  const includeIOS = !platform || platform === 'ios';
  const includeTvOS = !platform || platform === 'tvos';
  const includeAndroid = !platform || platform === 'android';
  const deleted: { id: string; name: string; platform: string }[] = [];

  // ── --all mode ───────────────────────────────────────────────────────────

  if (flags.all) {
    // iOS / tvOS: delete all non-booted simulators
    if (includeIOS || includeTvOS) {
      let sims: { runtime: string; device: SimDevice }[];
      try {
        sims = await listSimulators();
      } catch (e) {
        printError(e instanceof Error ? e.message : String(e), opts);
        return 1;
      }

      for (const { runtime, device } of sims) {
        const p = simPlatform(runtime);
        if (p === 'ios' && !includeIOS) continue;
        if (p === 'tvos' && !includeTvOS) continue;
        if (device.state === 'Booted') continue;

        try {
          await deleteSimulator(device.udid);
          deleted.push({ id: device.udid, name: device.name, platform: p });
        } catch (e) {
          printError(
            `Failed to delete ${device.name} (${device.udid}): ${e instanceof Error ? e.message : String(e)}`,
            opts
          );
        }
      }
    }

    // Android: delete all non-running AVDs
    if (includeAndroid) {
      const avds = await listAVDs();
      const running = await runningAVDs();

      for (const avd of avds) {
        if (running.has(avd)) continue;
        try {
          await deleteAVD(avd);
          deleted.push({ id: avd, name: avd, platform: 'android' });
        } catch (e) {
          printError(
            `Failed to delete AVD "${avd}": ${e instanceof Error ? e.message : String(e)}`,
            opts
          );
        }
      }
    }

    if (deleted.length === 0) {
      printError('No devices to delete.', opts);
      return 1;
    }

    if (opts.json) {
      printData({ status: 'ok', deleted }, opts);
    } else {
      for (const d of deleted) {
        printSuccess(`Deleted ${d.platform} device: ${d.name} (${d.id})`, opts);
      }
    }
    return 0;
  }

  // ── Single device mode ─────────────────────────────────────────────────

  // Try iOS / tvOS first
  if (includeIOS || includeTvOS) {
    let sims: { runtime: string; device: SimDevice }[];
    try {
      sims = await listSimulators();
    } catch (e) {
      printError(e instanceof Error ? e.message : String(e), opts);
      return 1;
    }

    const match = sims.find(({ runtime, device }) => {
      const p = simPlatform(runtime);
      if (p === 'ios' && !includeIOS) return false;
      if (p === 'tvos' && !includeTvOS) return false;
      return device.udid === nameOrId || device.name === nameOrId;
    });

    if (match) {
      const { runtime, device } = match;
      try {
        if (device.state === 'Booted') {
          console.log(`Shutting down ${device.name}...`);
          await shutdownSimulator(device.udid);
        }
        await deleteSimulator(device.udid);
      } catch (e) {
        printError(e instanceof Error ? e.message : String(e), opts);
        return 1;
      }

      const p = simPlatform(runtime);
      if (opts.json) {
        printData(
          { status: 'ok', deleted: [{ id: device.udid, name: device.name, platform: p }] },
          opts
        );
      } else {
        printSuccess(`Deleted ${p} device: ${device.name} (${device.udid})`, opts);
      }
      return 0;
    }
  }

  // Try Android
  if (includeAndroid) {
    const avds = await listAVDs();
    if (avds.includes(nameOrId!)) {
      const running = await runningAVDs();
      try {
        const serial = running.get(nameOrId!);
        if (serial) {
          console.log(`Killing emulator ${serial}...`);
          await killEmulator(serial);
        }
        await deleteAVD(nameOrId!);
      } catch (e) {
        printError(e instanceof Error ? e.message : String(e), opts);
        return 1;
      }

      if (opts.json) {
        printData(
          { status: 'ok', deleted: [{ id: nameOrId!, name: nameOrId!, platform: 'android' }] },
          opts
        );
      } else {
        printSuccess(`Deleted android AVD: ${nameOrId}`, opts);
      }
      return 0;
    }
  }

  printError(`Device "${nameOrId}" not found.`, opts);
  return 1;
}
