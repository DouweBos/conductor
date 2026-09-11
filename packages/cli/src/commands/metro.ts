export const HELP = `  metro stop [--port N]                Stop the Metro bundler process on a port (default 8081)
  metro reload [--port N] [--target N]  Reload the JS bundle without restarting native
  metro use <port|host:port> [<appId>]  Point an RN app at a Metro other than its compiled-in one
  metro use --reset [<appId>]           Drop the override, back to the compiled-in port`;

import { spawn } from 'child_process';
import { printSuccess, printError, printData, OutputOptions } from '../output.js';
import { cdpCall, resolveMetroPort } from '../drivers/metro-cdp.js';
import { detectPlatform, detectDeviceKind } from '../drivers/bootstrap.js';
import { detectFirstDevice, spawnCommand } from '../runner.js';
import { getSession } from '../session.js';

export interface MetroOptions {
  port?: number;
  targetIndex?: number;
}

export interface MetroUseOptions {
  location?: string | number;
  appId?: string;
  reset?: boolean;
}

async function pidsOnPort(port: number): Promise<number[]> {
  return new Promise((resolve) => {
    const proc = spawn('lsof', ['-ti', `tcp:${port}`], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    proc.stdout.on('data', (c: Buffer) => {
      out += c.toString();
    });
    proc.on('close', () => {
      const pids = out
        .split('\n')
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n) && n > 0);
      resolve(pids);
    });
    proc.on('error', () => resolve([]));
  });
}

export async function metroStop(opts: OutputOptions, metroOpts: MetroOptions): Promise<number> {
  // Deliberately not auto-discovered: this kills whatever listens on the port,
  // and guessing one risks killing a Metro the user did not mean to stop.
  const port = metroOpts.port ?? 8081;
  const pids = await pidsOnPort(port);

  if (pids.length === 0) {
    printData({ stopped: false, port, pids: [] }, opts);
    if (!opts.json) printSuccess(`No Metro process found on port ${port}`, opts);
    return 0;
  }

  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Process may already be gone
    }
  }

  // Give SIGTERM 2s, then SIGKILL anything still alive.
  await new Promise((r) => setTimeout(r, 2000));
  const survivors = await pidsOnPort(port);
  for (const pid of survivors) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // ignore
    }
  }

  if (opts.json) {
    printData({ stopped: true, port, pids }, opts);
  } else {
    printSuccess(`Stopped Metro on port ${port} (pids: ${pids.join(', ')})`, opts);
  }
  return 0;
}

export async function metroReload(
  opts: OutputOptions,
  sessionName: string,
  metroOpts: MetroOptions
): Promise<number> {
  let deviceId: string | undefined;
  let platform: string | undefined;
  if (sessionName && sessionName !== 'default') {
    deviceId = sessionName;
    platform = await detectPlatform(deviceId).catch(() => undefined);
  }
  const port = await resolveMetroPort({ port: metroOpts.port, deviceId, platform });

  // Try CDP Page.reload first (works on Hermes/Fusebox).
  try {
    await cdpCall<void>('Page.reload', undefined, {
      port,
      deviceId,
      platform,
      targetIndex: metroOpts.targetIndex,
    });
    if (opts.json) printData({ reloaded: true, port, method: 'cdp' }, opts);
    else printSuccess(`Reloaded Metro bundle on port ${port} (cdp)`, opts);
    return 0;
  } catch (cdpErr) {
    // Fall back to Metro's HTTP /reload endpoint.
    try {
      const res = await fetch(`http://127.0.0.1:${port}/reload`);
      if (!res.ok) {
        throw new Error(`HTTP /reload returned ${res.status}`);
      }
      if (opts.json) printData({ reloaded: true, port, method: 'http' }, opts);
      else printSuccess(`Reloaded Metro bundle on port ${port} (http)`, opts);
      return 0;
    } catch (httpErr) {
      const cdpMsg = cdpErr instanceof Error ? cdpErr.message : String(cdpErr);
      const httpMsg = httpErr instanceof Error ? httpErr.message : String(httpErr);
      printError(`metro reload failed.\n  cdp:  ${cdpMsg}\n  http: ${httpMsg}`, opts);
      return 1;
    }
  }
}

/**
 * NSUserDefaults key RCTBundleURLProvider reads before falling back to the
 * RCT_METRO_PORT baked into React-Core at pod-install time. Writing it is the
 * only way to move a build onto another port without recompiling.
 */
const JS_LOCATION_KEY = 'RCT_jsLocation';

/**
 * `8102` → `localhost:8102`. Also tolerates a pasted `http://host:port/`.
 *
 * Takes a number too: minimist turns a bare port argument into one.
 */
export function normalizeMetroLocation(raw: string | number): string {
  const trimmed = String(raw)
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
  const match = trimmed.match(/^(?:([A-Za-z0-9._-]+):)?(\d+)$/);
  if (!match) {
    throw new Error(`invalid location "${raw}" — expected <port> or <host:port>`);
  }

  const [, host = 'localhost', rawPort] = match;
  const port = Number(rawPort);
  if (port < 1 || port > 65535) {
    throw new Error(`invalid port "${rawPort}" in "${raw}" — expected 1-65535`);
  }

  return `${host}:${port}`;
}

async function isPackagerRunning(location: string): Promise<boolean> {
  try {
    const res = await fetch(`http://${location}/status`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok && (await res.text()).includes('packager-status:running');
  } catch {
    return false;
  }
}

/**
 * Point a React Native app at a specific Metro by writing RCTBundleURLProvider's
 * `RCT_jsLocation` default into the app's preferences on a simulator.
 *
 * The port an app asks for is compiled into React-Core from `RCT_METRO_PORT` at
 * pod-install time, so a build made against the wrong port (a git worktree with
 * its own Metro, a pod install from a shell missing the env var) keeps asking
 * for the old one until it is recompiled. This override survives reinstalls and
 * needs no rebuild.
 */
export async function metroUse(
  opts: OutputOptions,
  sessionName: string,
  useOpts: MetroUseOptions
): Promise<number> {
  const deviceId =
    sessionName && sessionName !== 'default' ? sessionName : await detectFirstDevice();
  if (!deviceId) {
    printError('metro use: no device found. Pass --device <id> or boot a simulator.', opts);
    return 1;
  }

  const platform = await detectPlatform(deviceId).catch(() => undefined);
  if (platform !== 'ios' && platform !== 'tvos') {
    printError(
      `metro use: only iOS/tvOS simulators are supported (device is ${platform ?? 'unknown'}).\n` +
        'On Android, map the port instead: adb -s <serial> reverse tcp:8081 tcp:<metro-port>',
      opts
    );
    return 1;
  }

  const kind = await detectDeviceKind(deviceId).catch(() => undefined);
  if (kind === 'physical') {
    printError(
      'metro use: physical devices read their packager host from the bundled ip.txt, ' +
        'not from simulator defaults. Set it from the in-app dev menu instead.',
      opts
    );
    return 1;
  }

  const appId = useOpts.appId ?? (await getSession(sessionName)).appId;
  if (!appId) {
    printError('metro use: no appId given and no active session. Run launch-app first.', opts);
    return 1;
  }

  if (useOpts.reset) {
    // `defaults delete` exits non-zero when the key was never written, which is
    // the same end state the caller asked for.
    await spawnCommand('xcrun', [
      'simctl',
      'spawn',
      deviceId,
      'defaults',
      'delete',
      appId,
      JS_LOCATION_KEY,
    ]);

    if (opts.json) printData({ appId, deviceId, location: null, reset: true }, opts);
    else printSuccess(`Cleared Metro override for "${appId}" — relaunch the app to apply`, opts);
    return 0;
  }

  if (!useOpts.location) {
    printError('Usage: conductor metro use <port|host:port> [<appId>] | metro use --reset', opts);
    return 1;
  }

  let location: string;
  try {
    location = normalizeMetroLocation(useOpts.location);
  } catch (err) {
    printError(`metro use: ${err instanceof Error ? err.message : String(err)}`, opts);
    return 1;
  }

  const running = await isPackagerRunning(location);

  const result = await spawnCommand('xcrun', [
    'simctl',
    'spawn',
    deviceId,
    'defaults',
    'write',
    appId,
    JS_LOCATION_KEY,
    location,
  ]);

  if (!result.success) {
    printError(
      `metro use: could not write ${JS_LOCATION_KEY} for "${appId}"\n${result.stderr}`,
      opts
    );
    return 1;
  }

  if (!running) {
    // RCTBundleURLProvider drops a stored location when nothing answers there,
    // so the app would silently fall back to its compiled-in port.
    process.stderr.write(
      `warning: no packager answered at ${location}; the app falls back to its ` +
        'compiled-in port until Metro is up there.\n'
    );
  }

  if (opts.json) {
    printData({ appId, deviceId, location, packagerRunning: running, reset: false }, opts);
  } else {
    printSuccess(`"${appId}" → ${location} — relaunch the app to apply`, opts);
  }
  return 0;
}
