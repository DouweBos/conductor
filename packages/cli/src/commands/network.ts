export const HELP = `  network logs [--port N] [--limit N]  Read recent HTTP traffic (installs a fetch/XHR shim once)
  network request <url> [--method M] [--body STR] [--header K=V] [--port N]
                                       Issue an HTTP request from the app's context`;

import { printError, printData, OutputOptions } from '../output.js';
import { MetroCdpClient } from '../drivers/metro-cdp.js';
import { detectPlatform } from '../drivers/bootstrap.js';

export interface NetworkOptions {
  port?: number;
  targetIndex?: number;
  limit?: number;
}

export interface NetworkRequestOptions extends NetworkOptions {
  method?: string;
  body?: string;
  headers?: string[];
}

const INSTALL_SHIM_SCRIPT = `
(() => {
  if (globalThis.__CONDUCTOR_NET__ && globalThis.__CONDUCTOR_NET__.installed) {
    return { installed: true, already: true };
  }
  const ring = [];
  const MAX = 200;
  function push(entry) {
    ring.push(entry);
    if (ring.length > MAX) ring.shift();
  }
  globalThis.__CONDUCTOR_NET__ = {
    installed: true,
    entries: ring,
    clear: () => { ring.length = 0; },
  };

  const realFetch = globalThis.fetch;
  if (typeof realFetch === 'function') {
    globalThis.fetch = function patchedFetch(input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || String(input);
      const method = (init && init.method) || (input && input.method) || 'GET';
      const start = Date.now();
      const id = Math.random().toString(36).slice(2, 10);
      const entry = { id, kind: 'fetch', method, url, status: null, durationMs: null, error: null, start };
      push(entry);
      let p;
      try { p = realFetch.apply(this, arguments); } catch (e) {
        entry.error = String(e && e.message || e);
        entry.durationMs = Date.now() - start;
        throw e;
      }
      return p.then(res => {
        entry.status = res.status;
        entry.durationMs = Date.now() - start;
        return res;
      }, err => {
        entry.error = String(err && err.message || err);
        entry.durationMs = Date.now() - start;
        throw err;
      });
    };
  }

  const RealXHR = globalThis.XMLHttpRequest;
  if (RealXHR) {
    const origOpen = RealXHR.prototype.open;
    const origSend = RealXHR.prototype.send;
    RealXHR.prototype.open = function open(method, url) {
      this.__c_meta = { id: Math.random().toString(36).slice(2, 10), kind: 'xhr', method, url, status: null, durationMs: null, error: null, start: 0 };
      return origOpen.apply(this, arguments);
    };
    RealXHR.prototype.send = function send() {
      const meta = this.__c_meta;
      if (meta) {
        meta.start = Date.now();
        push(meta);
        this.addEventListener('loadend', () => {
          meta.status = this.status;
          meta.durationMs = Date.now() - meta.start;
        });
        this.addEventListener('error', () => {
          meta.error = 'xhr error';
          meta.durationMs = Date.now() - meta.start;
        });
      }
      return origSend.apply(this, arguments);
    };
  }
  return { installed: true, already: false };
})()
`;

const READ_SCRIPT = (limit: number) => `
(() => {
  const tap = globalThis.__CONDUCTOR_NET__;
  if (!tap) return { installed: false, entries: [] };
  const entries = tap.entries.slice(-${limit});
  return { installed: true, count: entries.length, entries };
})()
`;

interface ShimResult {
  installed: boolean;
  already?: boolean;
}

interface NetEntry {
  id: string;
  kind: 'fetch' | 'xhr';
  method: string;
  url: string;
  status: number | null;
  durationMs: number | null;
  error: string | null;
  start: number;
}

function resolveSession(sessionName: string): {
  deviceId?: string;
  platformPromise: Promise<string | undefined>;
} {
  if (!sessionName || sessionName === 'default') {
    return { deviceId: undefined, platformPromise: Promise.resolve(undefined) };
  }
  return {
    deviceId: sessionName,
    platformPromise: detectPlatform(sessionName).catch(() => undefined),
  };
}

export async function networkLogs(
  opts: OutputOptions,
  sessionName: string,
  netOpts: NetworkOptions
): Promise<number> {
  const port = netOpts.port ?? 8081;
  const limit = netOpts.limit ?? 50;
  const { deviceId, platformPromise } = resolveSession(sessionName);
  try {
    const platform = await platformPromise;
    const client = new MetroCdpClient();
    await client.connect({ port, deviceId, platform, targetIndex: netOpts.targetIndex });
    await client.evaluate<ShimResult>(INSTALL_SHIM_SCRIPT);
    const result = await client.evaluate<{
      installed: boolean;
      entries?: NetEntry[];
      count?: number;
    }>(READ_SCRIPT(limit));
    client.close();
    const entries = result.entries ?? [];
    if (opts.json) {
      printData({ installed: result.installed, count: entries.length, entries }, opts);
    } else {
      if (entries.length === 0) {
        console.log(
          'No network entries captured yet. The shim is installed; reload the app and try again.'
        );
      }
      for (const e of entries) {
        const ts = new Date(e.start).toISOString().slice(11, 23);
        const status = e.error ? `ERR ${e.error}` : e.status !== null ? String(e.status) : '...';
        const dur = e.durationMs !== null ? `${e.durationMs}ms` : '-';
        console.log(
          `${ts}  ${status.padEnd(6)} ${e.method.padEnd(6)} ${e.url} (${dur}, ${e.kind})`
        );
      }
    }
    return 0;
  } catch (err) {
    printError(`network logs — ${err instanceof Error ? err.message : String(err)}`, opts);
    return 1;
  }
}

export async function networkRequest(
  url: string,
  opts: OutputOptions,
  sessionName: string,
  reqOpts: NetworkRequestOptions
): Promise<number> {
  if (!url) {
    printError('network request requires a URL', opts);
    return 1;
  }
  const method = (reqOpts.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = {};
  for (const h of reqOpts.headers ?? []) {
    const idx = h.indexOf('=');
    if (idx > 0) headers[h.slice(0, idx)] = h.slice(idx + 1);
  }
  const body = reqOpts.body;
  const init = JSON.stringify({
    method,
    headers,
    ...(body !== undefined ? { body } : {}),
  });

  const script = `
(async () => {
  try {
    const res = await fetch(${JSON.stringify(url)}, ${init});
    const text = await res.text();
    const hdrs = {};
    res.headers.forEach((v, k) => { hdrs[k] = v; });
    return { ok: res.ok, status: res.status, headers: hdrs, body: text };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
})()
`;

  const port = reqOpts.port ?? 8081;
  const { deviceId, platformPromise } = resolveSession(sessionName);
  try {
    const platform = await platformPromise;
    const client = new MetroCdpClient();
    await client.connect({ port, deviceId, platform, targetIndex: reqOpts.targetIndex });
    const result = await client.evaluate<{
      ok: boolean;
      status?: number;
      headers?: Record<string, string>;
      body?: string;
      error?: string;
    }>(script);
    client.close();
    if (opts.json) printData(result, opts);
    else {
      if (result.error) console.error(`error: ${result.error}`);
      console.log(`status: ${result.status ?? 'n/a'}`);
      if (result.headers) {
        for (const [k, v] of Object.entries(result.headers)) console.log(`${k}: ${v}`);
      }
      if (result.body !== undefined) {
        console.log('');
        console.log(result.body);
      }
    }
    return result.ok ? 0 : 1;
  } catch (err) {
    printError(`network request — ${err instanceof Error ? err.message : String(err)}`, opts);
    return 1;
  }
}
