/**
 * One-shot CDP client to Metro's debugger endpoint.
 *
 * Sibling to `MetroLogSource` in log-sources/metro.ts: that class stays connected
 * to stream `Runtime.consoleAPICalled`; this one opens a short-lived socket for
 * request/response calls (`Page.reload`, `Runtime.evaluate`, etc.).
 *
 * Reuses `fetchTargets()` / target selection from `log-sources/metro.ts` and
 * `metro-discovery.ts` — do not duplicate discovery logic here.
 */
import WebSocket from 'ws';
import { fetchTargets, type MetroTarget } from './log-sources/metro.js';
import { selectTargetForDevice, getDeviceDisplayName } from './log-sources/metro-discovery.js';

export interface CdpCallOptions {
  /** Metro server port. Defaults to 8081. */
  port?: number;
  /** Metro host. Defaults to localhost. */
  host?: string;
  /** Device ID for target selection. When omitted, picks the first available target. */
  deviceId?: string;
  /** Platform of `deviceId`, needed to resolve the device's display name. */
  platform?: string;
  /** Index into the unfiltered target list — overrides device-based selection. */
  targetIndex?: number;
  /** Per-call timeout (ms). Default 10s. */
  timeoutMs?: number;
}

interface CdpResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface CdpRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

/**
 * Pick a debugger `webSocketDebuggerUrl` from an already-fetched target list.
 * Pure — the async `fetchTargets` / `getDeviceDisplayName` calls happen in
 * `resolveDebuggerUrl`. `displayName` is the device's resolved display name,
 * used for device-scoped selection when present. Throws with a clear message
 * when no target matches.
 */
export function selectDebuggerUrl(
  targets: MetroTarget[],
  opts: Pick<CdpCallOptions, 'port' | 'host' | 'targetIndex'>,
  displayName?: string
): string {
  const port = opts.port ?? 8081;
  const host = opts.host ?? 'localhost';
  const withWs = targets.filter((t) => t.webSocketDebuggerUrl);

  if (withWs.length === 0) {
    throw new Error(
      `Metro on ${host}:${port} returned no debugger targets. Is an app running on a device/simulator?`
    );
  }

  if (opts.targetIndex !== undefined) {
    if (opts.targetIndex < 0 || opts.targetIndex >= withWs.length) {
      throw new Error(`--target ${opts.targetIndex} is out of range (have ${withWs.length}).`);
    }
    return withWs[opts.targetIndex].webSocketDebuggerUrl!;
  }

  if (displayName) {
    const target = selectTargetForDevice(withWs, displayName);
    if (target) return target.webSocketDebuggerUrl!;
  }

  // Prefer the Hermes/React target by title, otherwise first.
  const target = withWs.find((t) => t.title && /hermes|react/i.test(t.title)) ?? withWs[0];
  return target.webSocketDebuggerUrl!;
}

/**
 * Resolve a Metro target's `webSocketDebuggerUrl` honoring deviceId / targetIndex.
 * Throws with a clear message if Metro is unreachable or no target matches.
 */
export async function resolveDebuggerUrl(opts: CdpCallOptions): Promise<string> {
  const port = opts.port ?? 8081;
  const host = opts.host ?? 'localhost';
  const targets = await fetchTargets(port, host);

  let displayName: string | undefined;
  if (opts.deviceId && opts.platform) {
    displayName = (await getDeviceDisplayName(opts.platform, opts.deviceId)) ?? undefined;
  }

  return selectDebuggerUrl(targets, opts, displayName);
}

/**
 * Open a short-lived CDP socket, send a single method, return the result.
 * Closes the socket whether the call succeeds or throws.
 */
export async function cdpCall<T = unknown>(
  method: string,
  params: Record<string, unknown> | undefined,
  opts: CdpCallOptions
): Promise<T> {
  const wsUrl = await resolveDebuggerUrl(opts);
  return cdpCallOnUrl<T>(wsUrl, method, params, opts.timeoutMs ?? 10_000);
}

async function cdpCallOnUrl<T>(
  wsUrl: string,
  method: string,
  params: Record<string, unknown> | undefined,
  timeoutMs: number
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      ws.terminate();
      reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    function finish(err: Error | null, value?: T): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.removeAllListeners();
      try {
        ws.close();
      } catch {
        // ignore
      }
      if (err) reject(err);
      else resolve(value as T);
    }

    const req: CdpRequest = { id: 1, method };
    if (params) req.params = params;

    ws.on('open', () => {
      ws.send(JSON.stringify(req));
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as CdpResponse;
        if (msg.id !== req.id) return;
        if (msg.error) {
          finish(new Error(`CDP ${method}: ${msg.error.message}`));
        } else {
          finish(null, msg.result as T);
        }
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });

    ws.on('error', (err) => finish(err));
    ws.on('close', () => {
      if (!settled) finish(new Error(`CDP socket closed before ${method} completed`));
    });
  });
}

/**
 * Stateful CDP client. Open once, issue many calls. Used by the debugger
 * commands that need session-scoped state (loaded scripts, enabled domains).
 */
export class MetroCdpClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private events = new Map<string, Array<(params: unknown) => void>>();
  private enabledDomains = new Set<string>();
  private loadedScripts = new Map<string, { url: string }>();
  private bindings = new Set<string>();
  private callbackPending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();

  async connect(opts: CdpCallOptions): Promise<void> {
    const wsUrl = await resolveDebuggerUrl(opts);
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.on('open', () => {
        this.ws = ws;
        resolve();
      });
      ws.on('message', (data) => this.handleMessage(data.toString()));
      ws.on('error', (err) => {
        if (!this.ws) reject(err);
      });
      ws.on('close', () => {
        this.ws = null;
      });
    });
  }

  private handleMessage(raw: string): void {
    try {
      const msg = JSON.parse(raw) as Partial<CdpResponse> & { method?: string; params?: unknown };
      if (typeof msg.id === 'number') {
        const slot = this.pending.get(msg.id);
        if (slot) {
          this.pending.delete(msg.id);
          if (msg.error) slot.reject(new Error(msg.error.message));
          else slot.resolve(msg.result);
        }
        return;
      }
      if (msg.method) {
        if (msg.method === 'Debugger.scriptParsed') {
          const p = msg.params as { scriptId: string; url: string };
          if (p?.scriptId) this.loadedScripts.set(p.scriptId, { url: p.url });
        }
        const handlers = this.events.get(msg.method);
        if (handlers) for (const h of handlers) h(msg.params);
      }
    } catch {
      // ignore parse errors
    }
  }

  on(method: string, handler: (params: unknown) => void): void {
    const arr = this.events.get(method) ?? [];
    arr.push(handler);
    this.events.set(method, arr);
  }

  async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (!this.ws) throw new Error('CDP client not connected');
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
      });
      this.ws!.send(JSON.stringify({ id, method, params }));
    });
  }

  async enableDomain(domain: 'Runtime' | 'Debugger' | 'Page' | 'Network'): Promise<void> {
    if (this.enabledDomains.has(domain)) return;
    await this.send(`${domain}.enable`);
    this.enabledDomains.add(domain);
  }

  /**
   * Install a `Runtime.addBinding` callback. The injected JS calls
   * `globalThis.__conductor_callback(JSON.stringify({ requestId, ... }))` and
   * this method routes the payload back to the awaiter keyed on `requestId`.
   *
   * Returns a function that, given a requestId, returns a promise resolving
   * to the next payload tagged with that requestId. Useful for async fiber
   * walkers that can't return synchronously from `Runtime.evaluate`.
   */
  async installCallbackBinding(
    bindingName = '__conductor_callback'
  ): Promise<(requestId: string, timeoutMs?: number) => Promise<unknown>> {
    await this.enableDomain('Runtime');
    if (!this.bindings.has(bindingName)) {
      await this.send('Runtime.addBinding', { name: bindingName });
      this.bindings.add(bindingName);
      this.on('Runtime.bindingCalled', (params) => {
        const p = params as { name: string; payload: string };
        if (p.name !== bindingName) return;
        try {
          const parsed = JSON.parse(p.payload) as { requestId?: string };
          if (parsed.requestId && this.callbackPending.has(parsed.requestId)) {
            const slot = this.callbackPending.get(parsed.requestId)!;
            this.callbackPending.delete(parsed.requestId);
            slot.resolve(parsed);
          }
        } catch {
          // ignore malformed payloads
        }
      });
    }
    return (requestId: string, timeoutMs = 5000) =>
      new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.callbackPending.delete(requestId);
          reject(new Error(`callback ${requestId} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        this.callbackPending.set(requestId, {
          resolve: (v) => {
            clearTimeout(timer);
            resolve(v);
          },
          reject,
        });
      });
  }

  /**
   * Evaluate a JS expression in the app's runtime. Returns the value or throws
   * a thrown JS exception's description. Awaits promises by default.
   */
  async evaluate<T = unknown>(expression: string, returnByValue = true): Promise<T> {
    await this.enableDomain('Runtime');
    const result = await this.send<{
      result: { type: string; value?: unknown; description?: string };
      exceptionDetails?: { exception?: { description?: string }; text?: string };
    }>('Runtime.evaluate', {
      expression,
      returnByValue,
      awaitPromise: true,
      generatePreview: false,
    });
    if (result.exceptionDetails) {
      const msg =
        result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        'evaluation threw';
      throw new Error(msg);
    }
    return (result.result.value ?? result.result.description) as T;
  }

  getEnabledDomains(): Set<string> {
    return new Set(this.enabledDomains);
  }

  getLoadedScripts(): Map<string, { url: string }> {
    return this.loadedScripts;
  }

  isConnected(): boolean {
    return this.ws !== null;
  }

  close(): void {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.pending.clear();
    this.events.clear();
  }
}
