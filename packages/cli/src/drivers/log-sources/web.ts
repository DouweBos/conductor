/**
 * Web log source — polls the Conductor daemon's web server for Playwright console events.
 */
import http from 'http';
import { LogSource, LogEntry } from './types.js';

export class WebLogSource implements LogSource {
  private callback: ((entry: LogEntry) => void) | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private since = new Date().toISOString();
  private stopped = false;

  constructor(
    private readonly port: number,
    private readonly host = '127.0.0.1'
  ) {}

  async connect(): Promise<void> {
    // Verify the web driver is reachable
    const alive = await this.checkAlive();
    if (!alive) {
      throw new Error(
        `Web driver on port ${this.port} is not responding. Is the web session running?`
      );
    }
    this.startPolling();
  }

  onEntry(callback: (entry: LogEntry) => void): void {
    this.callback = callback;
  }

  disconnect(): void {
    this.stopped = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private startPolling(): void {
    const poll = async (): Promise<void> => {
      if (this.stopped) return;
      try {
        const entries = await this.fetchLogs();
        for (const entry of entries) {
          this.callback?.(entry);
        }
        if (entries.length > 0) {
          this.since = entries[entries.length - 1].timestamp;
        }
      } catch {
        // Web driver may have restarted — keep polling
      }
      if (!this.stopped) {
        this.pollTimer = setTimeout(poll, 500);
      }
    };
    poll();
  }

  private fetchLogs(): Promise<LogEntry[]> {
    return new Promise((resolve, reject) => {
      const req = http.get(
        `http://${this.host}:${this.port}/consoleLogs?since=${encodeURIComponent(this.since)}`,
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            try {
              const data = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as {
                entries: LogEntry[];
              };
              resolve(data.entries ?? []);
            } catch {
              resolve([]);
            }
          });
        }
      );
      req.setTimeout(5000, () => {
        req.destroy();
        reject(new Error('Timeout polling console logs'));
      });
      req.on('error', reject);
    });
  }

  private checkAlive(): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get(`http://${this.host}:${this.port}/status`, (res) => {
        resolve(res.statusCode === 200);
        res.resume();
      });
      req.setTimeout(2000, () => {
        req.destroy();
        resolve(false);
      });
      req.on('error', () => resolve(false));
    });
  }
}
