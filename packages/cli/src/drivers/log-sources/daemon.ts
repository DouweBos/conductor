/**
 * Daemon log source — polls the daemon's /logs HTTP endpoint over Unix socket.
 *
 * Used by the `logs` command for streaming mode. For snapshot mode (--recent),
 * the CLI calls fetchDaemonLogs() directly instead.
 */
import http from 'http';
import { LogSource, LogEntry } from './types.js';
import { socketPath } from '../../daemon/protocol.js';

const POLL_INTERVAL_MS = 500;

export class DaemonLogSource implements LogSource {
  private callback: ((entry: LogEntry) => void) | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private since = new Date().toISOString();
  private stopped = false;
  private readonly sockPath: string;
  private metroSent = false;

  constructor(
    private readonly sessionName: string,
    private readonly metroPort?: number | 'auto'
  ) {
    this.sockPath = socketPath(sessionName);
  }

  async connect(): Promise<void> {
    // Verify daemon is reachable
    const alive = await this.checkAlive();
    if (!alive) {
      throw new Error(`Daemon for session "${this.sessionName}" is not responding. Is it running?`);
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
        // Daemon may have restarted — keep polling
      }
      if (!this.stopped) {
        this.pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
      }
    };
    poll();
  }

  private fetchLogs(): Promise<LogEntry[]> {
    // Include metro param on the first poll to trigger discovery in the daemon
    let reqPath = `/logs?since=${encodeURIComponent(this.since)}`;
    if (this.metroPort !== undefined && !this.metroSent) {
      reqPath += this.metroPort === 'auto' ? '&metro' : `&metro=${this.metroPort}`;
      this.metroSent = true;
    }

    return new Promise((resolve, reject) => {
      const req = http.get(
        {
          socketPath: this.sockPath,
          path: reqPath,
        },
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
        reject(new Error('Timeout polling daemon logs'));
      });
      req.on('error', reject);
    });
  }

  private checkAlive(): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get({ socketPath: this.sockPath, path: '/status' }, (res) => {
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
