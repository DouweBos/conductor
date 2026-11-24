/**
 * iOS log source — streams logs from an iOS simulator via `xcrun simctl spawn ... log stream`.
 * With `host` set it streams the Mac's own unified log instead, for macOS apps.
 * Physical devices go through libimobiledevice's `idevicesyslog` (IOSDeviceLogSource).
 */
import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { LogSource, LogEntry } from './types.js';

function mapMessageType(messageType: string): LogEntry['level'] {
  switch (messageType.toLowerCase()) {
    case 'fault':
      return 'error';
    case 'error':
      return 'error';
    case 'default':
      return 'log';
    case 'info':
      return 'info';
    case 'debug':
      return 'debug';
    default:
      return 'log';
  }
}

export class IOSLogSource implements LogSource {
  private proc: ChildProcess | null = null;
  private callback: ((entry: LogEntry) => void) | null = null;
  private buffer = '';

  constructor(
    private readonly deviceId: string,
    private readonly appId?: string,
    private readonly host = false
  ) {}

  async connect(): Promise<void> {
    const streamArgs = ['log', 'stream', '--style', 'ndjson', '--level', 'debug'];
    const args = this.host
      ? streamArgs.slice(1)
      : ['simctl', 'spawn', this.deviceId, ...streamArgs];

    if (this.host && this.appId) {
      // A Mac app's executable name rarely matches its bundle ID, but its own
      // os_log subsystem conventionally does.
      const name = this.appId.split('.').pop();
      args.push('--predicate', `subsystem BEGINSWITH "${this.appId}" OR process == "${name}"`);
    } else if (this.appId) {
      // Filter to just this app's process. The process name is typically the
      // last component of the bundle ID (e.g. "MyApp" from "com.example.MyApp"),
      // but simctl log stream matches on the full process image path, so use
      // a CONTAINS predicate for robustness.
      args.push('--predicate', `process CONTAINS "${this.appId.split('.').pop()}"`);
    }

    this.proc = spawn(this.host ? 'log' : 'xcrun', args, { stdio: ['ignore', 'pipe', 'ignore'] });

    this.proc.stdout!.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf-8');
      const lines = this.buffer.split('\n');
      // Keep the last (potentially incomplete) line in the buffer
      this.buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        this.parseLine(line);
      }
    });

    this.proc.on('error', () => {
      // xcrun not available or similar — ignore, the command will have errored on startup
    });

    // Give simctl a moment to start streaming — if it exits immediately,
    // it likely means the device ID is invalid.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 500);
      this.proc!.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0 && code !== null) {
          reject(new Error(`simctl log stream exited with code ${code}. Is the simulator booted?`));
        }
      });
    });
  }

  onEntry(callback: (entry: LogEntry) => void): void {
    this.callback = callback;
  }

  disconnect(): void {
    if (this.proc) {
      this.proc.kill('SIGTERM');
      this.proc = null;
    }
  }

  private parseLine(line: string): void {
    try {
      const data = JSON.parse(line) as {
        timestamp: string;
        messageType: string;
        eventMessage: string;
        processImagePath?: string;
        subsystem?: string;
        category?: string;
        senderImagePath?: string;
      };

      if (!data.eventMessage) return;

      const entry: LogEntry = {
        timestamp: data.timestamp || new Date().toISOString(),
        level: mapMessageType(data.messageType ?? 'Default'),
        message: data.eventMessage,
        stackTrace: null,
        source: 'device',
      };
      this.callback?.(entry);
    } catch {
      // Non-JSON lines (e.g. simctl header) — skip
    }
  }
}

// ── Physical devices ─────────────────────────────────────────────────────────

const IDEVICESYSLOG_HINT =
  'idevicesyslog not found; install it with `brew install libimobiledevice`';

/** Absolute path to idevicesyslog, or null. Homebrew dirs are checked since daemons may run with a bare PATH. */
export function findIdevicesyslog(): string | null {
  const dirs = [
    ...(process.env.PATH ?? '').split(path.delimiter),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, 'idevicesyslog');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* not here */
    }
  }
  return null;
}

// "Nov 24 10:00:00.123456 Douwes-iPhone MyApp(UIKitCore)[1234] <Notice>: message"
const SYSLOG_RE =
  /^(?<ts>[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s+\S+\s+(?<proc>[^[(\s]+)(?:\((?<lib>[^)]*)\))?\[(?<pid>\d+)\]\s+<(?<level>\w+)>:\s?(?<msg>.*)$/;

function mapSyslogLevel(level: string): LogEntry['level'] {
  switch (level.toLowerCase()) {
    case 'fault':
    case 'error':
    case 'critical':
      return 'error';
    case 'warning':
      return 'warning';
    case 'info':
      return 'info';
    case 'debug':
      return 'debug';
    default:
      return 'log';
  }
}

export interface SyslogLine {
  timestamp: string;
  process: string;
  pid: number;
  level: LogEntry['level'];
  message: string;
}

/** Parse one idevicesyslog line; null for continuation lines. `now` supplies the year syslog omits. */
export function parseSyslogLine(raw: string, now = new Date()): SyslogLine | null {
  const line = raw.replace(/\x1b\[[0-9;]*m/g, '');
  const g = SYSLOG_RE.exec(line)?.groups;
  if (!g) return null;
  const [mon, day, time] = g.ts.split(/\s+/);
  const [hms, frac = '0'] = time.split('.');
  let d = new Date(`${mon} ${day} ${now.getFullYear()} ${hms}`);
  // A December line read in January belongs to last year.
  if (d.getTime() - now.getTime() > 24 * 3600_000)
    d = new Date(`${mon} ${day} ${now.getFullYear() - 1} ${hms}`);
  if (!isNaN(d.getTime())) d.setMilliseconds(Number(frac.slice(0, 3).padEnd(3, '0')));
  return {
    timestamp: isNaN(d.getTime()) ? now.toISOString() : d.toISOString(),
    process: g.proc,
    pid: Number(g.pid),
    level: mapSyslogLevel(g.level),
    message: g.msg,
  };
}

/** Streams a physical iPhone/Apple TV's syslog via libimobiledevice's `idevicesyslog`. */
export class IOSDeviceLogSource implements LogSource {
  private proc: ChildProcess | null = null;
  private callback: ((entry: LogEntry) => void) | null = null;
  private buffer = '';
  /** Whether the last header line passed the process filter, for its continuation lines. */
  private lastKept = false;

  constructor(
    private readonly udid: string,
    private readonly appId?: string
  ) {}

  async connect(): Promise<void> {
    const bin = findIdevicesyslog();
    if (!bin) throw new Error(IDEVICESYSLOG_HINT);
    const procName = this.appId?.split('.').pop()?.toLowerCase();

    this.proc = spawn(bin, ['-u', this.udid], { stdio: ['ignore', 'pipe', 'ignore'] });
    this.proc.stdout!.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf-8');
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const parsed = parseSyslogLine(line);
        if (!parsed) {
          if (this.lastKept) {
            this.callback?.({
              timestamp: new Date().toISOString(),
              level: 'log',
              message: line,
              stackTrace: null,
              source: 'device',
            });
          }
          continue;
        }
        this.lastKept = !procName || parsed.process.toLowerCase().includes(procName);
        if (!this.lastKept) continue;
        this.callback?.({
          timestamp: parsed.timestamp,
          level: parsed.level,
          message: parsed.message,
          stackTrace: null,
          source: 'device',
        });
      }
    });
    this.proc.on('error', () => {});

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 500);
      this.proc!.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0 && code !== null) {
          reject(
            new Error(
              `idevicesyslog exited with code ${code}. Is the device connected and trusted?`
            )
          );
        }
      });
    });
  }

  onEntry(callback: (entry: LogEntry) => void): void {
    this.callback = callback;
  }

  disconnect(): void {
    if (this.proc) {
      this.proc.kill('SIGTERM');
      this.proc = null;
    }
  }
}
