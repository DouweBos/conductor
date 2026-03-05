import { spawnCommand } from '../runner.js';
import { printData, printError, OutputOptions } from '../output.js';

interface Device {
  id: string;
  name: string;
  platform: string;
  status: string;
}

export async function listDevices(opts: OutputOptions): Promise<number> {
  const devices: Device[] = [];

  // Try adb devices (Android)
  const adb = await spawnCommand('adb', ['devices', '-l']);
  if (adb.success || adb.stdout.includes('List of devices')) {
    const lines = adb.stdout.split('\n').slice(1); // skip header
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === '') continue;
      const parts = trimmed.split(/\s+/);
      const id = parts[0];
      const status = parts[1] ?? 'unknown';
      if (id && status) {
        const modelMatch = trimmed.match(/model:(\S+)/);
        const name = modelMatch ? modelMatch[1].replace(/_/g, ' ') : id;
        devices.push({ id, name, platform: 'android', status });
      }
    }
  }

  // Try xcrun simctl list (iOS simulators)
  const xcrun = await spawnCommand('xcrun', ['simctl', 'list', 'devices', 'booted', '--json']);
  if (xcrun.success) {
    try {
      const parsed = JSON.parse(xcrun.stdout) as {
        devices: Record<string, Array<{ udid: string; name: string; state: string }>>;
      };
      for (const [_runtime, sims] of Object.entries(parsed.devices)) {
        for (const sim of sims) {
          if (sim.state === 'Booted') {
            devices.push({
              id: sim.udid,
              name: sim.name,
              platform: 'ios',
              status: 'booted',
            });
          }
        }
      }
    } catch {
      // ignore parse errors
    }
  }

  if (devices.length === 0) {
    printError('No devices found. Start an emulator or simulator first.', opts);
    return 1;
  }

  if (opts.json) {
    printData({ status: 'ok', devices }, opts);
  } else {
    for (const d of devices) {
      console.log(`${d.platform.padEnd(8)} ${d.status.padEnd(10)} ${d.id}  ${d.name}`);
    }
  }
  return 0;
}
