export const HELP = `  crashes list [--app <bundleId>] [--since <duration>]
                                       List recent crash reports (iOS host + Android logcat)
  crashes show <id>                    Print a specific crash report
  crashes tail                         Stream new crash reports as they appear`;

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { printError, printData, OutputOptions } from '../output.js';
import { detectPlatform } from '../drivers/bootstrap.js';
import { resolveAndroidTool, androidSpawnEnv } from '../android/sdk.js';

interface CrashReport {
  id: string;
  timestamp: string;
  app: string | null;
  type: 'crash' | 'fault' | 'tombstone' | 'logcat';
  signal: string | null;
  threadName: string | null;
  topFrames: string[];
  sourceFile: string | null;
  platform: 'ios' | 'android';
}

const IOS_REPORTS_DIR = path.join(os.homedir(), 'Library', 'Logs', 'DiagnosticReports');

function parseSince(s: string | undefined): number {
  if (!s) return 0;
  const m = s.match(/^(\d+)(s|m|h|d)?$/);
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = m[2] ?? 's';
  const mult = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit] ?? 1000;
  return n * mult;
}

function listIosReports(opts: { app?: string; sinceMs: number }): CrashReport[] {
  if (!fs.existsSync(IOS_REPORTS_DIR)) return [];
  const now = Date.now();
  const entries = fs.readdirSync(IOS_REPORTS_DIR);
  const out: CrashReport[] = [];
  for (const file of entries) {
    if (!file.endsWith('.ips') && !file.endsWith('.crash')) continue;
    const full = path.join(IOS_REPORTS_DIR, file);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (opts.sinceMs > 0 && now - stat.mtimeMs > opts.sinceMs) continue;
    const text = (() => {
      try {
        return fs.readFileSync(full, 'utf-8');
      } catch {
        return '';
      }
    })();
    const report = parseIpsReport(file, full, text, stat.mtimeMs);
    if (opts.app && report.app && !report.app.includes(opts.app)) continue;
    out.push(report);
  }
  return out.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

function parseIpsReport(
  id: string,
  full: string,
  text: string,
  mtimeMs: number
): CrashReport {
  // Newer .ips files are JSON-LD style: first line is summary JSON, then body JSON.
  // Older .crash files are plain text. Be defensive.
  let app: string | null = null;
  let signal: string | null = null;
  let threadName: string | null = null;
  const topFrames: string[] = [];
  let type: CrashReport['type'] = 'crash';

  try {
    const firstNewline = text.indexOf('\n');
    if (firstNewline > 0) {
      const summary = JSON.parse(text.slice(0, firstNewline)) as {
        app_name?: string;
        bundleID?: string;
        incident_id?: string;
        timestamp?: string;
      };
      app = summary.bundleID ?? summary.app_name ?? null;
    }
  } catch {
    // ignore — fall back to text parsing
  }

  const procMatch = text.match(/Process:\s+(\S+)/);
  if (!app && procMatch) app = procMatch[1];
  const sigMatch = text.match(/Exception Type:\s+(\S+)/);
  if (sigMatch) signal = sigMatch[1];
  const threadMatch = text.match(/Thread \d+ (Crashed|name):\s*([^\n]+)/);
  if (threadMatch) threadName = threadMatch[2].trim();
  const faultMatch = text.includes('fault');
  if (faultMatch) type = 'fault';

  const frameLines = text.split('\n');
  for (const line of frameLines) {
    if (/^\s*\d+\s+\S+\s+0x[0-9a-f]+/i.test(line)) {
      topFrames.push(line.trim());
      if (topFrames.length >= 10) break;
    }
  }

  return {
    id,
    timestamp: new Date(mtimeMs).toISOString(),
    app,
    type,
    signal,
    threadName,
    topFrames,
    sourceFile: full,
    platform: 'ios',
  };
}

async function listAndroidReports(
  deviceId: string,
  opts: { app?: string; sinceMs: number }
): Promise<CrashReport[]> {
  const adb = resolveAndroidTool('adb');
  const env = androidSpawnEnv();
  const sinceArg = opts.sinceMs > 0 ? ['-T', String(Math.floor((Date.now() - opts.sinceMs) / 1000))] : [];
  const output: string = await new Promise((resolve) => {
    const proc = spawn(adb, ['-s', deviceId, 'logcat', '-d', '-b', 'crash', ...sinceArg], {
      stdio: ['ignore', 'pipe', 'ignore'],
      env,
    });
    let buf = '';
    proc.stdout.on('data', (c: Buffer) => {
      buf += c.toString();
    });
    proc.on('close', () => resolve(buf));
    proc.on('error', () => resolve(''));
  });

  const reports: CrashReport[] = [];
  const blocks = output.split(/\n(?=\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (!/FATAL EXCEPTION|AndroidRuntime|tombstone/i.test(block)) continue;
    const appMatch = block.match(/Process: ([\w.]+)/);
    const app = appMatch ? appMatch[1] : null;
    if (opts.app && app && !app.includes(opts.app)) continue;
    const tsMatch = block.match(/^(\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+)/);
    const sigMatch = block.match(/Signal\s+\d+\s+\(([^)]+)\)/);
    const topFrames: string[] = [];
    for (const line of block.split('\n')) {
      if (/^\s+at\s/.test(line)) {
        topFrames.push(line.trim());
        if (topFrames.length >= 10) break;
      }
    }
    reports.push({
      id: `android-${i}-${tsMatch?.[1] ?? Date.now()}`,
      timestamp: tsMatch ? new Date().getFullYear() + '-' + tsMatch[1].replace(' ', 'T') : new Date().toISOString(),
      app,
      type: 'logcat',
      signal: sigMatch ? sigMatch[1] : null,
      threadName: null,
      topFrames,
      sourceFile: null,
      platform: 'android',
    });
  }
  return reports;
}

export interface CrashesListOptions {
  app?: string;
  since?: string;
}

export async function crashesList(
  opts: OutputOptions,
  sessionName: string,
  listOpts: CrashesListOptions
): Promise<number> {
  const sinceMs = parseSince(listOpts.since);
  const platform = sessionName !== 'default' ? await detectPlatform(sessionName).catch(() => null) : null;

  const reports: CrashReport[] = [];
  // Always include iOS host-side reports — they aren't device-scoped.
  reports.push(...listIosReports({ app: listOpts.app, sinceMs }));
  if (platform === 'android' && sessionName !== 'default') {
    reports.push(...(await listAndroidReports(sessionName, { app: listOpts.app, sinceMs })));
  }

  if (opts.json) {
    printData({ count: reports.length, reports }, opts);
  } else {
    if (reports.length === 0) console.log('No crash reports found.');
    for (const r of reports) {
      console.log(
        `${r.timestamp}  ${r.platform}  ${r.type}  ${r.app ?? '?'}  ${r.signal ?? '-'}  ${r.id}`
      );
    }
  }
  return 0;
}

export async function crashesShow(
  id: string,
  opts: OutputOptions
): Promise<number> {
  if (!id) {
    printError('crashes show requires an <id>', opts);
    return 1;
  }
  // For iOS, id is the file name in DiagnosticReports.
  const ios = path.join(IOS_REPORTS_DIR, id);
  if (fs.existsSync(ios)) {
    const text = fs.readFileSync(ios, 'utf-8');
    if (opts.json) printData({ id, source: ios, body: text }, opts);
    else console.log(text);
    return 0;
  }
  printError(`crashes show — no report found for "${id}"`, opts);
  return 1;
}

export async function crashesTail(opts: OutputOptions, sessionName: string): Promise<number> {
  console.log('Watching for new crash reports… (Ctrl+C to stop)');
  // iOS host directory watcher
  let lastSeen = Date.now();
  if (fs.existsSync(IOS_REPORTS_DIR)) {
    fs.watch(IOS_REPORTS_DIR, (event, file) => {
      if (!file) return;
      const full = path.join(IOS_REPORTS_DIR, file as string);
      try {
        const stat = fs.statSync(full);
        if (stat.mtimeMs <= lastSeen) return;
        lastSeen = stat.mtimeMs;
        const text = fs.readFileSync(full, 'utf-8');
        const report = parseIpsReport(file as string, full, text, stat.mtimeMs);
        if (opts.json) printData(report, opts);
        else
          console.log(
            `${report.timestamp}  ios  ${report.type}  ${report.app ?? '?'}  ${report.signal ?? '-'}  ${report.id}`
          );
      } catch {
        // ignore
      }
    });
  }

  // Android: spawn `adb logcat -b crash` streaming
  if (sessionName !== 'default') {
    const platform = await detectPlatform(sessionName).catch(() => null);
    if (platform === 'android') {
      const adb = resolveAndroidTool('adb');
      const proc = spawn(adb, ['-s', sessionName, 'logcat', '-b', 'crash'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        env: androidSpawnEnv(),
      });
      let buf = '';
      proc.stdout.on('data', (chunk: Buffer) => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (/FATAL EXCEPTION|AndroidRuntime|tombstone/.test(line)) {
            if (opts.json) printData({ platform: 'android', line }, opts);
            else console.log(`android  ${line}`);
          }
        }
      });
    }
  }

  // Keep alive
  await new Promise(() => {});
  return 0;
}
