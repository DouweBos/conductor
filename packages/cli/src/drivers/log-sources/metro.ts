/**
 * Metro CDP log source — connects to the React Native Metro dev server's
 * Chrome DevTools Protocol endpoint to stream JS console output.
 */
import http from 'http';
import WebSocket from 'ws';
import { LogSource, LogEntry } from './types.js';

interface CDPRemoteObject {
  type: string;
  subtype?: string;
  value?: unknown;
  description?: string;
  preview?: { description?: string };
}

interface CDPConsoleEvent {
  method: 'Runtime.consoleAPICalled';
  params: {
    type: string;
    args: CDPRemoteObject[];
    timestamp: number;
    stackTrace?: {
      callFrames: Array<{
        functionName: string;
        url: string;
        lineNumber: number;
        columnNumber: number;
      }>;
    };
  };
}

/** Strip ANSI escape sequences from a string. */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function serializeRemoteObject(obj: CDPRemoteObject): string {
  if (obj.type === 'string') return stripAnsi(String(obj.value ?? ''));
  if (obj.type === 'number' || obj.type === 'boolean') return String(obj.value);
  if (obj.type === 'undefined') return 'undefined';
  if (obj.type === 'symbol') return obj.description ?? 'Symbol()';
  if (obj.subtype === 'null') return 'null';
  return obj.description ?? obj.preview?.description ?? `[${obj.type}]`;
}

function mapCDPLevel(type: string): LogEntry['level'] {
  switch (type) {
    case 'warning':
      return 'warning';
    case 'error':
      return 'error';
    case 'info':
      return 'info';
    case 'debug':
      return 'debug';
    case 'trace':
      return 'verbose';
    default:
      return 'log';
  }
}

/** Strip Metro bundle URLs down to just the file path. */
function cleanUrl(raw: string): string {
  // Metro URLs look like: http://localhost:8082/index.bundle//&platform=ios&dev=true&...
  // Or relative paths from source maps. Keep just the filename if it's a bundle URL.
  try {
    const u = new URL(raw);
    // It's a full URL — strip to pathname, remove /index.bundle prefix
    let p = u.pathname;
    if (p.startsWith('/index.bundle')) p = '<bundle>';
    return p;
  } catch {
    // Already a plain path — return as-is
    return raw;
  }
}

/** Metro bundler-internal function names that repeat in require cycles. */
const METRO_INTERNALS = new Set([
  'metroRequire',
  'loadModuleImplementation',
  'guardedLoadModule',
  'metroImportDefault',
  'metroImportAll',
]);

const MAX_STACK_FRAMES = 10;

function formatStackTrace(st?: CDPConsoleEvent['params']['stackTrace']): string | null {
  if (!st || st.callFrames.length === 0) return null;

  // Filter out repetitive Metro bundler internals
  const meaningful = st.callFrames.filter((f) => !METRO_INTERNALS.has(f.functionName));

  const frames = meaningful.slice(0, MAX_STACK_FRAMES);
  const lines = frames.map((f) => {
    const fn = f.functionName || '<anonymous>';
    return `  at ${fn} (${cleanUrl(f.url)}:${f.lineNumber + 1}:${f.columnNumber + 1})`;
  });

  const omitted = meaningful.length - frames.length;
  if (omitted > 0) {
    lines.push(`  ... ${omitted} more frames`);
  }

  return lines.join('\n');
}

export interface MetroTarget {
  webSocketDebuggerUrl?: string;
  title?: string;
  description?: string;
  deviceName?: string;
  deviceId?: string;
  appId?: string;
  id?: string;
  reactNative?: {
    logicalDeviceId?: string;
    capabilities?: Record<string, boolean>;
  };
}

/** Fetch the list of debugger targets from Metro's /json endpoint. */
export async function fetchTargets(port: number, host: string): Promise<MetroTarget[]> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://${host}:${port}/json`, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')) as MetroTarget[]);
        } catch {
          reject(new Error('Failed to parse Metro /json response'));
        }
      });
    });
    req.setTimeout(2000, () => {
      req.destroy();
      reject(new Error(`Could not connect to Metro on port ${port}. Is Metro running?`));
    });
    req.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ECONNREFUSED') {
        reject(new Error(`Could not connect to Metro on port ${port}. Is Metro running?`));
      } else {
        reject(err);
      }
    });
  });
}

/**
 * Discover the WebSocket debugger URL from Metro's /json endpoint.
 *
 * When `targetIndex` is provided, connects to that specific target (0-based).
 * This lets agents running on multiple devices each pick their own debugger
 * target explicitly, since Metro's internal target IDs don't map cleanly to
 * simulator UDIDs or emulator serial numbers.
 *
 * When omitted, prefers the first Hermes target, then the first available.
 * If there are multiple targets and no index was given, logs a hint about
 * using `--target` to select one.
 */
async function discoverTarget(port: number, host: string, targetIndex?: number): Promise<string> {
  const data = await fetchTargets(port, host);
  const withWs = data.filter((t) => t.webSocketDebuggerUrl);

  if (withWs.length === 0) {
    throw new Error(
      'Metro returned no debugger targets. Is the app running on a device/simulator?'
    );
  }

  if (targetIndex !== undefined) {
    if (targetIndex < 0 || targetIndex >= withWs.length) {
      const list = withWs
        .map((t, i) => `  ${i}: ${t.title ?? t.description ?? t.deviceName ?? '(unnamed)'}`)
        .join('\n');
      throw new Error(`--target ${targetIndex} is out of range. Available Metro targets:\n${list}`);
    }
    return withWs[targetIndex].webSocketDebuggerUrl!;
  }

  if (withWs.length > 1) {
    const list = withWs
      .map((t, i) => `  ${i}: ${t.title ?? t.description ?? t.deviceName ?? '(unnamed)'}`)
      .join('\n');
    console.error(
      `Multiple Metro targets found. Using target 0. Use --target <n> to select:\n${list}`
    );
  }

  const target = withWs.find((t) => t.title && /hermes|react/i.test(t.title)) ?? withWs[0];
  return target.webSocketDebuggerUrl!;
}

export class MetroLogSource implements LogSource {
  private ws: WebSocket | null = null;
  private callback: ((entry: LogEntry) => void) | null = null;
  private nextId = 1;
  private reconnecting = false;
  private disconnected = false;

  constructor(
    private readonly port = 8081,
    private readonly host = 'localhost',
    private readonly targetIndex?: number
  ) {}

  async connect(): Promise<void> {
    const wsUrl = await discoverTarget(this.port, this.host, this.targetIndex);
    await this.openSocket(wsUrl);
  }

  onEntry(callback: (entry: LogEntry) => void): void {
    this.callback = callback;
  }

  disconnect(): void {
    this.disconnected = true;
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
  }

  private async openSocket(wsUrl: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      this.ws = ws;

      ws.on('open', () => {
        // Enable the Runtime domain to receive consoleAPICalled events
        ws.send(JSON.stringify({ id: this.nextId++, method: 'Runtime.enable' }));
        resolve();
      });

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString()) as CDPConsoleEvent;
          if (msg.method === 'Runtime.consoleAPICalled') {
            const { type, args, timestamp, stackTrace } = msg.params;
            const entry: LogEntry = {
              timestamp: new Date(timestamp).toISOString(),
              level: mapCDPLevel(type),
              message: args.map(serializeRemoteObject).join(' '),
              stackTrace: formatStackTrace(stackTrace),
              source: 'metro',
            };
            this.callback?.(entry);
          }
        } catch {
          // Ignore non-matching messages
        }
      });

      ws.on('close', () => {
        if (!this.disconnected) {
          this.scheduleReconnect();
        }
      });

      ws.on('error', (err) => {
        if (!this.ws) {
          // Connection never opened
          reject(err);
        }
        // Errors while running will trigger 'close' → reconnect
      });
    });
  }

  private scheduleReconnect(attempt = 0): void {
    if (this.disconnected || this.reconnecting) return;
    this.reconnecting = true;

    const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
    setTimeout(async () => {
      if (this.disconnected) {
        this.reconnecting = false;
        return;
      }
      try {
        const wsUrl = await discoverTarget(this.port, this.host, this.targetIndex);
        await this.openSocket(wsUrl);
        this.reconnecting = false;
        // Signal reconnection to the user via a synthetic log entry
        this.callback?.({
          timestamp: new Date().toISOString(),
          level: 'info',
          message: '[conductor] Reconnected to Metro',
          stackTrace: null,
          source: 'metro',
        });
      } catch {
        this.reconnecting = false;
        this.scheduleReconnect(attempt + 1);
      }
    }, delay);
  }
}
