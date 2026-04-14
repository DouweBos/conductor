/**
 * Android log source — streams logs from an Android device/emulator via `adb logcat`.
 */
import { spawn, ChildProcess, execSync } from 'child_process';
import { LogSource, LogEntry } from './types.js';

function mapPriority(priority: number | string): LogEntry['level'] {
  // Android log priorities: 2=V, 3=D, 4=I, 5=W, 6=E, 7=F
  const p = typeof priority === 'string' ? priority.toUpperCase() : String(priority);
  switch (p) {
    case '2':
    case 'V':
      return 'verbose';
    case '3':
    case 'D':
      return 'debug';
    case '4':
    case 'I':
      return 'info';
    case '5':
    case 'W':
      return 'warning';
    case '6':
    case 'E':
    case '7':
    case 'F':
      return 'error';
    default:
      return 'log';
  }
}

export class AndroidLogSource implements LogSource {
  private proc: ChildProcess | null = null;
  private callback: ((entry: LogEntry) => void) | null = null;
  private buffer = '';
  private useJson = true;

  constructor(
    private readonly deviceId: string,
    private readonly appId?: string
  ) {}

  async connect(): Promise<void> {
    // Try to find the app's PID for filtering
    let pid: string | undefined;
    if (this.appId) {
      try {
        pid = execSync(`adb -s ${this.deviceId} shell pidof ${this.appId}`, {
          encoding: 'utf-8',
          timeout: 5000,
        }).trim();
      } catch {
        // App may not be running yet — proceed without PID filter
      }
    }

    // Clear existing logcat buffer so we start fresh
    try {
      execSync(`adb -s ${this.deviceId} logcat -c`, { timeout: 5000 });
    } catch {
      // Ignore clear failures
    }

    // Try JSON format first (available on API 26+)
    const args = ['-s', this.deviceId, 'logcat'];
    if (this.useJson) {
      args.push('-v', 'json');
    } else {
      args.push('-v', 'threadtime');
    }
    if (pid) {
      args.push('--pid', pid);
    }

    this.proc = spawn('adb', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderrChunks = '';
    this.proc.stderr!.on('data', (chunk: Buffer) => {
      stderrChunks += chunk.toString('utf-8');
    });

    this.proc.stdout!.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf-8');
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        if (this.useJson) {
          this.parseJsonLine(line);
        } else {
          this.parseThreadtimeLine(line);
        }
      }
    });

    this.proc.on('error', () => {
      // adb not available
    });

    // If JSON format isn't supported, the process will exit quickly with an error.
    // Fall back to threadtime format.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 1000);
      this.proc!.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0 && code !== null && this.useJson) {
          // JSON format not supported — retry with threadtime
          this.useJson = false;
          this.connect().then(resolve, reject);
          return;
        }
        if (code !== 0 && code !== null) {
          reject(
            new Error(
              `adb logcat exited with code ${code}. ${stderrChunks.trim() || 'Is the device connected?'}`
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

  private parseJsonLine(line: string): void {
    try {
      const data = JSON.parse(line) as {
        message: string;
        priority: number;
        tag: string;
        timestamp: string;
        pid: number;
        tid: number;
      };

      const entry: LogEntry = {
        timestamp: data.timestamp || new Date().toISOString(),
        level: mapPriority(data.priority),
        message: data.tag ? `[${data.tag}] ${data.message}` : data.message,
        stackTrace: null,
        source: 'device',
      };
      this.callback?.(entry);
    } catch {
      // Non-JSON line — skip
    }
  }

  /** Parse threadtime format: `MM-DD HH:MM:SS.mmm  PID  TID LEVEL TAG: message` */
  private parseThreadtimeLine(line: string): void {
    const match = line.match(
      /^(\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+)\s+\d+\s+\d+\s+([VDIWEF])\s+(.+?):\s+(.*)$/
    );
    if (!match) return;

    const [, ts, level, tag, message] = match;
    const entry: LogEntry = {
      timestamp: ts,
      level: mapPriority(level),
      message: `[${tag}] ${message}`,
      stackTrace: null,
      source: 'device',
    };
    this.callback?.(entry);
  }
}
