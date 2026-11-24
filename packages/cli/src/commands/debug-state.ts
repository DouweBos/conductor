/**
 * `debug navigation|navigate|query-cache|store|bridge|watch` — read and poke
 * React app state over the debugger, with no in-app dependency.
 */
import { printError, printData, OutputOptions } from '../output.js';
import { MetroCdpClient, resolveMetroPort } from '../drivers/metro-cdp.js';
import { detectPlatform } from '../drivers/bootstrap.js';
import { getDriver } from '../runner.js';
import { WebDriver } from '../drivers/web.js';
import {
  DEFAULT_BRIDGE_GLOBALS,
  makeBridgeCallScript,
  makeBridgeListScript,
  makeExprScript,
  makeNavigateScript,
  makeNavigationScript,
  makeQueryCacheScript,
  makeStoreScript,
  makeStoreWriteScript,
  parseStateReply,
  QueryCacheScriptOpts,
} from '../drivers/metro-state-scripts.js';
import { diffJson, formatChange } from '../drivers/json-diff.js';
import type { DebugOptions } from './debug.js';

export const HELP = `  debug navigation [--full]            Current React Navigation / expo-router route (--full: whole state)
  debug navigate <route> [--params J]  Navigate via the app's navigation container
  debug query-cache                    TanStack Query cache: key, status, observers, age
    --key <substr> / --grep <value>    Filter by query key / find a value inside cached data
    --data / --path <p> / --summary    Include data, project a sub-path (a.b[0]), or keys→types only
  debug store [<name>]                 List stores (Redux, __CONDUCTOR_STORES__ Zustand, bridge) or read one
    --path <p> / --summary             Project a sub-path / keys→types only
    --set <json> / --dispatch <json>   Merge into a Zustand/bridge store / dispatch a Redux action
  debug bridge list                    Methods on the app's bridge global (default __conductorBridge)
  debug bridge call <method> [args…]   Call a bridge method (JSON args), await and print the result
    --bridge <global>                  Bridge global name (or CONDUCTOR_BRIDGE_GLOBAL)
  debug watch <navigation|query-cache|store <name>|expr <js>>
                                       Poll and print changes as they happen
    --interval <ms> / --duration <s>   Poll interval (default 500) / stop after N seconds
    --max-bytes <n>                    Reply size cap before values are summarized (default 100000)`;

export interface StateCommonOptions extends DebugOptions {
  maxBytes?: number;
  depth?: number;
  bridge?: string;
}

interface ScriptRunner {
  run(script: string): Promise<unknown>;
  close(): void;
  connected(): boolean;
  /** Re-attach after the debugger dropped (Metro reload, tvOS navigation). */
  reconnect(): Promise<void>;
}

async function openRunner(sessionName: string, o: DebugOptions): Promise<ScriptRunner> {
  const hasDevice = !!sessionName && sessionName !== 'default';
  const platform = hasDevice ? await detectPlatform(sessionName).catch(() => undefined) : undefined;

  if (platform === 'web') {
    const driver = await getDriver(sessionName);
    if (driver instanceof WebDriver) {
      return {
        async run(script) {
          const { result, error } = await driver.evaluate(script);
          if (error) throw new Error(error);
          return result;
        },
        close() {},
        connected: () => true,
        async reconnect() {},
      };
    }
  }

  const deviceId = hasDevice ? sessionName : undefined;
  const port = await resolveMetroPort({ port: o.port, deviceId, platform });
  const connectOpts = {
    port,
    deviceId,
    platform,
    targetIndex: o.targetIndex,
    appId: o.appId,
    pageId: o.pageId,
  };
  let client = new MetroCdpClient();
  await client.connect(connectOpts);
  return {
    run: (script) => client.evaluate(script),
    close: () => client.close(),
    connected: () => client.isConnected(),
    async reconnect() {
      client.close();
      client = new MetroCdpClient();
      await client.connect(connectOpts);
    },
  };
}

async function runOnce<T>(sessionName: string, o: DebugOptions, script: string): Promise<T> {
  const runner = await openRunner(sessionName, o);
  try {
    return parseStateReply<T>(await runner.run(script));
  } finally {
    runner.close();
  }
}

export function bridgeGlobal(o: { bridge?: string }): string {
  return o.bridge || process.env.CONDUCTOR_BRIDGE_GLOBAL || '__conductorBridge';
}

function bridgeCandidates(o: { bridge?: string }): string[] {
  const explicit = o.bridge || process.env.CONDUCTOR_BRIDGE_GLOBAL;
  return explicit ? [explicit, ...DEFAULT_BRIDGE_GLOBALS] : DEFAULT_BRIDGE_GLOBALS;
}

const pretty = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v, null, 2));

function fail(cmd: string, err: unknown, opts: OutputOptions): number {
  printError(`debug ${cmd} — ${err instanceof Error ? err.message : String(err)}`, opts);
  return 1;
}

function printTruncation(r: { truncated?: { bytes: number; hint: string } }): void {
  if (r.truncated) {
    console.log(`\n(truncated: ${r.truncated.bytes} bytes — ${r.truncated.hint})`);
  }
}

// ── navigation ────────────────────────────────────────────────────────────────

interface NavSnapshot {
  name: string | null;
  params: unknown;
  key: string | null;
  path: string[];
  url?: string;
  containers: number;
  ready: boolean | null;
  state?: unknown;
  truncated?: { bytes: number; hint: string };
}

function printNav(r: NavSnapshot): void {
  console.log(`route:  ${r.name ?? '(none)'}`);
  console.log(`path:   ${r.path.join(' › ') || '(empty)'}`);
  if (r.url) console.log(`url:    ${r.url}`);
  if (r.params && Object.keys(r.params as object).length) {
    console.log(`params: ${JSON.stringify(r.params)}`);
  }
  if (r.containers > 1)
    console.log(`(${r.containers} navigation containers; showing the outermost)`);
  if (r.state !== undefined) console.log(`\n${pretty(r.state)}`);
  printTruncation(r);
}

export async function debugNavigation(
  opts: OutputOptions,
  sessionName: string,
  o: StateCommonOptions & { full?: boolean }
): Promise<number> {
  try {
    const r = await runOnce<NavSnapshot>(
      sessionName,
      o,
      makeNavigationScript({ full: o.full, maxBytes: o.maxBytes })
    );
    if (opts.json) printData(r, opts);
    else printNav(r);
    return 0;
  } catch (err) {
    return fail('navigation', err, opts);
  }
}

export async function debugNavigate(
  route: string,
  opts: OutputOptions,
  sessionName: string,
  o: StateCommonOptions & { params?: string }
): Promise<number> {
  if (!route) {
    printError('debug navigate requires a route name', opts);
    return 1;
  }
  let params: unknown;
  if (o.params !== undefined) {
    try {
      params = JSON.parse(o.params);
    } catch {
      printError('debug navigate — --params must be JSON', opts);
      return 1;
    }
  }
  try {
    const r = await runOnce<{ from: NavSnapshot; to: NavSnapshot }>(
      sessionName,
      o,
      makeNavigateScript(route, params)
    );
    if (opts.json) printData(r, opts);
    else {
      console.log(`${r.from.path.join(' › ')}  →  ${r.to.path.join(' › ')}`);
      if (r.to.name !== route) {
        console.log(
          `(focused route is "${r.to.name}", not "${route}" — unknown route or a nested navigator)`
        );
      }
    }
    return 0;
  } catch (err) {
    return fail('navigate', err, opts);
  }
}

// ── query cache ───────────────────────────────────────────────────────────────

interface QueryRow {
  queryHash: string;
  status: string | null;
  fetchStatus: string | null;
  dataUpdatedAt: number | null;
  error: string | null;
  observers: number;
  stale: boolean | null;
  data: unknown;
  matches?: Array<{ path: string; value: unknown }>;
  missing?: string;
}

interface QueryCacheReply {
  total: number;
  matched: number;
  queries: QueryRow[];
  truncated?: { bytes: number; hint: string };
}

function age(ts: number | null): string {
  if (!ts) return '-';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

export async function debugQueryCache(
  opts: OutputOptions,
  sessionName: string,
  o: StateCommonOptions & QueryCacheScriptOpts
): Promise<number> {
  try {
    const r = await runOnce<QueryCacheReply>(
      sessionName,
      o,
      makeQueryCacheScript({ ...o, limit: o.limit ?? 200 })
    );
    if (opts.json) {
      printData(r, opts);
      return 0;
    }
    const withData = o.data || o.path !== undefined || o.summary;
    for (const q of r.queries) {
      const status = `${q.status ?? '?'}/${q.fetchStatus ?? '?'}`;
      const flags = [q.stale ? 'stale' : '', q.error ? `error=${JSON.stringify(q.error)}` : '']
        .filter(Boolean)
        .join(' ');
      console.log(
        `${status.padEnd(16)} obs=${String(q.observers).padEnd(3)} age=${age(q.dataUpdatedAt).padEnd(5)} ${q.queryHash}${flags ? `  ${flags}` : ''}`
      );
      for (const m of q.matches ?? [])
        console.log(`    match ${m.path || '(root)'} = ${JSON.stringify(m.value)}`);
      if (q.missing) console.log(`    ${q.missing}`);
      else if (withData) console.log(pretty(q.data).replace(/^/gm, '    '));
    }
    console.log(`\n${r.queries.length} shown / ${r.matched} matched / ${r.total} queries in cache`);
    printTruncation(r);
    return 0;
  } catch (err) {
    return fail('query-cache', err, opts);
  }
}

// ── stores ────────────────────────────────────────────────────────────────────

export async function debugStore(
  name: string | undefined,
  opts: OutputOptions,
  sessionName: string,
  o: StateCommonOptions & { path?: string; summary?: boolean; set?: string; dispatch?: string }
): Promise<number> {
  const bridges = bridgeCandidates(o);
  try {
    if (o.set !== undefined || o.dispatch !== undefined) {
      if (!name) {
        printError('debug store — --set/--dispatch need a store name', opts);
        return 1;
      }
      let set: unknown;
      let dispatch: unknown;
      try {
        if (o.set !== undefined) set = JSON.parse(o.set);
        if (o.dispatch !== undefined) dispatch = JSON.parse(o.dispatch);
      } catch {
        printError('debug store — --set/--dispatch must be JSON', opts);
        return 1;
      }
      const r = await runOnce<Record<string, unknown>>(
        sessionName,
        o,
        makeStoreWriteScript({ name, set, dispatch, bridges })
      );
      if (r.set === false) throw new Error(`store "${name}" rejected the update`);
      if (opts.json) printData(r, opts);
      else console.log(o.dispatch !== undefined ? `dispatched to ${name}` : `updated ${name}`);
      return 0;
    }

    const r = await runOnce<{
      stores?: Array<{ name: string; kind: string; shape: string | null; via: string | null }>;
      name?: string;
      kind?: string;
      value?: unknown;
      truncated?: { bytes: number; hint: string };
    }>(
      sessionName,
      o,
      makeStoreScript({
        name,
        path: o.path,
        summary: o.summary,
        depth: o.depth,
        maxBytes: o.maxBytes,
        bridges,
      })
    );
    if (opts.json) {
      printData(r, opts);
      return 0;
    }
    if (r.stores) {
      if (r.stores.length === 0) {
        console.log(
          'No stores found. Redux is found automatically; register Zustand stores with\n' +
            '  globalThis.__CONDUCTOR_STORES__ = { auth: useAuthStore, … }'
        );
      }
      for (const s of r.stores) {
        console.log(
          `${s.name.padEnd(28)} ${s.kind.padEnd(8)} ${s.shape ?? ''}${s.via ? `  (via ${s.via})` : ''}`
        );
      }
      return 0;
    }
    console.log(pretty(r.value));
    printTruncation(r);
    return 0;
  } catch (err) {
    return fail('store', err, opts);
  }
}

// ── bridge ────────────────────────────────────────────────────────────────────

/** Positional CLI args → JSON values; anything that isn't JSON stays a string. */
export function parseBridgeArgs(raw: unknown[]): unknown[] {
  return raw.map((a) => {
    const s = String(a);
    try {
      return JSON.parse(s);
    } catch {
      return s;
    }
  });
}

export async function debugBridge(
  sub: string,
  rest: unknown[],
  opts: OutputOptions,
  sessionName: string,
  o: StateCommonOptions
): Promise<number> {
  const global = bridgeGlobal(o);
  try {
    if (sub === 'list' || sub === '') {
      const r = await runOnce<{
        global: string;
        methods: Array<{ name: string; arity: number }>;
        props: Array<{ name: string; type: string }>;
      }>(sessionName, o, makeBridgeListScript(global));
      if (opts.json) printData(r, opts);
      else {
        console.log(`globalThis.${r.global}: ${r.methods.length} methods`);
        for (const m of r.methods) console.log(`  ${m.name}(${m.arity ? `${m.arity} args` : ''})`);
        if (r.props.length) {
          console.log('props:');
          for (const p of r.props) console.log(`  ${p.name}: ${p.type}`);
        }
      }
      return 0;
    }
    if (sub === 'call') {
      const method = rest[0] !== undefined ? String(rest[0]) : '';
      if (!method) {
        printError('debug bridge call requires a method name', opts);
        return 1;
      }
      const r = await runOnce<{ result: unknown; truncated?: { bytes: number; hint: string } }>(
        sessionName,
        o,
        makeBridgeCallScript(global, method, parseBridgeArgs(rest.slice(1)), o)
      );
      if (opts.json) printData(r, opts);
      else {
        console.log(r.result === undefined ? '(undefined)' : pretty(r.result));
        printTruncation(r);
      }
      return 0;
    }
    printError('Usage: conductor debug bridge <list|call> [method] [args…]', opts);
    return 1;
  } catch (err) {
    return fail('bridge', err, opts);
  }
}

// ── watch ─────────────────────────────────────────────────────────────────────

export interface WatchOptions extends StateCommonOptions {
  interval?: number;
  duration?: number;
  full?: boolean;
  path?: string;
  summary?: boolean;
  key?: string;
  data?: boolean;
}

/** Build the snapshot script for a watch target, or an error message. */
export function watchScript(
  kind: string,
  args: string[],
  o: WatchOptions
): { script: string; label: string } | { error: string } {
  switch (kind) {
    case 'navigation':
    case 'nav':
      return {
        script: makeNavigationScript({ full: o.full, maxBytes: o.maxBytes }),
        label: 'navigation',
      };
    case 'query-cache':
    case 'queries':
      return {
        script: makeQueryCacheScript({
          key: o.key,
          path: o.path,
          summary: o.summary,
          data: o.data,
          maxBytes: o.maxBytes,
        }),
        label: 'query-cache',
      };
    case 'store': {
      if (!args[0]) return { error: 'debug watch store needs a store name' };
      return {
        script: makeStoreScript({
          name: args[0],
          path: o.path,
          summary: o.summary,
          maxBytes: o.maxBytes,
          bridges: bridgeCandidates(o),
        }),
        label: `store ${args[0]}`,
      };
    }
    case 'expr': {
      const expr = args.join(' ');
      if (!expr) return { error: 'debug watch expr needs a JS expression' };
      return { script: makeExprScript(expr, { maxBytes: o.maxBytes }), label: 'expr' };
    }
    default:
      return {
        error: 'Usage: conductor debug watch <navigation|query-cache|store <name>|expr <js>>',
      };
  }
}

export async function debugWatch(
  kind: string,
  args: string[],
  opts: OutputOptions,
  sessionName: string,
  o: WatchOptions
): Promise<number> {
  const built = watchScript(kind, args, o);
  if ('error' in built) {
    printError(built.error, opts);
    return 1;
  }
  const interval = Math.max(100, o.interval ?? 500);
  let runner: ScriptRunner;
  try {
    runner = await openRunner(sessionName, o);
  } catch (err) {
    return fail('watch', err, opts);
  }

  let stopped = false;
  const stop = (): void => {
    stopped = true;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const deadline = o.duration !== undefined ? Date.now() + o.duration * 1000 : Infinity;

  const emit = (line: Record<string, unknown>): void => {
    if (opts.json) console.log(JSON.stringify(line));
  };

  let prev: unknown;
  let have = false;
  let lastError: string | null = null;
  let changes = 0;
  if (!opts.json) {
    console.log(`watching ${built.label} every ${interval}ms — Ctrl-C to stop`);
  }

  while (!stopped && Date.now() < deadline) {
    const started = Date.now();
    try {
      const value = parseStateReply(await runner.run(built.script));
      const ts = new Date().toISOString();
      if (lastError) {
        if (!opts.json) console.log(`${ts.slice(11, 23)}  (recovered)`);
        lastError = null;
      }
      if (!have) {
        have = true;
        emit({ ts, type: 'snapshot', target: built.label, value });
        if (!opts.json) console.log(`${ts.slice(11, 23)}  snapshot\n${pretty(value)}`);
      } else {
        const diff = diffJson(prev, value);
        if (diff.length) {
          changes++;
          emit({ ts, type: 'change', target: built.label, changes: diff });
          if (!opts.json) {
            for (const c of diff) console.log(`${ts.slice(11, 23)}  ${formatChange(c)}`);
          }
        }
      }
      prev = value;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg !== lastError) {
        emit({ ts: new Date().toISOString(), type: 'error', target: built.label, error: msg });
        if (!opts.json) console.error(`error: ${msg}`);
        lastError = msg;
      }
      if (!runner.connected()) await runner.reconnect().catch(() => {});
    }
    const wait = interval - (Date.now() - started);
    if (wait > 0) await new Promise((r) => setTimeout(r, Math.min(wait, deadline - Date.now())));
  }

  runner.close();
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
  if (!opts.json) console.log(`\nstopped — ${changes} change(s)`);
  return 0;
}
