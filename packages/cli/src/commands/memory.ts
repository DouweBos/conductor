export const HELP = `  memory [<appId>]                    Show device + app memory usage
    --objects                           Include per-class object counts (iOS: heap; slower)
    --leaks                             Run leak detection (iOS only; slow, can pause the app)
    --all                               Shorthand for --objects --leaks
    --top <n>                           Limit object/region tables (default 20)
    --save <name>                       Save the report as a snapshot
    --diff <name>                       Diff snapshot <name> vs current
    --diff <name> --vs <other>          Diff two saved snapshots
    --snapshots                         List saved snapshots
    --no-gc                             Skip the pre-measurement GC (web only)
    --filter <regex>                    Filter object/class tables by name (regex)
    --growth-only                       In diff output, only show positive deltas (leak-hunting)
    --json                              Emit JSON instead of formatted text`;

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnCommand, detectFirstDevice, getDriver } from '../runner.js';
import { resolveAndroidTool, androidSpawnEnv } from '../android/sdk.js';
import { getSession } from '../session.js';
import { getInstalledAppIds } from './foreground-app.js';
import { printError, printData, OutputOptions } from '../output.js';
import { detectPlatform } from '../drivers/bootstrap.js';
import { IOSDriver } from '../drivers/ios.js';
import { AndroidDriver } from '../drivers/android.js';
import { WebDriver } from '../drivers/web.js';
import { parseHprof } from './hprof.js';

export interface MemoryOptions {
  /** Skip the foreground-app lookup and don't report per-app memory. */
  systemOnly?: boolean;
  /** Run iOS `heap` for per-class object counts/bytes. */
  objects?: boolean;
  /** Run iOS `leaks` for leak detection. */
  leaks?: boolean;
  /** Limit object/region tables to top N entries (default 20). */
  top?: number;
  /** Save the report under this name. */
  save?: string;
  /** Diff this saved snapshot against current (or against `diffOther`). */
  diff?: string;
  /** Optional second snapshot for `diff`. */
  diffOther?: string;
  /** List saved snapshots and exit. */
  listSnapshots?: boolean;
  /**
   * Force GC before measuring (web only — Android's `am dumpheap` triggers a
   * GC implicitly, iOS has no public API). Defaults to true when --objects
   * is set so class counts aren't polluted by transient allocations.
   */
  gc?: boolean;
  /** Regex filter applied to object/class table rows (anywhere we list classes). */
  filter?: string;
  /** In diff output, only show positive deltas (newly allocated / grown). */
  growthOnly?: boolean;
}

export interface MemorySection {
  /** Bytes (preferred unit). KB-only sources are converted on parse. */
  [key: string]: number | string | undefined;
}

export interface ObjectClass {
  class: string;
  count: number;
  bytes: number;
  binary?: string;
  type?: string;
}

export interface LeakEntry {
  class: string;
  count: number;
  bytes: number;
}

export interface MemoryReport {
  platform: 'ios' | 'tvos' | 'android' | 'web';
  deviceId: string;
  appId?: string;
  pid?: number;
  /** ISO timestamp the report was collected. */
  capturedAt?: string;
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
    /**
     * iOS phys footprint = dirty + compressed memory the kernel attributes to
     * this process. This is what `jetsam` uses to decide whether to kill the
     * app, so it's a more actionable number than RSS (which includes shared
     * text pages). Populated from `footprint <pid>`.
     */
    footprintBytes?: number;
    /** iOS dirty memory (subset of footprint) — sized for OOM analysis. */
    dirtyBytes?: number;
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
  /** Object counts (Android dumpsys, web CDP). */
  objects?: Record<string, number>;
  /** Per-class object stats (iOS `heap`). Sorted by bytes desc on collection. */
  objectClasses?: ObjectClass[];
  /** Total bytes/count across all classes (from iOS `heap` summary). */
  heapTotals?: { count: number; bytes: number };
  /** Detected leaks (iOS `leaks`). */
  leaks?: {
    totalCount: number;
    totalBytes: number;
    classes: LeakEntry[];
  };
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

  if (app.totalPssBytes === undefined) {
    const total = out.match(/^\s*TOTAL\s+(\d+)/m);
    if (total) app.totalPssBytes = Number(total[1]) * 1024;
  }

  const objSection = out.match(/Objects[\s\S]*?(?:\n\s*\n|SQL\s|DATABASES|$)/);
  if (objSection) {
    const text = objSection[0];
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

function parseAndroidUnreachable(out: string): {
  totalCount: number;
  totalBytes: number;
  classes: LeakEntry[];
} {
  // dumpsys meminfo --unreachable <pid> output:
  //   Unreachable memory:
  //     1234 bytes in 5 unreachable allocations
  //     ABI: 'arm64'
  //
  //     192 bytes unreachable at 12abcdef
  //      first 32 bytes of contents:
  //      ...
  //      #00 pc 000... /system/lib64/libc.so (malloc+24)
  //      #01 pc 000... /data/app/.../lib/libfoo.so (foo_init+32)
  const summary = out.match(/(\d+)\s+bytes?\s+in\s+(\d+)\s+unreachable\s+allocations?/i);
  const totalBytes = summary ? Number(summary[1]) : 0;
  const totalCount = summary ? Number(summary[2]) : 0;

  // Aggregate by the most-specific (last user) library frame in each backtrace.
  // System libs (libc, liblog, libart) are usually the immediate allocator —
  // the user library a frame or two up tells us what's actually leaking.
  const byClass = new Map<string, { count: number; bytes: number }>();
  const blocks = out.split(/(?=^\s*\d+\s+bytes?\s+unreachable\s+at)/m);
  for (const block of blocks) {
    const head = block.match(/^\s*(\d+)\s+bytes?\s+unreachable\s+at/m);
    if (!head) continue;
    const size = Number(head[1]);
    // Find first non-libc/-liblog/-libart frame in the backtrace.
    const frames = [...block.matchAll(/#\d+\s+pc\s+\S+\s+(\/\S+?\.so)\s+\(([^)+]+)/g)];
    let owner = '<unknown>';
    for (const f of frames) {
      const lib = f[1];
      const sym = f[2];
      if (/lib(c|m|art|log|dl|cutils)\.so$/.test(lib)) continue;
      owner = `${sym}  [${lib.split('/').pop()}]`;
      break;
    }
    if (owner === '<unknown>' && frames[0]) {
      owner = `${frames[0][2]}  [${frames[0][1].split('/').pop()}]`;
    }
    const prev = byClass.get(owner) ?? { count: 0, bytes: 0 };
    prev.count += 1;
    prev.bytes += size;
    byClass.set(owner, prev);
  }
  const classes: LeakEntry[] = [...byClass.entries()]
    .map(([cls, v]) => ({ class: cls, count: v.count, bytes: v.bytes }))
    .sort((a, b) => b.bytes - a.bytes);
  return { totalCount, totalBytes, classes };
}

async function collectAndroid(
  deviceId: string,
  appId: string | undefined,
  opts: MemoryOptions
): Promise<MemoryReport> {
  const report: MemoryReport = { platform: 'android', deviceId, appId, notes: [] };

  const meminfo = await spawnCommand(
    resolveAndroidTool('adb'),
    ['-s', deviceId, 'shell', 'cat', '/proc/meminfo'],
    { env: androidSpawnEnv() }
  );
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
    const dump = await spawnCommand(
      resolveAndroidTool('adb'),
      ['-s', deviceId, 'shell', 'dumpsys', 'meminfo', appId],
      { env: androidSpawnEnv() }
    );
    if (dump.success && !dump.stdout.includes('No process found')) {
      const { app, objects, pid } = parseAndroidDumpsysMeminfo(dump.stdout);
      report.app = app;
      report.objects = objects;
      report.pid = pid;
    } else {
      report.notes!.push(`dumpsys meminfo ${appId} returned no data — app may not be running`);
    }

    // --leaks → dumpsys meminfo --unreachable <pid>. Requires root on stock
    // images; on user builds it returns "Unreachable memory check not supported".
    if (opts.leaks && report.pid) {
      const unreach = await spawnCommand('adb', [
        '-s',
        deviceId,
        'shell',
        'dumpsys',
        'meminfo',
        '--unreachable',
        String(report.pid),
      ]);
      if (unreach.success && unreach.stdout.includes('Unreachable memory:')) {
        report.leaks = parseAndroidUnreachable(unreach.stdout);
      } else if (unreach.stdout.includes('not supported')) {
        report.notes!.push(
          'dumpsys --unreachable not supported on this build (needs userdebug/root).'
        );
      } else {
        report.notes!.push(`--unreachable unavailable: ${unreach.stderr.trim() || 'no output'}`);
      }
    }

    // --objects → trigger `am dumpheap` and pull the .hprof. We don't parse
    // HPROF binary; the file is meant to be opened in Android Studio's Memory
    // Profiler. The path is recorded so it shows up in the report notes.
    if (opts.objects && report.pid) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const remote = `/data/local/tmp/conductor-${appId}-${ts}.hprof`;
      const dumpRes = await spawnCommand('adb', [
        '-s',
        deviceId,
        'shell',
        'am',
        'dumpheap',
        String(report.pid),
        remote,
      ]);
      if (dumpRes.success) {
        await new Promise((r) => setTimeout(r, 1500)); // dumpheap is async; wait for flush
        const localDir = path.join(os.homedir(), '.conductor', 'heap-dumps');
        await fs.mkdir(localDir, { recursive: true });
        const localFile = path.join(localDir, path.basename(remote));
        const pull = await spawnCommand('adb', ['-s', deviceId, 'pull', remote, localFile]);
        if (pull.success) {
          await spawnCommand('adb', ['-s', deviceId, 'shell', 'rm', remote]);
          // Parse the HPROF binary for per-class instance counts/bytes — same
          // shape as iOS `heap` and Web V8 snapshot output, so it slots into
          // the existing snapshot/diff workflow.
          try {
            const buf = await fs.readFile(localFile);
            const { classes, totals, heaps } = parseHprof(buf);
            if (classes.length > 0) report.objectClasses = classes;
            report.heapTotals = totals;
            const heapsNote = heaps
              ? '  ' +
                Object.entries(heaps)
                  .map(
                    ([h, v]) =>
                      `${h}: ${v.count.toLocaleString()} obj / ${(v.bytes / 1048576).toFixed(1)} MB`
                  )
                  .join(', ')
              : '';
            report.notes!.push(
              `Heap dump saved → ${localFile}${heapsNote}  (also openable in Android Studio: Profiler → Memory → Import Heap Dump)`
            );
          } catch (err) {
            report.notes!.push(
              `Heap dump saved → ${localFile} but parse failed: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        } else {
          report.notes!.push(`adb pull heap dump failed: ${pull.stderr.trim()}`);
        }
      } else {
        report.notes!.push(`am dumpheap failed: ${dumpRes.stderr.trim()}`);
      }
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

function parseFootprint(out: string): { footprintBytes?: number; dirtyBytes?: number } {
  // Header: "Plex [15843]: 64-bit    Footprint: 801 MB (16384 bytes per page)"
  // Values can be "B", "KB", "MB", "GB" with a space between number and unit.
  const numUnit = '([\\d.]+\\s*[KMGT]?B)';
  const header = out.match(new RegExp(`Footprint:\\s+${numUnit}`));
  const footprintBytes = header ? humanToBytes(header[1].replace(/\s+/g, '')) : undefined;
  // TOTAL line: " 801 MB    70 MB    4960 KB    5577    TOTAL"
  // Columns: Dirty | Clean | Reclaimable | Regions | "TOTAL"
  const total = out.match(
    new RegExp(`^\\s*${numUnit}\\s+${numUnit}\\s+${numUnit}\\s+\\d+\\s+TOTAL\\s*$`, 'm')
  );
  const dirtyBytes = total ? humanToBytes(total[1].replace(/\s+/g, '')) : undefined;
  return { footprintBytes, dirtyBytes };
}

function parseVmmapSummary(out: string): {
  app: NonNullable<MemoryReport['app']>;
  regions: Record<string, number>;
} {
  const regions: Record<string, number> = {};
  const app: NonNullable<MemoryReport['app']> = {};

  // Find the per-region body. Layout:
  //                                 VIRTUAL RESIDENT  DIRTY ...
  //   REGION TYPE                      SIZE     SIZE   SIZE ...
  //   ===========                   ======= ========  ===== ...
  //   Accelerate framework             128K     128K   128K ...
  //   ...
  //   TOTAL                           5.2G     1.4G   950M ...
  const headerIdx = out.indexOf('REGION TYPE');
  if (headerIdx === -1) return { app, regions };
  const lines = out.slice(headerIdx).split('\n');
  // Skip the REGION TYPE header line and the ====== separator that follows.
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('=')) continue; // separator row
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

  app.nativeHeapBytes = regions['MALLOC'] ?? regions['MALLOC_NANO'];
  app.stackBytes = regions['Stack'];
  return { app, regions };
}

function humanToBytes(s: string): number | undefined {
  // Matches "1.2G", "234.5M", "950K", "1024", "1.2GB", "0K" etc.
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

// ── iOS heap (per-class object counts) ────────────────────────────────────────

function parseHeap(out: string): {
  classes: ObjectClass[];
  totals?: { count: number; bytes: number };
} {
  const classes: ObjectClass[] = [];
  let totals: { count: number; bytes: number } | undefined;

  // Locate the "All zones: N nodes (B bytes)" totals line.
  const totalsMatch = out.match(/All zones:\s+(\d+)\s+nodes\s+\((\d+)\s+bytes\)/);
  if (totalsMatch) {
    totals = { count: Number(totalsMatch[1]), bytes: Number(totalsMatch[2]) };
  }

  // Find the table header row. Heap prints:
  //    COUNT      BYTES       AVG   CLASS_NAME ...    TYPE    BINARY
  //    =====      =====       ===   ========== ...    ====    ======
  //   549284  450043193     819.3   non-object
  //   33305    1813840      54.5    CFString          ObjC    CoreFoundation
  const headerIdx = out.search(/^\s*COUNT\s+BYTES\s+AVG\s+CLASS_NAME/m);
  if (headerIdx === -1) return { classes, totals };

  const body = out.slice(headerIdx).split('\n').slice(2); // skip header + ===
  for (const raw of body) {
    const line = raw.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) break; // blank line ends the table
    if (trimmed.startsWith('=')) continue;
    // Match: leading count, bytes, avg, then the rest. CLASS_NAME / TYPE / BINARY
    // are space-separated but the class name itself can contain spaces and angle
    // brackets, so split off the trailing TYPE+BINARY columns from the right.
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/);
    if (!m) continue;
    const count = Number(m[1]);
    const bytes = Number(m[2]);
    const rest = m[4];

    // Trailing two whitespace-separated tokens are TYPE and BINARY (BINARY may
    // be missing for "non-object" entries). Detect by looking at the last 1-2
    // tokens; if the last token looks like a known TYPE, BINARY is absent.
    const KNOWN_TYPES = new Set(['ObjC', 'Swift', 'C', 'C++', 'CFType']);
    let className = rest;
    let type: string | undefined;
    let binary: string | undefined;
    // Try: "<class>   TYPE   BINARY"
    const trail2 = rest.match(/^(.*?)\s{2,}(\S+)\s+(\S+)\s*$/);
    if (trail2 && KNOWN_TYPES.has(trail2[2])) {
      className = trail2[1].trim();
      type = trail2[2];
      binary = trail2[3];
    } else {
      // Try: "<class>   TYPE" (no binary)
      const trail1 = rest.match(/^(.*?)\s{2,}(\S+)\s*$/);
      if (trail1 && KNOWN_TYPES.has(trail1[2])) {
        className = trail1[1].trim();
        type = trail1[2];
      } else {
        className = rest.trim();
      }
    }
    if (!className) continue;
    classes.push({ class: className, count, bytes, type, binary });
  }

  classes.sort((a, b) => b.bytes - a.bytes);
  return { classes, totals };
}

// ── iOS leaks ─────────────────────────────────────────────────────────────────

function parseLeaks(out: string): MemoryReport['leaks'] {
  // `leaks` prints e.g.:
  //   Process 12345: 42 leaks for 16384 total leaked bytes.
  // Followed by per-leak detail lines:
  //   Leak: 0x12345  size=128  zone: ...  Class: NSConcreteData
  // We aggregate by class.
  const summary = out.match(/(\d+)\s+leaks?\s+for\s+(\d+)\s+total\s+leaked\s+bytes/i);
  const totalCount = summary ? Number(summary[1]) : 0;
  const totalBytes = summary ? Number(summary[2]) : 0;

  const byClass = new Map<string, { count: number; bytes: number }>();
  const re = /Leak:\s*0x[0-9a-f]+\s+size=(\d+)[^\n]*?(?:\s(?:Class|Type):\s*(\S+))?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(out)) !== null) {
    const size = Number(m[1]);
    const cls = m[2] ?? '<unknown>';
    const prev = byClass.get(cls) ?? { count: 0, bytes: 0 };
    prev.count += 1;
    prev.bytes += size;
    byClass.set(cls, prev);
  }
  const classes: LeakEntry[] = [...byClass.entries()]
    .map(([cls, v]) => ({ class: cls, count: v.count, bytes: v.bytes }))
    .sort((a, b) => b.bytes - a.bytes);

  return { totalCount, totalBytes, classes };
}

async function collectIOS(
  deviceId: string,
  platform: 'ios' | 'tvos',
  appId: string | undefined,
  opts: MemoryOptions
): Promise<MemoryReport> {
  const report: MemoryReport = { platform, deviceId, appId, notes: [] };

  // System-wide memory: vm_stat from the host. Simulators share host RAM, and
  // `vm_stat` is a host macOS binary — it isn't present inside the simulator
  // runtime, so `xcrun simctl spawn <id> vm_stat` fails with ENOENT.
  const vm = await spawnCommand('vm_stat', []);
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

  // footprint — phys footprint + dirty memory totals. This is the actionable
  // OOM number on iOS (jetsam compares this against the per-app limit), so
  // surface it before vmmap region detail.
  const fp = await spawnCommand('footprint', [String(pid)]);
  if (fp.success) {
    const { footprintBytes, dirtyBytes } = parseFootprint(fp.stdout);
    report.app = {
      ...(report.app ?? {}),
      ...(footprintBytes !== undefined ? { footprintBytes } : {}),
      ...(dirtyBytes !== undefined ? { dirtyBytes } : {}),
    };
  }

  // vmmap -summary for region breakdown.
  const vmmap = await spawnCommand('vmmap', ['-summary', String(pid)]);
  if (vmmap.success) {
    const { app, regions } = parseVmmapSummary(vmmap.stdout);
    report.app = {
      ...(report.app ?? {}),
      ...Object.fromEntries(Object.entries(app).filter(([, v]) => v !== undefined)),
      regions,
    };
  } else {
    report.notes!.push(`vmmap unavailable: ${vmmap.stderr.trim() || 'unknown error'}`);
  }

  // heap for per-class object counts/bytes.
  if (opts.objects) {
    const h = await spawnCommand('heap', [String(pid)]);
    if (h.success) {
      const { classes, totals } = parseHeap(h.stdout);
      if (classes.length > 0) report.objectClasses = classes;
      if (totals) report.heapTotals = totals;
    } else {
      report.notes!.push(`heap unavailable: ${h.stderr.trim() || 'unknown error'}`);
    }
  }

  // leaks for leak detection.
  if (opts.leaks) {
    const l = await spawnCommand('leaks', [String(pid)]);
    // `leaks` exits non-zero when leaks are found; treat any output as success.
    if (l.stdout && l.stdout.includes('leaks for')) {
      report.leaks = parseLeaks(l.stdout);
    } else if (l.success) {
      report.leaks = { totalCount: 0, totalBytes: 0, classes: [] };
    } else {
      report.notes!.push(`leaks unavailable: ${l.stderr.trim() || 'unknown error'}`);
    }
  }

  if (report.notes!.length === 0) delete report.notes;
  return report;
}

// ── Web (Playwright via CDP) ──────────────────────────────────────────────────

interface V8HeapSnapshot {
  snapshot: {
    meta: {
      node_fields: string[];
      node_types: [string[], ...unknown[]];
    };
    node_count?: number;
    edge_count?: number;
  };
  nodes: number[];
  strings: string[];
}

function parseV8HeapSnapshot(snap: V8HeapSnapshot): {
  classes: ObjectClass[];
  totals: { count: number; bytes: number };
} {
  const meta = snap.snapshot.meta;
  const nf = meta.node_fields;
  const stride = nf.length;
  const typeIdx = nf.indexOf('type');
  const nameIdx = nf.indexOf('name');
  const sizeIdx = nf.indexOf('self_size');
  const typeNames = meta.node_types[0]; // e.g. ["hidden","array","string","object","code","closure","regexp","number","native","synthetic","concatenated string","sliced string","symbol","bigint"]
  const nodes = snap.nodes;
  const strings = snap.strings;

  // For "object", "closure", "native" → name is the constructor / function /
  // C++ class name. For other types, group under "<type>".
  const namedTypes = new Set(['object', 'closure', 'native']);
  const namedTypeIds = new Set<number>();
  typeNames.forEach((t, i) => {
    if (namedTypes.has(t)) namedTypeIds.add(i);
  });

  const byClass = new Map<string, { count: number; bytes: number }>();
  let totalCount = 0;
  let totalBytes = 0;

  for (let i = 0; i < nodes.length; i += stride) {
    const t = nodes[i + typeIdx];
    const size = nodes[i + sizeIdx];
    const nameId = nodes[i + nameIdx];
    totalCount++;
    totalBytes += size;

    let label: string;
    if (namedTypeIds.has(t)) {
      const tName = typeNames[t];
      const ctor = strings[nameId] || '<anonymous>';
      label = tName === 'object' ? ctor : `${ctor}  [${tName}]`;
    } else {
      label = `<${typeNames[t] ?? 'unknown'}>`;
    }
    const prev = byClass.get(label);
    if (prev) {
      prev.count++;
      prev.bytes += size;
    } else {
      byClass.set(label, { count: 1, bytes: size });
    }
  }

  const classes: ObjectClass[] = [...byClass.entries()]
    .map(([cls, v]) => ({ class: cls, count: v.count, bytes: v.bytes }))
    .sort((a, b) => b.bytes - a.bytes);
  return { classes, totals: { count: totalCount, bytes: totalBytes } };
}

async function collectWeb(
  deviceId: string,
  sessionName: string,
  opts: MemoryOptions
): Promise<MemoryReport> {
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
    nativeHeapBytes: pm?.usedJSHeapSize ?? m['JSHeapUsedSize'],
    codeBytes: m['JSHeapTotalSize'] ? m['JSHeapTotalSize'] - (m['JSHeapUsedSize'] ?? 0) : undefined,
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

  // --objects → take a real V8 heap snapshot, parse class counts/bytes, and
  // save the .heapsnapshot file so it can be opened in Chrome DevTools.
  if (opts.objects) {
    try {
      const snapText = await driver.heapSnapshot({ gc: opts.gc !== false });
      const snap = JSON.parse(snapText) as V8HeapSnapshot;
      const { classes, totals } = parseV8HeapSnapshot(snap);
      if (classes.length > 0) report.objectClasses = classes;
      report.heapTotals = totals;
      const dumpsDir = path.join(os.homedir(), '.conductor', 'heap-dumps');
      await fs.mkdir(dumpsDir, { recursive: true });
      const safeUrl = (data.url || 'page').replace(/[^\w.-]+/g, '_').slice(0, 60);
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const file = path.join(dumpsDir, `${safeUrl}-${ts}.heapsnapshot`);
      await fs.writeFile(file, snapText);
      report.notes!.push(
        `Heap snapshot saved → ${file}  (open in Chrome DevTools: Memory → Load profile)`
      );
    } catch (err) {
      report.notes!.push(
        `Heap snapshot failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  report.notes!.push(
    'Web memory is per-page (Performance.getMetrics + performance.memory). Run-wide RSS for the browser process is not exposed via CDP.'
  );
  if (report.notes!.length === 0) delete report.notes;
  return report;
}

// ── Snapshot save / load / diff ───────────────────────────────────────────────

function snapshotsDir(): string {
  return path.join(os.homedir(), '.conductor', 'memory-snapshots');
}

function snapshotPath(name: string): string {
  // Allow callers to pass either a bare name or a filename / path.
  if (name.endsWith('.json') || name.includes('/')) return name;
  return path.join(snapshotsDir(), `${name}.json`);
}

async function saveSnapshot(name: string, report: MemoryReport): Promise<string> {
  const dir = snapshotsDir();
  await fs.mkdir(dir, { recursive: true });
  const file = snapshotPath(name);
  await fs.writeFile(file, JSON.stringify(report, null, 2));
  return file;
}

async function loadSnapshot(name: string): Promise<MemoryReport> {
  const file = snapshotPath(name);
  const raw = await fs.readFile(file, 'utf8');
  return JSON.parse(raw) as MemoryReport;
}

async function listSnapshots(): Promise<
  Array<{ name: string; capturedAt?: string; appId?: string; platform?: string; size: number }>
> {
  const dir = snapshotsDir();
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: Array<{
    name: string;
    capturedAt?: string;
    appId?: string;
    platform?: string;
    size: number;
  }> = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const file = path.join(dir, f);
    try {
      const stat = await fs.stat(file);
      const r = JSON.parse(await fs.readFile(file, 'utf8')) as MemoryReport;
      out.push({
        name: f.replace(/\.json$/, ''),
        capturedAt: r.capturedAt,
        appId: r.appId,
        platform: r.platform,
        size: stat.size,
      });
    } catch {
      /* skip malformed */
    }
  }
  out.sort((a, b) => (a.capturedAt ?? '').localeCompare(b.capturedAt ?? ''));
  return out;
}

interface DiffEntry {
  key: string;
  before: number;
  after: number;
  delta: number;
}

function diffNumberMap(
  a: Record<string, number> | undefined,
  b: Record<string, number> | undefined
): DiffEntry[] {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  const out: DiffEntry[] = [];
  for (const k of keys) {
    const before = a?.[k] ?? 0;
    const after = b?.[k] ?? 0;
    if (before === after) continue;
    out.push({ key: k, before, after, delta: after - before });
  }
  out.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
  return out;
}

interface ClassDiff {
  class: string;
  beforeCount: number;
  afterCount: number;
  beforeBytes: number;
  afterBytes: number;
  deltaCount: number;
  deltaBytes: number;
}

function diffClasses(a: ObjectClass[] | undefined, b: ObjectClass[] | undefined): ClassDiff[] {
  const idx = (arr: ObjectClass[] | undefined): Map<string, ObjectClass> => {
    const m = new Map<string, ObjectClass>();
    for (const c of arr ?? []) m.set(c.class, c);
    return m;
  };
  const A = idx(a);
  const B = idx(b);
  const keys = new Set([...A.keys(), ...B.keys()]);
  const out: ClassDiff[] = [];
  for (const k of keys) {
    const x = A.get(k);
    const y = B.get(k);
    const beforeCount = x?.count ?? 0;
    const afterCount = y?.count ?? 0;
    const beforeBytes = x?.bytes ?? 0;
    const afterBytes = y?.bytes ?? 0;
    if (beforeCount === afterCount && beforeBytes === afterBytes) continue;
    out.push({
      class: k,
      beforeCount,
      afterCount,
      beforeBytes,
      afterBytes,
      deltaCount: afterCount - beforeCount,
      deltaBytes: afterBytes - beforeBytes,
    });
  }
  out.sort((x, y) => Math.abs(y.deltaBytes) - Math.abs(x.deltaBytes));
  return out;
}

interface MemoryDiff {
  before: { name: string; capturedAt?: string };
  after: { name: string; capturedAt?: string };
  app: DiffEntry[];
  regions: DiffEntry[];
  objects: DiffEntry[];
  objectClasses: ClassDiff[];
  leaksDelta?: { count: number; bytes: number };
}

function buildDiff(a: MemoryReport, b: MemoryReport, aLabel: string, bLabel: string): MemoryDiff {
  const numericApp = (r: MemoryReport): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(r.app ?? {})) {
      if (typeof v === 'number') out[k] = v;
    }
    return out;
  };
  return {
    before: { name: aLabel, capturedAt: a.capturedAt },
    after: { name: bLabel, capturedAt: b.capturedAt },
    app: diffNumberMap(numericApp(a), numericApp(b)),
    regions: diffNumberMap(a.app?.regions, b.app?.regions),
    objects: diffNumberMap(a.objects, b.objects),
    objectClasses: diffClasses(a.objectClasses, b.objectClasses),
    leaksDelta:
      a.leaks || b.leaks
        ? {
            count: (b.leaks?.totalCount ?? 0) - (a.leaks?.totalCount ?? 0),
            bytes: (b.leaks?.totalBytes ?? 0) - (a.leaks?.totalBytes ?? 0),
          }
        : undefined,
  };
}

// ── Formatting ────────────────────────────────────────────────────────────────

function fmtBytes(n: number | undefined): string {
  if (n === undefined) return '—';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs < 1024) return `${sign}${abs} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = abs / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${sign}${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

function fmtSignedBytes(n: number): string {
  if (n === 0) return '±0';
  return (n > 0 ? '+' : '') + fmtBytes(n);
}

function fmtSignedInt(n: number): string {
  if (n === 0) return '±0';
  return (n > 0 ? '+' : '') + String(n);
}

function makeFilter(pattern: string | undefined): ((s: string) => boolean) | undefined {
  if (!pattern) return undefined;
  try {
    const re = new RegExp(pattern, 'i');
    return (s: string) => re.test(s);
  } catch {
    // Invalid regex → no filter (safer than throwing mid-render).
    return undefined;
  }
}

function filterClasses(arr: ObjectClass[], pattern: string | undefined): ObjectClass[] {
  const f = makeFilter(pattern);
  return f ? arr.filter((c) => f(c.class)) : arr;
}

function filterEntries<T extends { key: string; delta: number }>(
  arr: T[],
  pattern: string | undefined,
  growthOnly: boolean | undefined
): T[] {
  const f = makeFilter(pattern);
  return arr.filter((e) => {
    if (growthOnly && e.delta <= 0) return false;
    if (f && !f(e.key)) return false;
    return true;
  });
}

function filterClassDiffs(
  arr: ClassDiff[],
  pattern: string | undefined,
  growthOnly: boolean | undefined
): ClassDiff[] {
  const f = makeFilter(pattern);
  return arr.filter((c) => {
    if (growthOnly && c.deltaBytes <= 0) return false;
    if (f && !f(c.class)) return false;
    return true;
  });
}

function formatReport(r: MemoryReport, opts: MemoryOptions = {}): string {
  const top = opts.top ?? 20;
  const lines: string[] = [];
  lines.push(`Device:    ${r.deviceId} (${r.platform})`);
  if (r.appId) lines.push(`App:       ${r.appId}${r.pid ? ` (pid ${r.pid})` : ''}`);
  if (r.capturedAt) lines.push(`Captured:  ${r.capturedAt}`);

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
    if (a.footprintBytes !== undefined)
      lines.push(`  Footprint:  ${fmtBytes(a.footprintBytes)}    (jetsam target on iOS)`);
    if (a.dirtyBytes !== undefined) lines.push(`  Dirty:      ${fmtBytes(a.dirtyBytes)}`);
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
      lines.push(`Top memory regions (resident, top ${top}):`);
      const entries = Object.entries(a.regions)
        .filter(([, v]) => v > 0)
        .sort((x, y) => y[1] - x[1])
        .slice(0, top);
      for (const [name, bytes] of entries) {
        lines.push(`  ${name.padEnd(30)} ${fmtBytes(bytes)}`);
      }
    }
  }

  if (r.objectClasses && r.objectClasses.length > 0) {
    const filtered = filterClasses(r.objectClasses, opts.filter);
    lines.push('');
    if (r.heapTotals) {
      lines.push(
        `Heap objects (${r.heapTotals.count.toLocaleString()} nodes, ${fmtBytes(r.heapTotals.bytes)} total) — top ${top} by bytes${opts.filter ? ` (filter: /${opts.filter}/)` : ''}:`
      );
    } else {
      lines.push(
        `Heap objects (top ${top} by bytes${opts.filter ? ` (filter: /${opts.filter}/)` : ''}):`
      );
    }
    lines.push(`  ${'COUNT'.padStart(8)}  ${'BYTES'.padStart(10)}  CLASS`);
    for (const c of filtered.slice(0, top)) {
      const name = c.binary ? `${c.class}  [${c.binary}]` : c.class;
      lines.push(`  ${String(c.count).padStart(8)}  ${fmtBytes(c.bytes).padStart(10)}  ${name}`);
    }
  }

  if (r.objects && Object.keys(r.objects).length > 0) {
    lines.push('');
    lines.push('Object counts:');
    const entries = Object.entries(r.objects).sort((x, y) => y[1] - x[1]);
    for (const [name, count] of entries) {
      lines.push(`  ${name.padEnd(20)} ${count}`);
    }
  }

  if (r.leaks) {
    lines.push('');
    lines.push(
      `Leaks: ${r.leaks.totalCount} leak${r.leaks.totalCount === 1 ? '' : 's'} (${fmtBytes(r.leaks.totalBytes)})`
    );
    for (const l of r.leaks.classes.slice(0, top)) {
      lines.push(`  ${String(l.count).padStart(6)}  ${fmtBytes(l.bytes).padStart(10)}  ${l.class}`);
    }
  }

  if (r.notes && r.notes.length > 0) {
    lines.push('');
    for (const n of r.notes) lines.push(`note: ${n}`);
  }

  return lines.join('\n');
}

function formatDiff(d: MemoryDiff, opts: MemoryOptions = {}): string {
  const top = opts.top ?? 20;
  const lines: string[] = [];
  const tag: string[] = [];
  if (opts.growthOnly) tag.push('growth-only');
  if (opts.filter) tag.push(`filter: /${opts.filter}/`);
  const tagStr = tag.length > 0 ? `  [${tag.join(', ')}]` : '';
  lines.push(`Diff: ${d.before.name} → ${d.after.name}${tagStr}`);
  if (d.before.capturedAt || d.after.capturedAt) {
    lines.push(`      ${d.before.capturedAt ?? '?'} → ${d.after.capturedAt ?? '?'}`);
  }

  // App memory deltas — only filtered by growth-only (key is e.g. "totalRssBytes",
  // not user-meaningful for regex filtering).
  const appRows = opts.growthOnly ? d.app.filter((e) => e.delta > 0) : d.app;
  if (appRows.length > 0) {
    lines.push('');
    lines.push('App memory deltas:');
    for (const e of appRows.slice(0, top)) {
      lines.push(
        `  ${e.key.padEnd(20)} ${fmtBytes(e.before).padStart(10)} → ${fmtBytes(e.after).padStart(10)}  (${fmtSignedBytes(e.delta)})`
      );
    }
  }

  const regionRows = filterEntries(d.regions, opts.filter, opts.growthOnly);
  if (regionRows.length > 0) {
    lines.push('');
    lines.push(`Region deltas (top ${top} by |Δ|):`);
    for (const e of regionRows.slice(0, top)) {
      lines.push(
        `  ${e.key.padEnd(30)} ${fmtBytes(e.before).padStart(10)} → ${fmtBytes(e.after).padStart(10)}  (${fmtSignedBytes(e.delta)})`
      );
    }
  }

  const classRows = filterClassDiffs(d.objectClasses, opts.filter, opts.growthOnly);
  if (classRows.length > 0) {
    lines.push('');
    lines.push(`Class deltas (top ${top} by |Δ bytes|):`);
    lines.push(
      `  ${'Δ COUNT'.padStart(8)}  ${'Δ BYTES'.padStart(10)}  ${'AFTER COUNT'.padStart(11)}  ${'AFTER BYTES'.padStart(11)}  CLASS`
    );
    for (const c of classRows.slice(0, top)) {
      lines.push(
        `  ${fmtSignedInt(c.deltaCount).padStart(8)}  ${fmtSignedBytes(c.deltaBytes).padStart(10)}  ${String(c.afterCount).padStart(11)}  ${fmtBytes(c.afterBytes).padStart(11)}  ${c.class}`
      );
    }
  }

  const objRows = filterEntries(d.objects, opts.filter, opts.growthOnly);
  if (objRows.length > 0) {
    lines.push('');
    lines.push('Object count deltas:');
    for (const e of objRows.slice(0, top)) {
      lines.push(
        `  ${e.key.padEnd(20)} ${String(e.before).padStart(8)} → ${String(e.after).padStart(8)}  (${fmtSignedInt(e.delta)})`
      );
    }
  }

  if (d.leaksDelta && (d.leaksDelta.count !== 0 || d.leaksDelta.bytes !== 0)) {
    if (!opts.growthOnly || d.leaksDelta.bytes > 0) {
      lines.push('');
      lines.push(
        `Leaks delta: ${fmtSignedInt(d.leaksDelta.count)} leak(s), ${fmtSignedBytes(d.leaksDelta.bytes)}`
      );
    }
  }

  if (lines.length <= 2) lines.push('', 'No differences detected.');
  return lines.join('\n');
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function memory(
  appIdArg: string | undefined,
  opts: OutputOptions = {},
  sessionName = 'default',
  memOpts: MemoryOptions = {}
): Promise<number> {
  // List snapshots — no device required.
  if (memOpts.listSnapshots) {
    const list = await listSnapshots();
    if (opts.json) {
      printData({ status: 'ok', snapshots: list }, opts);
    } else if (list.length === 0) {
      console.log(`No snapshots saved. Try: conductor memory --save baseline`);
    } else {
      console.log(`Snapshots in ${snapshotsDir()}:`);
      for (const s of list) {
        console.log(
          `  ${s.name.padEnd(24)} ${(s.platform ?? '?').padEnd(8)} ${s.appId ?? ''}  ${s.capturedAt ?? ''}`
        );
      }
    }
    return 0;
  }

  // Diff between two saved snapshots.
  if (memOpts.diff && memOpts.diffOther) {
    const a = await loadSnapshot(memOpts.diff);
    const b = await loadSnapshot(memOpts.diffOther);
    const d = buildDiff(a, b, memOpts.diff, memOpts.diffOther);
    if (opts.json) printData({ status: 'ok', diff: d }, opts);
    else console.log(formatDiff(d, memOpts));
    return 0;
  }

  const deviceId = await resolveDeviceId(sessionName);
  if (!deviceId) {
    printError('No device found. Connect a device or start a simulator first.', opts);
    return 1;
  }

  const platform = await detectPlatform(deviceId);

  let report: MemoryReport;
  if (platform === 'web') {
    report = await collectWeb(deviceId, sessionName, memOpts);
  } else {
    const appId = await resolveAppId(appIdArg, sessionName, deviceId);
    if (platform === 'android') {
      report = await collectAndroid(deviceId, appId, memOpts);
    } else {
      report = await collectIOS(deviceId, platform, appId, memOpts);
    }
  }
  report.capturedAt = new Date().toISOString();

  // Diff current report against a saved snapshot.
  if (memOpts.diff) {
    const a = await loadSnapshot(memOpts.diff);
    const d = buildDiff(a, report, memOpts.diff, 'current');
    if (memOpts.save) await saveSnapshot(memOpts.save, report);
    if (opts.json) printData({ status: 'ok', diff: d, current: report }, opts);
    else console.log(formatDiff(d, memOpts));
    return 0;
  }

  if (memOpts.save) {
    const file = await saveSnapshot(memOpts.save, report);
    if (!opts.json) console.error(`Saved snapshot → ${file}`);
  }

  if (opts.json) {
    printData({ status: 'ok', ...report }, opts);
  } else {
    console.log(formatReport(report, memOpts));
  }
  return 0;
}
