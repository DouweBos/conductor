export const HELP = `  profile cpu --duration <s> [--out <path>]
                                       Record a CPU trace (iOS: xctrace, Android: simpleperf)
  profile memory --track <s> [--interval <ms>] [<appId>]
                                       Sample memory for N seconds, report deltas
  profile react start                  Install a React commit-profiler hook in the JS runtime
  profile react stop [--top N]         Stop and summarise captured React commits`;

import { spawn } from 'child_process';
import os from 'os';
import path from 'path';
import { printError, printData, printSuccess, OutputOptions } from '../output.js';
import { detectPlatform } from '../drivers/bootstrap.js';
import { resolveAndroidTool, androidSpawnEnv } from '../android/sdk.js';
import { memory } from './memory.js';
import { MetroCdpClient } from '../drivers/metro-cdp.js';

export interface ProfileCpuOptions {
  durationSec: number;
  out?: string;
  appId?: string;
}

function defaultTracePath(prefix: string, ext: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(os.tmpdir(), `${prefix}-${ts}.${ext}`);
}

async function recordIosCpu(
  deviceId: string,
  appId: string | undefined,
  durationSec: number,
  out: string
): Promise<void> {
  const args = [
    'xctrace',
    'record',
    '--template',
    'Time Profiler',
    '--device',
    deviceId,
    '--time-limit',
    `${durationSec}s`,
    '--output',
    out,
  ];
  if (appId) args.push('--attach', appId);
  await new Promise<void>((resolve, reject) => {
    const proc = spawn('xcrun', args, { stdio: 'inherit' });
    proc.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`xctrace exited with code ${code}`))
    );
    proc.on('error', reject);
  });
}

async function recordAndroidCpu(
  deviceId: string,
  appId: string | undefined,
  durationSec: number,
  out: string
): Promise<void> {
  const adb = resolveAndroidTool('adb');
  const env = androidSpawnEnv();
  const remote = `/data/local/tmp/conductor-perf-${Date.now()}.data`;
  const recordArgs = [
    '-s',
    deviceId,
    'shell',
    'simpleperf',
    'record',
    '-o',
    remote,
    '--duration',
    String(durationSec),
  ];
  if (appId) {
    recordArgs.push('--app', appId);
  } else {
    recordArgs.push('-a');
  }
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(adb, recordArgs, { stdio: 'inherit', env });
    proc.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`simpleperf record exited with ${code}`))
    );
    proc.on('error', reject);
  });
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(adb, ['-s', deviceId, 'pull', remote, out], { stdio: 'inherit', env });
    proc.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`adb pull exited with ${code}`))
    );
    proc.on('error', reject);
  });
  await new Promise<void>((resolve) => {
    const proc = spawn(adb, ['-s', deviceId, 'shell', 'rm', remote], { stdio: 'ignore', env });
    proc.on('close', () => resolve());
    proc.on('error', () => resolve());
  });
}

export async function profileCpu(
  opts: OutputOptions,
  sessionName: string,
  profileOpts: ProfileCpuOptions
): Promise<number> {
  if (sessionName === 'default') {
    printError('profile cpu requires a --device', opts);
    return 1;
  }
  const platform = await detectPlatform(sessionName).catch(() => null);
  const isIos = platform === 'ios' || platform === 'tvos';
  const out = profileOpts.out ?? defaultTracePath('cpu', isIos ? 'trace' : 'perf.data');
  try {
    if (isIos) {
      await recordIosCpu(sessionName, profileOpts.appId, profileOpts.durationSec, out);
    } else if (platform === 'android') {
      await recordAndroidCpu(sessionName, profileOpts.appId, profileOpts.durationSec, out);
    } else {
      printError(`profile cpu is not supported on platform ${platform ?? '(unknown)'}`, opts);
      return 1;
    }
    if (opts.json) printData({ out, durationSec: profileOpts.durationSec, platform }, opts);
    else printSuccess(`profile cpu — recorded ${profileOpts.durationSec}s → ${out}`, opts);
    return 0;
  } catch (err) {
    printError(`profile cpu — ${err instanceof Error ? err.message : String(err)}`, opts);
    return 1;
  }
}

export interface ProfileMemoryOptions {
  trackSec: number;
  intervalMs: number;
  appId?: string;
}

export async function profileMemory(
  opts: OutputOptions,
  sessionName: string,
  profileOpts: ProfileMemoryOptions
): Promise<number> {
  const samples: Array<{ at: number; sample: string }> = [];
  const start = Date.now();
  const end = start + profileOpts.trackSec * 1000;

  while (Date.now() < end) {
    const at = Date.now() - start;
    // Capture memory output for this sample by intercepting stdout.
    const captured = await captureStdout(async () => {
      await memory(profileOpts.appId, { json: true }, sessionName, {});
    });
    samples.push({ at, sample: captured });
    if (Date.now() < end) {
      await new Promise((r) => setTimeout(r, profileOpts.intervalMs));
    }
  }

  const parsed = samples.map((s) => {
    try {
      return { at: s.at, data: JSON.parse(s.sample) as Record<string, unknown> };
    } catch {
      return { at: s.at, data: null };
    }
  });

  if (opts.json) {
    printData({ samples: parsed, durationMs: Date.now() - start }, opts);
  } else {
    console.log(`profile memory — ${samples.length} samples over ${profileOpts.trackSec}s`);
    for (const p of parsed) {
      const summary =
        p.data && typeof p.data === 'object'
          ? Object.entries(p.data)
              .slice(0, 4)
              .map(([k, v]) => `${k}=${typeof v === 'object' ? '…' : String(v)}`)
              .join(' ')
          : '(parse error)';
      console.log(`  t+${(p.at / 1000).toFixed(1)}s  ${summary}`);
    }
  }
  return 0;
}

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((c: string | Uint8Array) => {
    chunks.push(typeof c === 'string' ? c : Buffer.from(c).toString());
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = origWrite;
  }
  return chunks.join('');
}

// ── React profiler ────────────────────────────────────────────────────────────

const REACT_PROFILER_INSTALL = `
(() => {
  if (globalThis.__CONDUCTOR_REACT_PROFILER__) {
    return { installed: true, already: true };
  }
  const hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook) return { installed: false, error: 'No React DevTools hook (Hermes only?)' };
  const commits = [];
  const MAX = 500;
  const orig = hook.onCommitFiberRoot;
  hook.onCommitFiberRoot = function(rendererID, root, priorityLevel) {
    try {
      const entry = { at: Date.now(), rendererID, components: [] };
      let node = root.current;
      const stack = [{ fiber: node, depth: 0 }];
      let count = 0;
      while (stack.length && count < 200) {
        const { fiber, depth } = stack.pop();
        if (!fiber) continue;
        const dur = fiber.actualDuration ?? 0;
        if (dur > 0) {
          const name = (fiber.type && (fiber.type.displayName || fiber.type.name)) || (typeof fiber.type === 'string' ? fiber.type : null);
          if (name) {
            entry.components.push({ name, depth, actualDuration: dur, selfDuration: fiber.selfBaseDuration ?? 0 });
            count++;
          }
        }
        if (fiber.child) stack.push({ fiber: fiber.child, depth: depth + 1 });
        if (fiber.sibling) stack.push({ fiber: fiber.sibling, depth });
      }
      commits.push(entry);
      if (commits.length > MAX) commits.shift();
    } catch (e) {}
    if (typeof orig === 'function') return orig.apply(this, arguments);
  };
  globalThis.__CONDUCTOR_REACT_PROFILER__ = {
    installed: true,
    commits,
    uninstall: () => { hook.onCommitFiberRoot = orig; }
  };
  return { installed: true, already: false };
})()
`;

const REACT_PROFILER_READ = (top: number) => `
(() => {
  const p = globalThis.__CONDUCTOR_REACT_PROFILER__;
  if (!p) return { installed: false, commits: [] };
  const commits = p.commits.slice();
  const byName = {};
  for (const c of commits) {
    for (const comp of c.components) {
      byName[comp.name] = byName[comp.name] ?? { name: comp.name, totalMs: 0, renders: 0 };
      byName[comp.name].totalMs += comp.actualDuration;
      byName[comp.name].renders += 1;
    }
  }
  const top = Object.values(byName).sort((a, b) => b.totalMs - a.totalMs).slice(0, ${top});
  return { installed: true, commits, totalCommits: commits.length, top };
})()
`;

const REACT_PROFILER_STOP = `
(() => {
  const p = globalThis.__CONDUCTOR_REACT_PROFILER__;
  if (!p) return { installed: false };
  if (typeof p.uninstall === 'function') p.uninstall();
  delete globalThis.__CONDUCTOR_REACT_PROFILER__;
  return { installed: true, stopped: true };
})()
`;

interface ReactProfilerStartResult {
  installed: boolean;
  already?: boolean;
  error?: string;
}

interface ReactProfilerReadResult {
  installed: boolean;
  totalCommits?: number;
  top?: Array<{ name: string; totalMs: number; renders: number }>;
  commits?: Array<{
    at: number;
    components: Array<{ name: string; depth: number; actualDuration: number }>;
  }>;
}

export async function profileReactStart(
  opts: OutputOptions,
  sessionName: string,
  cdpOpts: { port?: number; targetIndex?: number }
): Promise<number> {
  try {
    const platform = await detectPlatform(sessionName).catch(() => undefined);
    const client = new MetroCdpClient();
    await client.connect({
      port: cdpOpts.port ?? 8081,
      deviceId: sessionName !== 'default' ? sessionName : undefined,
      platform,
      targetIndex: cdpOpts.targetIndex,
    });
    const result = await client.evaluate<ReactProfilerStartResult>(REACT_PROFILER_INSTALL);
    client.close();
    if (!result.installed) {
      printError(`profile react start — ${result.error ?? 'install failed'}`, opts);
      return 1;
    }
    if (opts.json) printData(result, opts);
    else
      printSuccess(
        `profile react start — ${result.already ? 'already installed' : 'installed'}`,
        opts
      );
    return 0;
  } catch (err) {
    printError(`profile react start — ${err instanceof Error ? err.message : String(err)}`, opts);
    return 1;
  }
}

export async function profileReactStop(
  opts: OutputOptions,
  sessionName: string,
  cdpOpts: { port?: number; targetIndex?: number },
  top: number
): Promise<number> {
  try {
    const platform = await detectPlatform(sessionName).catch(() => undefined);
    const client = new MetroCdpClient();
    await client.connect({
      port: cdpOpts.port ?? 8081,
      deviceId: sessionName !== 'default' ? sessionName : undefined,
      platform,
      targetIndex: cdpOpts.targetIndex,
    });
    const read = await client.evaluate<ReactProfilerReadResult>(REACT_PROFILER_READ(top));
    await client.evaluate(REACT_PROFILER_STOP);
    client.close();
    if (!read.installed) {
      printError('profile react stop — profiler was not installed', opts);
      return 1;
    }
    if (opts.json) printData(read, opts);
    else {
      console.log(`profile react — ${read.totalCommits ?? 0} commit(s)`);
      for (const t of read.top ?? []) {
        console.log(`  ${t.totalMs.toFixed(1)}ms  ${t.renders}x  ${t.name}`);
      }
    }
    return 0;
  } catch (err) {
    printError(`profile react stop — ${err instanceof Error ? err.message : String(err)}`, opts);
    return 1;
  }
}
