export const HELP = `  list-devices                        List booted and available devices/simulators`;

import { spawnCommand } from '../runner.js';
import { printData, printError, OutputOptions } from '../output.js';
import { isPlaywrightBrowserInstalled, webBrowserName } from '../drivers/bootstrap.js';
import { listDaemonSessions, daemonStatus } from '../daemon/client.js';

export interface Device {
  id: string;
  name: string;
  platform: string;
  status: string;
}

export async function discoverBootedDevices(): Promise<Device[]> {
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
      for (const [runtime, sims] of Object.entries(parsed.devices)) {
        for (const sim of sims) {
          if (sim.state === 'Booted') {
            devices.push({
              id: sim.udid,
              name: sim.name,
              platform: runtime.includes('tvOS') ? 'tvos' : 'ios',
              status: 'booted',
            });
          }
        }
      }
    } catch {
      // ignore parse errors
    }
  }

  // Check for running web browser sessions (daemon sessions starting with "web")
  const sessions = listDaemonSessions();
  for (const session of sessions) {
    if (session === 'web' || session.startsWith('web:')) {
      const status = await daemonStatus(session);
      if (status.running) {
        const browser = webBrowserName(session);
        const parts = session.split(':');
        const label = browser.charAt(0).toUpperCase() + browser.slice(1);
        const name = parts.length > 2 ? `${label} (${parts[2]})` : label;
        devices.push({
          id: session,
          name,
          platform: 'web',
          status: 'running',
        });
      }
    }
  }

  return devices;
}

export async function discoverAvailableDevices(): Promise<Device[]> {
  const devices: Device[] = [];

  // iOS: all available simulators that are not booted
  const xcrun = await spawnCommand('xcrun', ['simctl', 'list', 'devices', '--json']);
  if (xcrun.success) {
    try {
      const parsed = JSON.parse(xcrun.stdout) as {
        devices: Record<
          string,
          Array<{ udid: string; name: string; state: string; isAvailable: boolean }>
        >;
      };
      for (const [runtime, sims] of Object.entries(parsed.devices)) {
        for (const sim of sims) {
          if (sim.isAvailable && sim.state !== 'Booted') {
            devices.push({
              id: sim.udid,
              name: sim.name,
              platform: runtime.includes('tvOS') ? 'tvos' : 'ios',
              status: sim.state.toLowerCase(),
            });
          }
        }
      }
    } catch {
      // ignore parse errors
    }
  }

  // Android: list available AVDs
  const emu = await spawnCommand('emulator', ['-list-avds']);
  if (emu.success) {
    for (const line of emu.stdout.split('\n')) {
      const name = line.trim();
      if (name) {
        devices.push({ id: name, name, platform: 'android', status: 'available' });
      }
    }
  }

  return devices;
}

export async function listDevices(opts: OutputOptions): Promise<number> {
  const [devices, availableDevices] = await Promise.all([
    discoverBootedDevices(),
    discoverAvailableDevices(),
  ]);

  // Detect installed Playwright browsers for web support
  const webBrowsers = (['chromium', 'firefox', 'webkit'] as const).filter((b) =>
    isPlaywrightBrowserInstalled(b)
  );

  if (devices.length === 0 && availableDevices.length === 0 && webBrowsers.length === 0) {
    printError('No devices found. Start an emulator or simulator first.', opts);
    return 1;
  }

  if (opts.json) {
    const webDevices: Device[] = webBrowsers.map((b) => ({
      id: b === 'chromium' ? 'web' : `web:${b}`,
      name: b.charAt(0).toUpperCase() + b.slice(1),
      platform: 'web',
      status: 'available',
    }));
    printData(
      { status: 'ok', devices, availableDevices: [...availableDevices, ...webDevices] },
      opts
    );
  } else {
    if (devices.length > 0) {
      console.log('Booted devices:');
      for (const d of devices) {
        console.log(`  ${d.platform.padEnd(8)} ${d.status.padEnd(10)} ${d.id}  ${d.name}`);
      }
    } else {
      console.log('No booted devices.');
    }

    console.log('');

    if (availableDevices.length > 0) {
      console.log('Available devices:');
      for (const d of availableDevices) {
        console.log(`  ${d.platform.padEnd(8)} ${d.status.padEnd(10)} ${d.id}  ${d.name}`);
      }
    } else {
      console.log('No available devices.');
    }

    if (webBrowsers.length > 0) {
      console.log('');
      console.log('Web browsers:');
      for (const b of webBrowsers) {
        const deviceId = b === 'chromium' ? 'web' : `web:${b}`;
        console.log(
          `  web      available   ${deviceId.padEnd(16)} ${b.charAt(0).toUpperCase() + b.slice(1)}`
        );
      }
    }
  }
  return 0;
}
