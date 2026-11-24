export const HELP = `  network logs [--port N] [--limit N]  Read recent HTTP traffic (RN: fetch/XHR shim; web: all traffic via Playwright)
    --follow [--duration <s>]          Keep printing requests as they complete (NDJSON with --json)
  network request <url> [--method M] [--body STR] [--header K=V] [--port N]
                                       Issue an HTTP request from the app's context`;

import { printError, printData, OutputOptions } from '../output.js';
import { MetroCdpClient, resolveMetroPort } from '../drivers/metro-cdp.js';
import { detectPlatform } from '../drivers/bootstrap.js';
import { getDriver } from '../runner.js';
import { WebDriver } from '../drivers/web.js';

/** Resolve the web driver when this session targets a web device, else null (→ Metro path). */
async function webDriverFor(sessionName: string): Promise<WebDriver | null> {
  if (!sessionName || sessionName === 'default') return null;
  const platform = await detectPlatform(sessionName).catch(() => undefined);
  if (platform !== 'web') return null;
  const driver = await getDriver(sessionName);
  return driver instanceof WebDriver ? driver : null;
}

function formatNetEntry(e: {
  timestamp: string;
  method: string;
  url: string;
  status: number | null;
  durationMs: number | null;
  error: string | null;
  resourceType?: string;
  kind?: string;
}): string {
  const ts = e.timestamp.slice(11, 23);
  const status = e.error ? `ERR ${e.error}` : e.status !== null ? String(e.status) : '...';
  const dur = e.durationMs !== null ? `${e.durationMs}ms` : '-';
  return `${ts}  ${status.padEnd(6)} ${e.method.padEnd(6)} ${e.url} (${dur}, ${e.resourceType ?? e.kind ?? ''})`;
}

export interface NetworkOptions {
  port?: number;
  targetIndex?: number;
  limit?: number;
  follow?: boolean;
  duration?: number;
  appId?: string;
  pageId?: string;
}

const FOLLOW_POLL_MS = 500;

interface FollowItem {
  key: string;
  done: boolean;
  line: string;
  value: unknown;
}

/**
 * Poll `read` and print each request once it completes. The RN shim and the
 * web capture both keep a ring buffer, so a request is keyed by its id.
 */
async function followEntries(
  read: () => Promise<FollowItem[]>,
  opts: OutputOptions,
  netOpts: NetworkOptions,
  onError: () => Promise<void>
): Promise<number> {
  const seen = new Set<string>();
  let stopped = false;
  const stop = (): void => {
    stopped = true;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const deadline = netOpts.duration !== undefined ? Date.now() + netOpts.duration * 1000 : Infinity;
  let first = true;
  let lastError: string | null = null;
  while (!stopped && Date.now() < deadline) {
    try {
      let items = await read();
      // Like `tail -f`: show the last --limit completed requests, then follow.
      if (first && netOpts.limit !== undefined) {
        const done = items.filter((i) => i.done);
        const skip = new Set(
          done.slice(0, Math.max(0, done.length - netOpts.limit)).map((i) => i.key)
        );
        for (const k of skip) seen.add(k);
        items = items.filter((i) => !skip.has(i.key));
      }
      first = false;
      lastError = null;
      for (const item of items) {
        if (!item.done || seen.has(item.key)) continue;
        seen.add(item.key);
        console.log(opts.json ? JSON.stringify(item.value) : item.line);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg !== lastError) console.error(`network logs — ${msg}`);
      lastError = msg;
      await onError().catch(() => {});
    }
    await new Promise((r) =>
      setTimeout(r, Math.min(FOLLOW_POLL_MS, Math.max(0, deadline - Date.now())))
    );
  }
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
  return 0;
}

function formatShimEntry(e: NetEntry): string {
  const ts = new Date(e.start).toISOString().slice(11, 23);
  const status = e.error ? `ERR ${e.error}` : e.status !== null ? String(e.status) : '...';
  const dur = e.durationMs !== null ? `${e.durationMs}ms` : '-';
  return `${ts}  ${status.padEnd(6)} ${e.method.padEnd(6)} ${e.url} (${dur}, ${e.kind})`;
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
  const limit = netOpts.limit ?? 50;

  // Web: Playwright captures all traffic natively — no Metro, no injected shim.
  const web = await webDriverFor(sessionName);
  if (web && netOpts.follow) {
    return followEntries(
      async () =>
        (await web.networkLogs({ limit: 500 })).entries.map((e) => ({
          key: String(e.id),
          done: e.durationMs !== null || e.error !== null,
          line: formatNetEntry(e),
          value: e,
        })),
      opts,
      netOpts,
      async () => {}
    );
  }
  if (web) {
    try {
      const { entries } = await web.networkLogs({ limit });
      if (opts.json) {
        printData({ installed: true, count: entries.length, entries }, opts);
      } else if (entries.length === 0) {
        console.log('No network entries captured yet. Reload the app and try again.');
      } else {
        for (const e of entries) console.log(formatNetEntry(e));
      }
      return 0;
    } catch (err) {
      printError(`network logs — ${err instanceof Error ? err.message : String(err)}`, opts);
      return 1;
    }
  }

  const { deviceId, platformPromise } = resolveSession(sessionName);
  try {
    const platform = await platformPromise;
    const port = await resolveMetroPort({ port: netOpts.port, deviceId, platform });
    const connectOpts = {
      port,
      deviceId,
      platform,
      targetIndex: netOpts.targetIndex,
      appId: netOpts.appId,
      pageId: netOpts.pageId,
    };
    let client = new MetroCdpClient();
    await client.connect(connectOpts);
    await client.evaluate<ShimResult>(INSTALL_SHIM_SCRIPT);
    if (netOpts.follow) {
      if (!opts.json) console.error('following network requests — Ctrl-C to stop');
      const code = await followEntries(
        async () => {
          const r = await client.evaluate<{ entries?: NetEntry[] }>(READ_SCRIPT(200));
          return (r.entries ?? []).map((e) => ({
            key: e.id,
            done: e.durationMs !== null || e.error !== null,
            line: formatShimEntry(e),
            value: e,
          }));
        },
        opts,
        netOpts,
        async () => {
          if (client.isConnected()) return;
          // A reload drops the debugger and the shim with it.
          client.close();
          client = new MetroCdpClient();
          await client.connect(connectOpts);
          await client.evaluate<ShimResult>(INSTALL_SHIM_SCRIPT);
        }
      );
      client.close();
      return code;
    }
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
      for (const e of entries) console.log(formatShimEntry(e));
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

  // Web: issue via the browser context (shares the page's cookies/session).
  const web = await webDriverFor(sessionName);
  if (web) {
    try {
      const result = await web.networkRequest(url, { method, headers, body });
      if (opts.json) printData(result, opts);
      else {
        if (result.error) console.error(`error: ${result.error}`);
        console.log(`status: ${result.status ?? 'n/a'}`);
        for (const [k, v] of Object.entries(result.headers ?? {})) console.log(`${k}: ${v}`);
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

  const { deviceId, platformPromise } = resolveSession(sessionName);
  try {
    const platform = await platformPromise;
    const port = await resolveMetroPort({ port: reqOpts.port, deviceId, platform });
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
