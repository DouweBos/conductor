export const HELP = `  list-devices                        List booted and available devices/simulators`;

import fs from 'fs';
import { spawnCommand } from '../runner.js';
import { printData, printError, OutputOptions } from '../output.js';
import { isPlaywrightBrowserInstalled, webBrowserName } from '../drivers/bootstrap.js';
import { listDaemonSessions, daemonStatus } from '../daemon/client.js';
import { nameFile } from '../daemon/protocol.js';

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
        const label = browser.charAt(0).toUpperCase() + browser.slice(1);
        let name: string;
        try {
          const saved = fs.readFileSync(nameFile(session), 'utf-8').trim();
          name = saved || label;
        } catch {
          name = label;
        }
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

  // Web: installed Playwright browsers that aren't currently running
  const runningSessions = listDaemonSessions();
  const runningBrowsers = new Set(
    runningSessions.filter((s) => s === 'web' || s.startsWith('web:')).map((s) => webBrowserName(s))
  );

  for (const browser of ['chromium', 'firefox', 'webkit'] as const) {
    if (isPlaywrightBrowserInstalled(browser)) {
      devices.push({
        id: browser === 'chromium' ? 'web' : `web:${browser}`,
        name: browser.charAt(0).toUpperCase() + browser.slice(1),
        platform: 'web',
        status: runningBrowsers.has(browser) ? 'installed' : 'available',
      });
    }
  }

  return devices;
}

export async function listDevices(opts: OutputOptions): Promise<number> {
  const [devices, availableDevices] = await Promise.all([
    discoverBootedDevices(),
    discoverAvailableDevices(),
  ]);

  if (devices.length === 0 && availableDevices.length === 0) {
    printError('No devices found. Start an emulator or simulator first.', opts);
    return 1;
  }

  if (opts.json) {
    printData({ status: 'ok', devices, availableDevices }, opts);
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
  }
  return 0;
}
