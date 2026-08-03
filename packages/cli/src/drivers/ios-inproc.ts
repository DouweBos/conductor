/**
 * Client + port allocation for the injected in-process control library
 * (`packages/ios-inproc`). This is a second inspection plane that runs *inside*
 * the target app — distinct from the external XCUITest driver in `ios.ts`.
 *
 * The dylib is injected at launch (see IOSDriver.launchApp `inject` option). The
 * CLI allocates a loopback port per device, hands it to the app via
 * SIMCTL_CHILD_CONDUCTOR_INPROC_PORT, and connects here. Simulator apps share
 * the host loopback, so 127.0.0.1:<port> reaches the in-process server — the same
 * mechanism the XCUITest driver uses on :1075.
 */
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';

const INPROC_BASE_PORT = 6075;
const PORT_FILE = path.join(os.homedir(), '.conductor', 'inproc-ports.json');

interface InprocPortState {
  assignments: Record<string, number>;
  nextPort: number;
}

function readState(): InprocPortState {
  try {
    return JSON.parse(fs.readFileSync(PORT_FILE, 'utf-8')) as InprocPortState;
  } catch {
    return { assignments: {}, nextPort: INPROC_BASE_PORT };
  }
}

/**
 * Deterministic in-process control port for a device. Stable across calls so
 * the launcher and any later `native-*` command agree without a discovery file.
 */
export function getInprocPort(deviceId: string): number {
  const state = readState();
  const existing = state.assignments[deviceId];
  if (existing !== undefined) return existing;
  const port = state.nextPort;
  state.assignments[deviceId] = port;
  state.nextPort = port + 1;
  fs.mkdirSync(path.dirname(PORT_FILE), { recursive: true });
  fs.writeFileSync(PORT_FILE, JSON.stringify(state, null, 2));
  return port;
}

export interface InprocPingResult {
  status: string;
  pid?: number;
  app?: string;
  process?: string;
}

/** HTTP/JSON client for the in-process control server. */
export class InprocClient {
  constructor(
    private readonly port: number,
    private readonly host = '127.0.0.1'
  ) {}

  private get<T>(reqPath: string, timeoutMs = 5000): Promise<T> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { hostname: this.host, port: this.port, path: reqPath, method: 'GET' },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')) as T);
            } catch (err) {
              reject(err);
            }
          });
          res.on('error', reject);
        }
      );
      req.setTimeout(timeoutMs, () => req.destroy(new Error('in-proc request timed out')));
      req.on('error', reject);
      req.end();
    });
  }

  ping(timeoutMs = 5000): Promise<InprocPingResult> {
    return this.get<InprocPingResult>('/ping', timeoutMs);
  }

  /** Full native view hierarchy with colors, fonts, text, and layer visuals. */
  inspect(timeoutMs = 15000): Promise<Record<string, unknown>> {
    return this.get<Record<string, unknown>>('/inspect', timeoutMs);
  }

  /** Navigation / view-controller hierarchy (stacks, tabs, presented, titles). */
  nav(timeoutMs = 15000): Promise<Record<string, unknown>> {
    return this.get<Record<string, unknown>>('/nav', timeoutMs);
  }

  /** Full property detail for one view (by id from inspect). */
  view(id: string, timeoutMs = 8000): Promise<Record<string, unknown>> {
    return this.get<Record<string, unknown>>(`/view?id=${encodeURIComponent(id)}`, timeoutMs);
  }

  /** Live-set a whitelisted property on a view (alpha, backgroundColor, text, frame, …). */
  set(id: string, key: string, value: string, timeoutMs = 8000): Promise<Record<string, unknown>> {
    const q = `id=${encodeURIComponent(id)}&key=${encodeURIComponent(key)}&value=${encodeURIComponent(value)}`;
    return this.get<Record<string, unknown>>(`/set?${q}`, timeoutMs);
  }

  /** React Native Fabric props: typed ViewProps + the raw JS prop bag. */
  props(id: string, timeoutMs = 8000): Promise<Record<string, unknown>> {
    return this.get<Record<string, unknown>>(`/props?id=${encodeURIComponent(id)}`, timeoutMs);
  }

  /** Auto Layout constraints affecting a view + ambiguity flag. */
  constraints(id: string, timeoutMs = 8000): Promise<Record<string, unknown>> {
    return this.get<Record<string, unknown>>(
      `/constraints?id=${encodeURIComponent(id)}`,
      timeoutMs
    );
  }

  /** Topmost view at a window point, plus its ancestor chain. */
  hittest(x: number, y: number, timeoutMs = 8000): Promise<Record<string, unknown>> {
    return this.get<Record<string, unknown>>(`/hittest?x=${x}&y=${y}`, timeoutMs);
  }

  /** Flash a highlight overlay over a view on the device. */
  highlight(id: string, timeoutMs = 8000): Promise<Record<string, unknown>> {
    return this.get<Record<string, unknown>>(`/highlight?id=${encodeURIComponent(id)}`, timeoutMs);
  }

  /** Search views by class-name substring and/or text substring. */
  find(
    q: { className?: string; text?: string },
    timeoutMs = 10000
  ): Promise<Record<string, unknown>> {
    const parts: string[] = [];
    if (q.className) parts.push(`class=${encodeURIComponent(q.className)}`);
    if (q.text) parts.push(`text=${encodeURIComponent(q.text)}`);
    return this.get<Record<string, unknown>>(`/find?${parts.join('&')}`, timeoutMs);
  }

  /** PNG of the whole key window. */
  screenshot(timeoutMs = 20000): Promise<Buffer> {
    return this.getBuffer('/screenshot', timeoutMs);
  }

  /**
   * PNG of a single view in isolation — the texture for a 3D exploded-layer
   * viewer. Default (`includeSubviews=false`) captures only this view's own
   * content, so each node is a distinct transparent layer plane.
   */
  snapshot(id: string, includeSubviews = false, timeoutMs = 15000): Promise<Buffer> {
    const q = `id=${encodeURIComponent(id)}&subviews=${includeSubviews ? 'true' : 'false'}`;
    return this.getBuffer(`/snapshot?${q}`, timeoutMs);
  }

  /**
   * PNG crop of a window-absolute rect (use a node's `absFrame` from inspect).
   * Composites whatever is drawn there — works for UIImageView, RN Fabric, etc.
   */
  image(frame: { x: number; y: number; w: number; h: number }, timeoutMs = 15000): Promise<Buffer> {
    return this.getBuffer(`/image?frame=${frame.x},${frame.y},${frame.w},${frame.h}`, timeoutMs);
  }

  /** Raw GET to any endpoint, parsed as JSON. */
  rawJson(reqPath: string, timeoutMs = 15000): Promise<Record<string, unknown>> {
    const path = reqPath.startsWith('/') ? reqPath : `/${reqPath}`;
    return this.get<Record<string, unknown>>(path, timeoutMs);
  }

  /** Raw GET to any endpoint — returns the content-type and bytes (json or image). */
  rawRequest(reqPath: string, timeoutMs = 20000): Promise<{ contentType: string; body: Buffer }> {
    const path = reqPath.startsWith('/') ? reqPath : `/${reqPath}`;
    return new Promise((resolve, reject) => {
      const req = http.request(
        { hostname: this.host, port: this.port, path, method: 'GET' },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () =>
            resolve({ contentType: res.headers['content-type'] ?? '', body: Buffer.concat(chunks) })
          );
          res.on('error', reject);
        }
      );
      req.setTimeout(timeoutMs, () => req.destroy(new Error('in-proc request timed out')));
      req.on('error', reject);
      req.end();
    });
  }

  private getBuffer(reqPath: string, timeoutMs: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { hostname: this.host, port: this.port, path: reqPath, method: 'GET' },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const buf = Buffer.concat(chunks);
            const type = res.headers['content-type'] ?? '';
            if (!type.startsWith('image/')) {
              reject(new Error(`expected an image, got: ${buf.toString('utf-8').slice(0, 200)}`));
              return;
            }
            resolve(buf);
          });
          res.on('error', reject);
        }
      );
      req.setTimeout(timeoutMs, () => req.destroy(new Error('in-proc image request timed out')));
      req.on('error', reject);
      req.end();
    });
  }

  /** True once the in-process server answers a ping (poll after an injected launch). */
  async waitUntilReady(timeoutMs = 10000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await this.ping(1500);
        if (res.status === 'ok') return true;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    return false;
  }
}
