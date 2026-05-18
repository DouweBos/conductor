export const HELP = `  metro stop [--port N]                Stop the Metro bundler process on a port (default 8081)
  metro reload [--port N] [--target N]  Reload the JS bundle without restarting native`;

import { spawn } from 'child_process';
import { printSuccess, printError, printData, OutputOptions } from '../output.js';
import { cdpCall } from '../drivers/metro-cdp.js';
import { detectPlatform } from '../drivers/bootstrap.js';

export interface MetroOptions {
  port?: number;
  targetIndex?: number;
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
  const port = metroOpts.port ?? 8081;
  let deviceId: string | undefined;
  let platform: string | undefined;
  if (sessionName && sessionName !== 'default') {
    deviceId = sessionName;
    platform = await detectPlatform(deviceId).catch(() => undefined);
  }

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
