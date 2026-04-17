export const HELP = `  stop-device [<name-or-id>]
    --platform <ios|tvos|android|web> Scope to a single platform
    --all                             Stop all booted simulators / running emulators / web sessions`;

import { spawnCommand } from '../runner.js';
import { printSuccess, printError, printData, OutputOptions } from '../output.js';
import { stopDaemon } from '../daemon/client.js';
import { discoverBootedDevices } from './list-devices.js';

// ── iOS / tvOS ───────────────────────────────────────────────────────────────

async function shutdownSimulator(udid: string): Promise<void> {
  const result = await spawnCommand('xcrun', ['simctl', 'shutdown', udid]);
  if (!result.success && !result.stderr.includes('current state: Shutdown')) {
    throw new Error(`Failed to shutdown simulator: ${result.stderr.trim()}`);
  }
}

// ── Android ──────────────────────────────────────────────────────────────────

async function killEmulator(serial: string): Promise<void> {
  const result = await spawnCommand('adb', ['-s', serial, 'emu', 'kill']);
  if (!result.success) {
    throw new Error(`Failed to kill emulator ${serial}: ${result.stderr.trim()}`);
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────

export async function stopDevice(
  nameOrId: string | undefined,
  opts: OutputOptions,
  flags: { platform?: string; all?: boolean }
): Promise<number> {
  if (!nameOrId && !flags.all) {
    printError('stop-device requires a device name/ID, or --all', opts);
    return 1;
  }

  const platform = flags.platform?.toLowerCase();
  const includeIOS = !platform || platform === 'ios';
  const includeTvOS = !platform || platform === 'tvos';
  const includeAndroid = !platform || platform === 'android';
  const includeWeb = !platform || platform === 'web';
  const stopped: { id: string; name: string; platform: string }[] = [];

  // ── --all mode ───────────────────────────────────────────────────────────

  if (flags.all) {
    const devices = await discoverBootedDevices();

    for (const d of devices) {
      if (d.platform === 'ios' && !includeIOS) continue;
      if (d.platform === 'tvos' && !includeTvOS) continue;
      if (d.platform === 'android' && !includeAndroid) continue;
      if (d.platform === 'web' && !includeWeb) continue;

      try {
        if (d.platform === 'ios' || d.platform === 'tvos') {
          await shutdownSimulator(d.id);
        } else if (d.platform === 'android') {
          await killEmulator(d.id);
        } else if (d.platform === 'web') {
          await stopDaemon(d.id);
        }
        stopped.push({ id: d.id, name: d.name, platform: d.platform });
      } catch (e) {
        printError(
          `Failed to stop ${d.name} (${d.id}): ${e instanceof Error ? e.message : String(e)}`,
          opts
        );
      }
    }

    if (stopped.length === 0) {
      printError('No running devices to stop.', opts);
      return 1;
    }

    if (opts.json) {
      printData({ status: 'ok', stopped }, opts);
    } else {
      for (const d of stopped) {
        printSuccess(`Stopped ${d.platform} device: ${d.name} (${d.id})`, opts);
      }
    }
    return 0;
  }

  // ── Single device mode ─────────────────────────────────────────────────

  const devices = await discoverBootedDevices();
  const match = devices.find((d) => {
    if (platform && d.platform !== platform) return false;
    return d.id === nameOrId || d.name === nameOrId;
  });

  if (!match) {
    printError(`No running device found matching "${nameOrId}".`, opts);
    return 1;
  }

  try {
    if (match.platform === 'ios' || match.platform === 'tvos') {
      await shutdownSimulator(match.id);
    } else if (match.platform === 'android') {
      await killEmulator(match.id);
    } else if (match.platform === 'web') {
      await stopDaemon(match.id);
    }
  } catch (e) {
    printError(e instanceof Error ? e.message : String(e), opts);
    return 1;
  }

  if (opts.json) {
    printData(
      { status: 'ok', stopped: [{ id: match.id, name: match.name, platform: match.platform }] },
      opts
    );
  } else {
    printSuccess(`Stopped ${match.platform} device: ${match.name} (${match.id})`, opts);
  }
  return 0;
}
