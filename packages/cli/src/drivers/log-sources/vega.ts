/**
 * Vega (Amazon Fire TV) device log source — streams logs via
 * `vega device start-log-stream` and parses each line into a LogEntry.
 */
import { ChildProcess } from 'child_process';
import { VegaCli } from '../vega/cli.js';
import { LogSource, LogEntry } from './types.js';

/** Map a Vega/Android-style level token to a LogEntry level. */
function mapLevel(token: string): LogEntry['level'] {
  switch (token.toUpperCase()) {
    case 'V':
    case 'VERBOSE':
      return 'verbose';
    case 'D':
    case 'DEBUG':
      return 'debug';
    case 'I':
    case 'INFO':
      return 'info';
    case 'W':
    case 'WARN':
    case 'WARNING':
      return 'warning';
    case 'E':
    case 'ERROR':
    case 'F':
    case 'FATAL':
      return 'error';
    default:
      return 'log';
  }
}

export class VegaLogSource implements LogSource {
  private proc: ChildProcess | null = null;
  private callback: ((entry: LogEntry) => void) | null = null;
  private buffer = '';

  constructor(private readonly serial: string) {}

  async connect(): Promise<void> {
    this.proc = new VegaCli(this.serial).startLogStream();

    const onData = (chunk: Buffer): void => {
      this.buffer += chunk.toString('utf-8');
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) this.emit(line);
      }
    };
    this.proc.stdout?.on('data', onData);
    this.proc.stderr?.on('data', onData);
    this.proc.on('error', () => {
      /* vega CLI not available — no logs */
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

  private emit(line: string): void {
    // Best-effort level extraction from a leading/embedded level token; the raw
    // line is always preserved as the message.
    const levelMatch = /\b([VDIWEF]|VERBOSE|DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL)\b/.exec(line);
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: levelMatch ? mapLevel(levelMatch[1]) : 'log',
      message: line,
      stackTrace: null,
      source: 'device',
    };
    this.callback?.(entry);
  }
}
