export const HELP = `  memory [<appId>]                    Show device + app memory usage and object counts`;

import { spawnCommand, detectFirstDevice, getDriver } from '../runner.js';
import { getSession } from '../session.js';
import { getInstalledAppIds } from './foreground-app.js';
import { printError, printData, OutputOptions } from '../output.js';
import { detectPlatform } from '../drivers/bootstrap.js';
import { IOSDriver } from '../drivers/ios.js';
import { AndroidDriver } from '../drivers/android.js';
import { WebDriver } from '../drivers/web.js';

export interface MemoryOptions {
  /** Skip the foreground-app lookup and don't report per-app memory. */
  systemOnly?: boolean;
}

export interface MemorySection {
  /** Bytes (preferred unit). KB-only sources are converted on parse. */
  [key: string]: number | string | undefined;
}

export interface MemoryReport {
  platform: 'ios' | 'tvos' | 'android' | 'web';
  deviceId: string;
  appId?: string;
  pid?: number;
  /** Whole-device memory totals (bytes). */
  system?: {
    totalBytes?: number;
    availableBytes?: number;
    freeBytes?: number;
    usedBytes?: number;
    cachedBytes?: number;
    swapTotalBytes?: number;
    swapFreeBytes?: number;
  };
  /** Per-app memory breakdown (bytes). */
  app?: {
    totalPssBytes?: number;
    totalRssBytes?: number;
    totalUssBytes?: number;
    vszBytes?: number;
    javaHeapBytes?: number;
    nativeHeapBytes?: number;
    codeBytes?: number;
    stackBytes?: number;
    graphicsBytes?: number;
    privateOtherBytes?: number;
    systemBytes?: number;
    /** Detailed iOS vmmap region totals, e.g. { "MALLOC": 12345, ... }. */
    regions?: Record<string, number>;
  };
  /** Object counts (Android dumpsys: Views, Activities, etc.). */
  objects?: Record<string, number>;
  /** Free-form notes (e.g. "vmmap unavailable"). */
  notes?: string[];
}

async function resolveDeviceId(sessionName: string): Promise<string | undefined> {
  if (sessionName !== 'default') return sessionName;
  const session = await getSession(sessionName);
  return session.deviceId ?? (await detectFirstDevice());
}

async function resolveAppId(
  explicit: string | undefined,
  sessionName: string,
  deviceId: string
): Promise<string | undefined> {
  if (explicit) return explicit;
  // No arg: always resolve from the live foreground app, not the session file.
  // The session's appId reflects the last `launch-app` call, which can be stale
  // if the user switched apps on the device by other means.
  try {
    const driver = await getDriver(sessionName);
    if (driver instanceof AndroidDriver) return await driver.getForegroundApp();
    if (driver instanceof WebDriver) return await driver.runningApp();
    if (driver instanceof IOSDriver) {
      const appIds = await getInstalledAppIds(deviceId);
      return await driver.runningApp(appIds);
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

// ── Android ───────────────────────────────────────────────────────────────────

function parseAndroidMeminfo(out: string): {
  totalBytes?: number;
  availableBytes?: number;
  freeBytes?: number;
  cachedBytes?: number;
  swapTotalBytes?: number;
  swapFreeBytes?: number;
} {
  const get = (key: string): number | undefined => {
    const m = out.match(new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm'));
    return m ? Number(m[1]) * 1024 : undefined;
  };
  return {
    totalBytes: get('MemTotal'),
    availableBytes: get('MemAvailable'),
    freeBytes: get('MemFree'),
    cachedBytes: get('Cached'),
    swapTotalBytes: get('SwapTotal'),
    swapFreeBytes: get('SwapFree'),
  };
}

function parseAndroidDumpsysMeminfo(out: string): {
  app: NonNullable<MemoryReport['app']>;
  objects: Record<string, number>;
  pid?: number;
} {
  const app: NonNullable<MemoryReport['app']> = {};
  const objects: Record<string, number> = {};

  const pidMatch = out.match(/\*\* MEMINFO in pid (\d+)/);
  const pid = pidMatch ? Number(pidMatch[1]) : undefined;

  // App Summary block — most useful, single-line entries with KB values.
  // e.g. "       Java Heap:    12345"
  const summary = out.match(/App Summary[\s\S]*?(?:\n\s*\n|TOTAL:)/);
  if (summary) {
    const block = summary[0];
    const grab = (label: string): number | undefined => {
      const m = block.match(new RegExp(`${label}:\\s+(\\d+)`));
      return m ? Number(m[1]) * 1024 : undefined;
    };
    app.javaHeapBytes = grab('Java Heap');
    app.nativeHeapBytes = grab('Native Heap');
    app.codeBytes = grab('Code');
    app.stackBytes = grab('Stack');
    app.graphicsBytes = grab('Graphics');
    app.privateOtherBytes = grab('Private Other');
    app.systemBytes = grab('System');
    const totalPss = block.match(/TOTAL PSS:\s+(\d+)/);
    if (totalPss) app.totalPssBytes = Number(totalPss[1]) * 1024;
    const totalRss = block.match(/TOTAL RSS:\s+(\d+)/);
    if (totalRss) app.totalRssBytes = Number(totalRss[1]) * 1024;
    const totalSwap = block.match(/TOTAL SWAP[^:]*:\s+(\d+)/);
    if (totalSwap) (app as MemorySection)['totalSwapBytes'] = Number(totalSwap[1]) * 1024;
  }

  // Fallback: TOTAL line in the main table — "TOTAL  12345  ..."
  if (app.totalPssBytes === undefined) {
    const total = out.match(/^\s*TOTAL\s+(\d+)/m);
    if (total) app.totalPssBytes = Number(total[1]) * 1024;
  }

  // Objects block:
  //  Objects
  //         Views:        3   ViewRootImpl:        1
  //     AppContexts:        2     Activities:        1
  //          Assets:        7  AssetManagers:        0
  //   Local Binders:        5  Proxy Binders:       17
  //   Parcel memory:        1     Parcel count:        4
  //    Death Recipients:    0   OpenSSL Sockets:    0
  //            WebViews:    0
  const objSection = out.match(/Objects[\s\S]*?(?:\n\s*\n|SQL\s|DATABASES|$)/);
  if (objSection) {
    const text = objSection[0];
    // Capture every "Label: number" pair (labels may have spaces).
    const re = /([A-Za-z][A-Za-z _]*?):\s+(\d+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const key = m[1].trim();
      if (key === 'Objects') continue;
      objects[key] = Number(m[2]);
    }
  }

  return { app, objects, pid };
}

async function collectAndroid(deviceId: string, appId?: string): Promise<MemoryReport> {
  const report: MemoryReport = { platform: 'android', deviceId, appId, notes: [] };

  const meminfo = await spawnCommand('adb', ['-s', deviceId, 'shell', 'cat', '/proc/meminfo']);
  if (meminfo.success) {
    const sys = parseAndroidMeminfo(meminfo.stdout);
    report.system = {
      ...sys,
      usedBytes:
        sys.totalBytes !== undefined && sys.availableBytes !== undefined
          ? sys.totalBytes - sys.availableBytes
          : undefined,
    };
  } else {
    report.notes!.push(`/proc/meminfo unavailable: ${meminfo.stderr.trim()}`);
  }

  if (appId) {
    const dump = await spawnCommand('adb', ['-s', deviceId, 'shell', 'dumpsys', 'meminfo', appId]);
    if (dump.success && !dump.stdout.includes('No process found')) {
      const { app, objects, pid } = parseAndroidDumpsysMeminfo(dump.stdout);
      report.app = app;
      report.objects = objects;
      report.pid = pid;
    } else {
      report.notes!.push(`dumpsys meminfo ${appId} returned no data — app may not be running`);
    }
  }

  if (report.notes!.length === 0) delete report.notes;
  return report;
}

// ── iOS / tvOS ────────────────────────────────────────────────────────────────

function parseVmStat(out: string): {
  totalBytes?: number;
  freeBytes?: number;
  availableBytes?: number;
} {
  // vm_stat output uses "page size of 16384 bytes" and counts in pages.
  const pageMatch = out.match(/page size of (\d+)/);
  const pageSize = pageMatch ? Number(pageMatch[1]) : 4096;
  const grab = (label: string): number | undefined => {
    const m = out.match(new RegExp(`${label}:\\s+(\\d+)`));
    return m ? Number(m[1]) * pageSize : undefined;
  };
  const free = grab('Pages free');
  const inactive = grab('Pages inactive');
  const speculative = grab('Pages speculative');
  const wired = grab('Pages wired down');
  const active = grab('Pages active');
  const compressed = grab('Pages occupied by compressor');
  const total = [free, inactive, speculative, wired, active, compressed]
    .filter((v): v is number => v !== undefined)
    .reduce((a, b) => a + b, 0);
  const available =
    free !== undefined && inactive !== undefined && speculative !== undefined
      ? free + inactive + speculative
      : undefined;
  return {
    totalBytes: total > 0 ? total : undefined,
    freeBytes: free,
    availableBytes: available,
  };
}

async function findIOSPid(deviceId: string, appId: string): Promise<number | undefined> {
  // Inside-simulator PIDs == host PIDs for app processes.
  const list = await spawnCommand('xcrun', ['simctl', 'spawn', deviceId, 'launchctl', 'list']);
  if (!list.success) return undefined;
  for (const line of list.stdout.split('\n')) {
    if (!line.includes(appId)) continue;
    const parts = line.trim().split(/\s+/);
    const pid = Number(parts[0]);
    if (Number.isFinite(pid) && pid > 0) return pid;
  }
  return undefined;
}

function parseVmmapSummary(out: string): {
  app: NonNullable<MemoryReport['app']>;
  regions: Record<string, number>;
} {
  const regions: Record<string, number> = {};
  const app: NonNullable<MemoryReport['app']> = {};

  // Lines look like: "MALLOC                          1.2G       234.5M  ..."
  // We want the "RESIDENT" column (2nd numeric). The columns are whitespace-delimited.
  // Easier: parse the per-region rows under "REGION TYPE" header.
  const headerIdx = out.indexOf('REGION TYPE');
  if (headerIdx === -1) return { app, regions };
  const body = out.slice(headerIdx);
  const lines = body.split('\n').slice(1);
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    if (line.startsWith('=')) break;
    if (line.startsWith('TOTAL')) {
      // "TOTAL                          5.2G       1.4G       950M  ..."
      const m = line.match(/TOTAL\s+\S+\s+(\S+)/);
      if (m) app.totalRssBytes = humanToBytes(m[1]);
      break;
    }
    // Region rows: name (may have spaces), virtual, resident, dirty, swap, ...
    const m = line.match(/^(.+?)\s{2,}(\S+)\s+(\S+)/);
    if (!m) continue;
    const name = m[1].trim();
    const resident = humanToBytes(m[3]);
    if (resident !== undefined) regions[name] = resident;
  }

  // Roll up a few well-known regions into the canonical fields.
  app.nativeHeapBytes = regions['MALLOC'] ?? regions['MALLOC_NANO'];
  app.stackBytes = regions['Stack'];
  return { app, regions };
}

function humanToBytes(s: string): number | undefined {
  // Matches "1.2G", "234.5M", "950K", "1024", "1.2GB" etc.
  const m = s.match(/^([\d.]+)\s*([KMGT]?)B?$/i);
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  if (Number.isNaN(n)) return undefined;
  const mult: Record<string, number> = {
    '': 1,
    K: 1024,
    M: 1024 ** 2,
    G: 1024 ** 3,
    T: 1024 ** 4,
  };
  return Math.round(n * (mult[m[2].toUpperCase()] ?? 1));
}

async function collectIOS(
  deviceId: string,
  platform: 'ios' | 'tvos',
  appId?: string
): Promise<MemoryReport> {
  const report: MemoryReport = { platform, deviceId, appId, notes: [] };

  // System-wide memory: vm_stat from inside the simulator (== host RAM).
  const vm = await spawnCommand('xcrun', ['simctl', 'spawn', deviceId, 'vm_stat']);
  if (vm.success) {
    const sys = parseVmStat(vm.stdout);
    report.system = {
      ...sys,
      usedBytes:
        sys.totalBytes !== undefined && sys.availableBytes !== undefined
          ? sys.totalBytes - sys.availableBytes
          : undefined,
    };
    report.notes!.push(
      'System memory reflects host Mac RAM — simulators share the host memory pool.'
    );
  } else {
    report.notes!.push(`vm_stat unavailable: ${vm.stderr.trim()}`);
  }

  if (!appId) {
    if (report.notes!.length === 0) delete report.notes;
    return report;
  }

  const pid = await findIOSPid(deviceId, appId);
  if (!pid) {
    report.notes!.push(`No running process found for ${appId}.`);
    if (report.notes!.length === 0) delete report.notes;
    return report;
  }
  report.pid = pid;

  // ps for RSS/VSZ — fast, always available.
  const ps = await spawnCommand('ps', ['-o', 'rss=,vsz=', '-p', String(pid)]);
  if (ps.success) {
    const m = ps.stdout.trim().match(/(\d+)\s+(\d+)/);
    if (m) {
      report.app = {
        ...(report.app ?? {}),
        // ps reports rss/vsz in KB on macOS.
        totalRssBytes: Number(m[1]) * 1024,
        vszBytes: Number(m[2]) * 1024,
      };
    }
  }

  // vmmap -summary for region breakdown — slower but provides categories.
  const vmmap = await spawnCommand('vmmap', ['-summary', String(pid)]);
  if (vmmap.success) {
    const { app, regions } = parseVmmapSummary(vmmap.stdout);
    report.app = {
      ...(report.app ?? {}),
      ...Object.fromEntries(Object.entries(app).filter(([, v]) => v !== undefined)),
      regions,
    };
  } else {
    report.notes!.push('vmmap unavailable — run `sudo DevToolsSecurity --enable` if it errors.');
  }

  if (report.notes!.length === 0) delete report.notes;
  return report;
}

// ── Web (Playwright via CDP) ──────────────────────────────────────────────────

async function collectWeb(deviceId: string, sessionName: string): Promise<MemoryReport> {
  const report: MemoryReport = { platform: 'web', deviceId, notes: [] };
  let driver: WebDriver;
  try {
    const d = await getDriver(sessionName);
    if (!(d instanceof WebDriver)) {
      report.notes!.push('Expected web driver, got something else.');
      return report;
    }
    driver = d;
  } catch (err) {
    report.notes!.push(
      `Could not attach to web driver: ${err instanceof Error ? err.message : String(err)}`
    );
    return report;
  }

  const data = await driver.memory().catch((err: Error) => {
    report.notes!.push(`Performance.getMetrics failed: ${err.message}`);
    return null;
  });
  if (!data) {
    if (report.notes!.length === 0) delete report.notes;
    return report;
  }

  report.appId = data.url;
  const m = data.metrics;
  const pm = data.pageMemory;

  report.app = {
    // Heap totals — prefer page-context performance.memory (Chromium) over
    // CDP's JSHeapUsedSize (which can lag). Both are JS heap only.
    nativeHeapBytes: pm?.usedJSHeapSize ?? m['JSHeapUsedSize'],
    codeBytes: m['JSHeapTotalSize'] ? m['JSHeapTotalSize'] - (m['JSHeapUsedSize'] ?? 0) : undefined,
    // Roll the raw CDP metrics into `regions` so they're inspectable verbatim.
    regions: { ...m },
  };
  if (pm) {
    report.app.regions = {
      ...report.app.regions,
      'JS Heap Used': pm.usedJSHeapSize,
      'JS Heap Total': pm.totalJSHeapSize,
      'JS Heap Limit': pm.jsHeapSizeLimit,
    };
  }

  // Object counts — direct CDP equivalents of Android's "Views/Activities/Binders".
  const objectKeys = [
    'Nodes',
    'Documents',
    'Frames',
    'JSEventListeners',
    'LayoutCount',
    'RecalcStyleCount',
  ];
  const objects: Record<string, number> = {};
  for (const k of objectKeys) {
    if (m[k] !== undefined) objects[k] = m[k];
  }
  if (Object.keys(objects).length > 0) report.objects = objects;

  report.notes!.push(
    'Web memory is per-page (Performance.getMetrics + performance.memory). Run-wide RSS for the browser process is not exposed via CDP.'
  );
  if (report.notes!.length === 0) delete report.notes;
  return report;
}

// ── Formatting ────────────────────────────────────────────────────────────────

function fmtBytes(n: number | undefined): string {
  if (n === undefined) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

function formatReport(r: MemoryReport): string {
  const lines: string[] = [];
  lines.push(`Device:    ${r.deviceId} (${r.platform})`);
  if (r.appId) lines.push(`App:       ${r.appId}${r.pid ? ` (pid ${r.pid})` : ''}`);

  if (r.system) {
    lines.push('');
    lines.push('System memory:');
    const s = r.system;
    if (s.totalBytes !== undefined) lines.push(`  Total:      ${fmtBytes(s.totalBytes)}`);
    if (s.usedBytes !== undefined) lines.push(`  Used:       ${fmtBytes(s.usedBytes)}`);
    if (s.availableBytes !== undefined) lines.push(`  Available:  ${fmtBytes(s.availableBytes)}`);
    if (s.freeBytes !== undefined) lines.push(`  Free:       ${fmtBytes(s.freeBytes)}`);
    if (s.cachedBytes !== undefined) lines.push(`  Cached:     ${fmtBytes(s.cachedBytes)}`);
    if (s.swapTotalBytes !== undefined)
      lines.push(
        `  Swap:       ${fmtBytes((s.swapTotalBytes ?? 0) - (s.swapFreeBytes ?? 0))} / ${fmtBytes(s.swapTotalBytes)}`
      );
  }

  if (r.app) {
    lines.push('');
    lines.push('App memory:');
    const a = r.app;
    if (a.totalPssBytes !== undefined) lines.push(`  PSS total:  ${fmtBytes(a.totalPssBytes)}`);
    if (a.totalRssBytes !== undefined) lines.push(`  RSS total:  ${fmtBytes(a.totalRssBytes)}`);
    if (a.totalUssBytes !== undefined) lines.push(`  USS total:  ${fmtBytes(a.totalUssBytes)}`);
    if (a.vszBytes !== undefined) lines.push(`  VSZ:        ${fmtBytes(a.vszBytes)}`);
    if (a.javaHeapBytes !== undefined) lines.push(`  Java heap:  ${fmtBytes(a.javaHeapBytes)}`);
    if (a.nativeHeapBytes !== undefined) lines.push(`  Native:     ${fmtBytes(a.nativeHeapBytes)}`);
    if (a.codeBytes !== undefined) lines.push(`  Code:       ${fmtBytes(a.codeBytes)}`);
    if (a.stackBytes !== undefined) lines.push(`  Stack:      ${fmtBytes(a.stackBytes)}`);
    if (a.graphicsBytes !== undefined) lines.push(`  Graphics:   ${fmtBytes(a.graphicsBytes)}`);
    if (a.privateOtherBytes !== undefined)
      lines.push(`  Private:    ${fmtBytes(a.privateOtherBytes)}`);
    if (a.systemBytes !== undefined) lines.push(`  System:     ${fmtBytes(a.systemBytes)}`);

    if (a.regions && Object.keys(a.regions).length > 0) {
      lines.push('');
      lines.push('Top memory regions (resident):');
      const entries = Object.entries(a.regions)
        .filter(([, v]) => v > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12);
      for (const [name, bytes] of entries) {
        lines.push(`  ${name.padEnd(28)} ${fmtBytes(bytes)}`);
      }
    }
  }

  if (r.objects && Object.keys(r.objects).length > 0) {
    lines.push('');
    lines.push('Object counts:');
    const entries = Object.entries(r.objects).sort((a, b) => b[1] - a[1]);
    for (const [name, count] of entries) {
      lines.push(`  ${name.padEnd(20)} ${count}`);
    }
  }

  if (r.notes && r.notes.length > 0) {
    lines.push('');
    for (const n of r.notes) lines.push(`note: ${n}`);
  }

  return lines.join('\n');
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function memory(
  appIdArg: string | undefined,
  opts: OutputOptions = {},
  sessionName = 'default',
  _memOpts: MemoryOptions = {}
): Promise<number> {
  const deviceId = await resolveDeviceId(sessionName);
  if (!deviceId) {
    printError('No device found. Connect a device or start a simulator first.', opts);
    return 1;
  }

  const platform = await detectPlatform(deviceId);

  let report: MemoryReport;
  if (platform === 'web') {
    report = await collectWeb(deviceId, sessionName);
  } else {
    const appId = await resolveAppId(appIdArg, sessionName, deviceId);
    if (platform === 'android') {
      report = await collectAndroid(deviceId, appId);
    } else {
      report = await collectIOS(deviceId, platform, appId);
    }
  }

  if (opts.json) {
    printData({ status: 'ok', ...report }, opts);
  } else {
    console.log(formatReport(report));
  }
  return 0;
}
