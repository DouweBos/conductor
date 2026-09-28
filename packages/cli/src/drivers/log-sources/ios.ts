/**
 * iOS log source — streams logs from an iOS simulator via `xcrun simctl spawn ... log stream`.
 * With `host` set it streams the Mac's own unified log instead, for macOS apps.
 */
import { spawn, ChildProcess } from 'child_process';
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
