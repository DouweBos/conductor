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
import { fetchTargets, metroWsOrigin, type MetroTarget } from './log-sources/metro.js';
import {
  deviceNameMatches,
  getDeviceDisplayName,
  discoverMetroPortForDevice,
} from './log-sources/metro-discovery.js';

export interface CdpCallOptions {
  /** Metro server port. When omitted, discovered from the device, then 8081. */
  port?: number;
  /** Metro host. Defaults to localhost. */
  host?: string;
  /** Device ID for target selection. When omitted, picks the first available target. */
  deviceId?: string;
  /** Platform of `deviceId`, needed to resolve the device's display name. */
  platform?: string;
  /** Index into the unfiltered target list — overrides device-based selection. */
  targetIndex?: number;
  /** Bundle/package id: keep only targets of this app (several apps can share one Metro). */
  appId?: string;
  /** Exact Metro page id (`id` in /json) — overrides every other selector. */
  pageId?: string;
  /** Metro's `reactNative.logicalDeviceId`: stable across reloads, used to re-attach. */
  logicalDeviceId?: string;
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

/** The app a Metro target belongs to. Older Metro only reports it in `description`. */
export function targetAppId(t: MetroTarget): string | undefined {
  return t.appId ?? t.description ?? undefined;
}

function describeTargets(targets: MetroTarget[]): string {
  return targets
    .map(
      (t, i) =>
        `  [${i}] ${t.deviceName ?? t.title ?? '(unnamed)'}` +
        (targetAppId(t) ? `  app=${targetAppId(t)}` : '') +
        (t.id ? `  page=${t.id}` : '') +
        (t.reactNative?.logicalDeviceId ? `  device=${t.reactNative.logicalDeviceId}` : '')
    )
    .join('\n');
}

function preferRuntime(targets: MetroTarget[]): MetroTarget {
  return (
    targets.find((t) => t.reactNative?.capabilities?.prefersFuseboxFrontend) ??
    // Reanimated registers worklet runtimes as extra targets; their titles do not say Hermes/React.
    targets.find((t) => t.title && /hermes|react/i.test(t.title)) ??
    targets[0]
  );
}

/**
 * Pick a Metro debugger target from an already-fetched target list.
 *
 * Pure — the async `fetchTargets` / `getDeviceDisplayName` calls happen in
 * `resolveTarget`. `displayName` is the device's resolved display name, used for
 * device-scoped selection when present. Throws with a clear message when no
 * target matches, or when a device-scoped match is ambiguous (several apps, or
 * several devices sharing one name, on the same Metro) — guessing there
 * attaches to the wrong session and reports its data as this one's.
 */
export function selectTarget(
  targets: MetroTarget[],
  opts: Pick<
    CdpCallOptions,
    'port' | 'host' | 'targetIndex' | 'deviceId' | 'appId' | 'pageId' | 'logicalDeviceId'
  >,
  displayName?: string
): MetroTarget {
  const port = opts.port ?? 8081;
  const host = opts.host ?? 'localhost';
  const withWs = targets.filter((t) => t.webSocketDebuggerUrl);

  if (withWs.length === 0) {
    // Metro is reachable but nothing registered. The usual cause is not a
    // missing app — it is a release build: release Hermes ships without the
    // inspector and never connects to Metro at all, so asking "is the app
    // running?" sends people to check something that is already true.
    throw new Error(
      `Metro on ${host}:${port} is reachable but has no debugger targets.\n` +
        `Most often the app is a release build — release Hermes ships without the ` +
        `inspector and never connects to Metro, so no amount of relaunching will help. ` +
        `Use a debug or profiling build for anything that attaches over Metro ` +
        `(\`profile js\`, \`profile react\`, \`debug\`, \`network\`).\n` +
        `Otherwise: check the app is running and foreground, and that it is pointed at ` +
        `this Metro instance rather than another one.`
    );
  }

  if (opts.pageId !== undefined) {
    const t = withWs.find((x) => x.id === opts.pageId);
    if (t) return t;
    throw new Error(
      `No Metro debugger target with page id ${opts.pageId}.\nAvailable targets:\n${describeTargets(withWs)}`
    );
  }

  if (opts.targetIndex !== undefined) {
    if (opts.targetIndex < 0 || opts.targetIndex >= withWs.length) {
      throw new Error(`--target ${opts.targetIndex} is out of range (have ${withWs.length}).`);
    }
    return withWs[opts.targetIndex];
  }

  let candidates = withWs;
  let scoped = false;
  if (opts.logicalDeviceId) {
    scoped = true;
    candidates = withWs.filter((t) => t.reactNative?.logicalDeviceId === opts.logicalDeviceId);
    if (candidates.length === 0) {
      throw new Error(
        `No Metro debugger target for logical device ${opts.logicalDeviceId} (the app may be ` +
          `reloading or disconnected).\nAvailable targets:\n${describeTargets(withWs)}`
      );
    }
  } else if (opts.deviceId) {
    // Device-scoped: must resolve to that device's own target. Never silently
    // fall back to another device — that reloads the wrong app and reports success.
    scoped = true;
    candidates = displayName
      ? withWs.filter((t) => deviceNameMatches(t.deviceName, displayName))
      : [];
    if (candidates.length === 0) {
      throw new Error(
        `No Metro debugger target for device ${opts.deviceId}` +
          (displayName ? ` (${displayName})` : '') +
          `.\nAvailable targets:\n${describeTargets(withWs)}\nPass --target <index> to pick one explicitly.`
      );
    }
  }

  if (opts.appId) {
    scoped = true;
    const forApp = candidates.filter((t) => {
      const app = targetAppId(t);
      return app === opts.appId || (app !== undefined && app.startsWith(`${opts.appId} `));
    });
    if (forApp.length === 0) {
      throw new Error(
        `No Metro debugger target for app ${opts.appId}` +
          (opts.deviceId ? ` on device ${opts.deviceId}` : '') +
          `.\nAvailable targets:\n${describeTargets(candidates)}`
      );
    }
    candidates = forApp;
  }

  if (scoped) {
    const apps = new Set(candidates.map(targetAppId).filter(Boolean));
    if (apps.size > 1) {
      throw new Error(
        `Several apps on this device are attached to Metro on port ${port} ` +
          `(${[...apps].join(', ')}), so the target is ambiguous.\n` +
          `Pass --app <bundleId> (or --page <id>) to pick one:\n${describeTargets(candidates)}`
      );
    }
    const devices = new Set(candidates.map((t) => t.reactNative?.logicalDeviceId).filter(Boolean));
    if (devices.size > 1) {
      throw new Error(
        `Several devices named "${candidates[0].deviceName}" run this app against Metro on ` +
          `port ${port}, so the target is ambiguous.\nPass --page <id> to pick one:\n` +
          describeTargets(candidates)
      );
    }
  }

  return preferRuntime(candidates);
}

/** Back-compat wrapper over `selectTarget` that returns only the socket URL. */
export function selectDebuggerUrl(
  targets: MetroTarget[],
  opts: Pick<
    CdpCallOptions,
    'port' | 'host' | 'targetIndex' | 'deviceId' | 'appId' | 'pageId' | 'logicalDeviceId'
  >,
  displayName?: string
): string {
  return selectTarget(targets, opts, displayName).webSocketDebuggerUrl!;
}

/**
 * Resolve a Metro target's `webSocketDebuggerUrl` honoring deviceId / targetIndex.
 * Throws with a clear message if Metro is unreachable or no target matches.
 */
export async function resolveDebuggerUrl(opts: CdpCallOptions): Promise<string> {
  return (await resolveTarget(opts)).webSocketDebuggerUrl!;
}

/** Like `resolveDebuggerUrl`, but returns the whole target so callers can pin it. */
export async function resolveTarget(opts: CdpCallOptions): Promise<MetroTarget> {
  const port = await resolveMetroPort(opts);
  const host = opts.host ?? 'localhost';

  let targets: MetroTarget[];
  try {
    targets = await fetchTargets(port, host);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Cannot reach Metro on ${host}:${port} — ${detail}.\n` +
        `Pass --port <n> if Metro listens elsewhere (a project may set RCT_METRO_PORT); ` +
        `\`conductor workspace info\` reports the port it can see.`
    );
  }

  let displayName: string | undefined;
  if (opts.deviceId && opts.platform) {
    displayName = (await getDeviceDisplayName(opts.platform, opts.deviceId)) ?? undefined;
  }

  return selectTarget(targets, { ...opts, port }, displayName);
}

/**
 * Metro's port for this device: the explicit --port, else whatever the device is
 * actually connected to, else 8081. Auto-discovery matters because a project
 * that sets RCT_METRO_PORT otherwise fails with an opaque connection error.
 */
export async function resolveMetroPort(opts: CdpCallOptions): Promise<number> {
  if (opts.port !== undefined) return opts.port;
  if (opts.deviceId && opts.platform) {
    const discovered = await discoverMetroPortForDevice(opts.platform, opts.deviceId).catch(
      () => null
    );
    if (discovered) return discovered;
  }
  return 8081;
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
    const ws = new WebSocket(wsUrl, { origin: metroWsOrigin(wsUrl) });
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

  /** The Metro target this client attached to, for pinning a later reconnect. */
  target: MetroTarget | null = null;

  async connect(opts: CdpCallOptions): Promise<void> {
    const target = await resolveTarget(opts);
    this.target = target;
    const wsUrl = target.webSocketDebuggerUrl!;
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl, { origin: metroWsOrigin(wsUrl) });
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
