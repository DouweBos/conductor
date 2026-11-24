/**
 * Bridge-free React state readers injected over CDP (`Runtime.evaluate`).
 *
 * Everything is found by walking the React fiber tree from the DevTools hook,
 * so the app needs no extra dependency: React Navigation's container ref,
 * TanStack Query's `QueryClient`, react-redux's store. Zustand has no
 * discoverable registry, so apps opt in with `globalThis.__CONDUCTOR_STORES__`
 * (or expose `listStores`/`getStore`/`setStore` on a bridge global).
 *
 * Each script resolves to a JSON string, size-capped in-app so a huge cache
 * doesn't stall the CDP socket.
 */

/** Bridge globals probed for `listStores` when no explicit one is given. */
export const DEFAULT_BRIDGE_GLOBALS = ['__conductorBridge', '__plexMcpBridge'];

export const DEFAULT_MAX_BYTES = 100_000;

/**
 * Shared in-app helpers. Plain function declarations so tests can load them in
 * Node with `new Function` and exercise the same code the app runs.
 */
export const STATE_RUNTIME = String.raw`
function isObj(v) { return v !== null && typeof v === 'object'; }

function ser(value, maxDepth) {
  var MAX = typeof maxDepth === 'number' ? maxDepth : 8;
  var seen = [];
  function inner(v, d) {
    if (v === null || v === undefined) return v;
    var t = typeof v;
    if (t === 'function') return '[Function' + (v.name ? ': ' + v.name : '') + ']';
    if (t === 'symbol') return v.toString();
    if (t === 'bigint') return v.toString() + 'n';
    if (t === 'number') return isFinite(v) ? v : String(v);
    if (t !== 'object') return v;
    if (d > MAX) return '[MaxDepth]';
    if (v instanceof Date) return { __type: 'Date', value: isNaN(v.getTime()) ? 'Invalid Date' : v.toISOString() };
    if (v instanceof Error) return { __type: 'Error', name: v.name, message: v.message, stack: v.stack };
    if (v instanceof RegExp) return { __type: 'RegExp', value: String(v) };
    if (typeof v.$$typeof === 'symbol' || isObj(v._reactInternals) || isObj(v._reactInternalInstance)) return '[ReactNode]';
    if (typeof v._isReanimatedSharedValue === 'boolean' || typeof v.__isReanimatedSharedValue === 'boolean') {
      try { return { __type: 'SharedValue', value: inner(v.value, d + 1) }; } catch (e) { return '[SharedValue]'; }
    }
    if (seen.indexOf(v) !== -1) return '[Circular]';
    seen.push(v);
    try {
      if (v instanceof Map) {
        var entries = [];
        v.forEach(function(val, k) { entries.push([inner(k, d + 1), inner(val, d + 1)]); });
        return { __type: 'Map', size: v.size, entries: entries };
      }
      if (v instanceof Set) {
        var vals = [];
        v.forEach(function(val) { vals.push(inner(val, d + 1)); });
        return { __type: 'Set', size: v.size, values: vals };
      }
      if (Array.isArray(v)) return v.map(function(x) { var s = inner(x, d + 1); return s === undefined ? null : s; });
      var out = {};
      var keys = Object.keys(v);
      for (var i = 0; i < keys.length; i++) {
        var s;
        try { s = inner(v[keys[i]], d + 1); } catch (e) { s = '[Threw: ' + String(e && e.message || e) + ']'; }
        if (s !== undefined) out[keys[i]] = s;
      }
      return out;
    } finally {
      seen.pop();
    }
  }
  return inner(value, 0);
}

// "a.b[0].c", 'a["x.y"]' — walks Maps and serialized { __type: 'Map' } alike.
function parsePath(path) {
  var segs = [], re = /\[\s*(?:"([^"]*)"|'([^']*)'|([^\]]*))\s*\]|([^.[\]]+)/g, m;
  while ((m = re.exec(path)) !== null) {
    var seg = m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3].trim() : m[4];
    if (seg !== undefined && seg !== '') segs.push(seg);
  }
  return segs;
}

function project(value, path) {
  if (!path) return { found: true, value: value };
  var segs = parsePath(path), cur = value;
  for (var i = 0; i < segs.length; i++) {
    var seg = segs[i];
    if (cur === null || cur === undefined) return { found: false, at: segs.slice(0, i).join('.') };
    if (cur instanceof Map) {
      if (cur.has(seg)) { cur = cur.get(seg); continue; }
      var n = Number(seg);
      if (!isNaN(n) && cur.has(n)) { cur = cur.get(n); continue; }
      return { found: false, at: segs.slice(0, i).join('.') };
    }
    if (isObj(cur) && cur.__type === 'Map' && Array.isArray(cur.entries)) {
      var hit = cur.entries.filter(function(e) { return String(e[0]) === seg; })[0];
      if (!hit) return { found: false, at: segs.slice(0, i).join('.') };
      cur = hit[1];
      continue;
    }
    if (!(seg in Object(cur))) return { found: false, at: segs.slice(0, i).join('.') };
    cur = cur[seg];
  }
  return { found: true, value: cur };
}

function describeType(v) {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (Array.isArray(v)) return 'array(' + v.length + ')';
  if (v instanceof Map) return 'Map(' + v.size + ')';
  if (v instanceof Set) return 'Set(' + v.size + ')';
  if (v instanceof Date) return 'Date';
  if (typeof v === 'object') return 'object(' + Object.keys(v).length + ' keys)';
  return typeof v;
}

// Shallow key -> type overview, for stores too big to dump.
function summarize(v) {
  if (!isObj(v)) return v;
  if (Array.isArray(v)) return { __type: 'array', length: v.length, first: v.length ? describeType(v[0]) : null };
  if (v instanceof Map) { var mk = []; v.forEach(function(_, k) { if (mk.length < 50) mk.push(String(k)); }); return { __type: 'Map', size: v.size, keys: mk }; }
  var out = {}, keys = Object.keys(v);
  for (var i = 0; i < keys.length; i++) { try { out[keys[i]] = describeType(v[keys[i]]); } catch (e) { out[keys[i]] = 'unreadable'; } }
  return out;
}

// Paths whose key or primitive value contains needle (case-insensitive).
function search(value, needle, maxHits) {
  var hits = [], n = String(needle).toLowerCase(), limit = maxHits || 50;
  function walk(v, path, d) {
    if (hits.length >= limit || d > 12) return;
    if (v === null || v === undefined) return;
    if (typeof v !== 'object') {
      if (String(v).toLowerCase().indexOf(n) !== -1) hits.push({ path: path, value: v });
      return;
    }
    if (Array.isArray(v)) { for (var i = 0; i < v.length; i++) walk(v[i], path + '[' + i + ']', d + 1); return; }
    var keys = Object.keys(v);
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k], child = v[key], p = path ? path + '.' + key : key;
      if (key.toLowerCase().indexOf(n) !== -1 && hits.length < limit) hits.push({ path: p, key: true, value: isObj(child) ? describeType(child) : child });
      walk(child, p, d + 1);
    }
  }
  walk(value, '', 0);
  return hits;
}

// Swap an oversized field for its summary so the reply stays small.
function finalize(payload, field, raw, maxBytes) {
  var s = JSON.stringify(payload);
  if (!field || s.length <= maxBytes) return s;
  var bytes = s.length;
  payload[field] = summarize(raw);
  payload.truncated = { bytes: bytes, maxBytes: maxBytes, hint: 'narrow with --path, use --summary, or raise --max-bytes' };
  return JSON.stringify(payload);
}

function fiberName(f) {
  var t = f && f.type;
  if (!t) return null;
  if (typeof t === 'string') return t;
  if (typeof t === 'function') return t.displayName || t.name || null;
  if (typeof t === 'object') {
    if (t.displayName) return t.displayName;
    var inner = t.render || t.type;
    if (typeof inner === 'function') return inner.displayName || inner.name || null;
  }
  return null;
}

function fiberRoots() {
  var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__, out = [];
  if (!hook || typeof hook.getFiberRoots !== 'function') return out;
  var ids = [];
  if (hook.renderers && typeof hook.renderers.forEach === 'function') hook.renderers.forEach(function(_, id) { ids.push(id); });
  if (!ids.length) ids.push(1);
  for (var i = 0; i < ids.length; i++) {
    try { hook.getFiberRoots(ids[i]).forEach(function(r) { out.push(r); }); } catch (e) {}
  }
  return out;
}

// Pre-order walk, so outer providers come before nested ones.
function findFibers(pred, max) {
  var roots = fiberRoots(), out = [], visited = 0;
  for (var r = 0; r < roots.length; r++) {
    var stack = [roots[r].current];
    while (stack.length && visited < 200000) {
      var f = stack.pop(); visited++;
      if (!f) continue;
      var hit;
      try { hit = pred(f); } catch (e) { hit = null; }
      if (hit) { out.push(hit); if (out.length >= (max || 1)) return out; }
      if (f.sibling) stack.push(f.sibling);
      if (f.child) stack.push(f.child);
    }
  }
  return out;
}

function uniq(list) { var out = []; for (var i = 0; i < list.length; i++) if (out.indexOf(list[i]) === -1) out.push(list[i]); return out; }

function noReactError() {
  return globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__ ? 'no React fiber roots yet; is the app rendered?' : 'no React DevTools hook; is this a dev build?';
}

// ── React Navigation ─────────────────────────────────────────────────────────
function isNavRef(o) { return isObj(o) && typeof o.getRootState === 'function' && typeof o.dispatch === 'function'; }
function isNavState(s) { return isObj(s) && Array.isArray(s.routes) && typeof s.key === 'string'; }

// The container ref is provided via NavigationContainerRefContext (v6+) and
// exposed through BaseNavigationContainer's ref (v5).
function findNavRefs() {
  return uniq(findFibers(function(f) {
    var p = f.memoizedProps;
    if (p && isNavRef(p.value)) return p.value;
    if (fiberName(f) === 'BaseNavigationContainer' && f.ref && isNavRef(f.ref.current)) return f.ref.current;
    return null;
  }, 20));
}

function findNavStateFromHooks() {
  var hits = findFibers(function(f) {
    if (fiberName(f) !== 'BaseNavigationContainer') return null;
    var h = f.memoizedState;
    while (h) { if (isNavState(h.memoizedState)) return h.memoizedState; h = h.next; }
    return null;
  }, 1);
  return hits[0] || null;
}

function focusedRoute(state) {
  var path = [], route = null, s = state;
  while (isNavState(s) && s.routes.length) {
    var idx = typeof s.index === 'number' ? s.index : s.routes.length - 1;
    route = s.routes[idx];
    if (!route) break;
    path.push(route.name);
    s = route.state;
  }
  return { route: route, path: path };
}

function navigationSnapshot(full) {
  var refs = findNavRefs(), ref = refs[0] || null, state = null;
  if (ref) { try { state = ref.getRootState(); } catch (e) {} }
  if (!state) state = findNavStateFromHooks();
  if (!state) return { error: fiberRoots().length ? 'no React Navigation container found' : noReactError() };
  var f = focusedRoute(state), r = f.route || {};
  var out = {
    name: r.name || null,
    params: r.params === undefined ? null : ser(r.params, 6),
    key: r.key || null,
    path: f.path,
    containers: Math.max(refs.length, 1),
    ready: ref && typeof ref.isReady === 'function' ? !!ref.isReady() : null,
  };
  if (typeof r.path === 'string') out.url = r.path;
  if (full) out.state = ser(state, 30);
  return out;
}

// ── TanStack Query ───────────────────────────────────────────────────────────
function isQueryClient(o) { return isObj(o) && typeof o.getQueryCache === 'function'; }

function findQueryClient() {
  var g = globalThis.__CONDUCTOR_QUERY_CLIENT__ || globalThis.__TANSTACK_QUERY_CLIENT__;
  if (isQueryClient(g)) return g;
  var hits = findFibers(function(f) {
    var p = f.memoizedProps;
    if (!p) return null;
    if (isQueryClient(p.client)) return p.client;
    if (isQueryClient(p.value)) return p.value;
    return null;
  }, 1);
  return hits[0] || null;
}

function queryMeta(q) {
  var st = q.state || {};
  var observers = typeof q.getObserversCount === 'function' ? q.getObserversCount() : (q.observers || []).length;
  var stale = null;
  try { if (typeof q.isStale === 'function') stale = q.isStale(); } catch (e) {}
  return {
    queryHash: q.queryHash,
    queryKey: ser(q.queryKey, 6),
    status: st.status || null,
    fetchStatus: st.fetchStatus || null,
    dataUpdatedAt: st.dataUpdatedAt || null,
    errorUpdatedAt: st.errorUpdatedAt || null,
    error: st.error ? String((st.error && st.error.message) || st.error) : null,
    observers: observers,
    stale: stale,
    data: describeType(st.data),
  };
}

function queryCacheSnapshot(o) {
  var client = findQueryClient();
  if (!client) return { error: fiberRoots().length ? 'no QueryClientProvider found (or set globalThis.__CONDUCTOR_QUERY_CLIENT__)' : noReactError() };
  var all = client.getQueryCache().getAll();
  var key = o.key ? String(o.key).toLowerCase() : null;
  var out = [];
  for (var i = 0; i < all.length; i++) {
    var q = all[i];
    if (key && String(q.queryHash).toLowerCase().indexOf(key) === -1) continue;
    var m = queryMeta(q), data = q.state ? q.state.data : undefined;
    if (o.grep) {
      var hits = search(ser(data, 12), o.grep, 20);
      if (!hits.length) continue;
      m.matches = hits;
    }
    if (o.data || o.path || o.summary) {
      var pr = project(data, o.path);
      if (!pr.found) m.missing = 'path not found past "' + pr.at + '"';
      else m.data = o.summary ? summarize(pr.value) : ser(pr.value, o.depth);
    }
    out.push(m);
  }
  out.sort(function(a, b) { return (b.dataUpdatedAt || 0) - (a.dataUpdatedAt || 0); });
  var total = out.length;
  if (o.limit && out.length > o.limit) out = out.slice(0, o.limit);
  return { total: all.length, matched: total, queries: out };
}

// ── Stores ───────────────────────────────────────────────────────────────────
function isReduxStore(s) { return isObj(s) && typeof s.getState === 'function' && typeof s.dispatch === 'function' && typeof s.subscribe === 'function'; }
function isGetStateStore(s) { return (isObj(s) || typeof s === 'function') && typeof s.getState === 'function'; }

function findBridge(names, method) {
  for (var i = 0; i < names.length; i++) {
    var b = names[i] && globalThis[names[i]];
    if (b && typeof b[method] === 'function') return { name: names[i], bridge: b };
  }
  return null;
}

function listStoreEntries(bridgeNames) {
  var out = [];
  var redux = findFibers(function(f) {
    var p = f.memoizedProps;
    if (!p) return null;
    if (isReduxStore(p.store)) return p.store;
    if (isObj(p.value) && isReduxStore(p.value.store)) return p.value.store;
    return null;
  }, 1)[0];
  if (redux) out.push({ name: 'redux', kind: 'redux', store: redux });
  var reg = globalThis.__CONDUCTOR_STORES__;
  if (isObj(reg)) {
    Object.keys(reg).forEach(function(name) {
      if (isGetStateStore(reg[name])) out.push({ name: name, kind: 'zustand', store: reg[name] });
    });
  }
  var b = findBridge(bridgeNames, 'listStores');
  if (b) {
    var metas = [];
    try { metas = b.bridge.listStores() || []; } catch (e) {}
    for (var i = 0; i < metas.length; i++) {
      var name = typeof metas[i] === 'string' ? metas[i] : metas[i] && metas[i].name;
      if (!name || out.some(function(e) { return e.name === name; })) continue;
      out.push({ name: name, kind: 'bridge', bridge: b.bridge, bridgeName: b.name });
    }
  }
  return out;
}

function readStore(e) {
  if (e.kind === 'bridge') return e.bridge.getStore(e.name);
  return e.store.getState();
}

function storeSnapshot(o) {
  var entries = listStoreEntries(o.bridges);
  if (!o.name) {
    return {
      stores: entries.map(function(e) {
        var shape = null;
        try { shape = describeType(readStore(e)); } catch (err) {}
        return { name: e.name, kind: e.kind, shape: shape, via: e.bridgeName || null };
      }),
    };
  }
  var e = entries.filter(function(x) { return x.name === o.name; })[0];
  if (!e) return { error: 'no store named "' + o.name + '" (have: ' + (entries.map(function(x) { return x.name; }).join(', ') || 'none') + ')' };
  var state = readStore(e);
  var pr = project(state, o.path);
  if (!pr.found) return { error: 'path not found past "' + pr.at + '"', name: e.name };
  return { name: e.name, kind: e.kind, path: o.path || null, raw: pr.value, value: o.summary ? summarize(pr.value) : ser(pr.value, o.depth) };
}

function storeWrite(o) {
  var entries = listStoreEntries(o.bridges);
  var e = entries.filter(function(x) { return x.name === o.name; })[0];
  if (!e) return { error: 'no store named "' + o.name + '"' };
  if (o.dispatch !== undefined) {
    if (e.kind !== 'redux') return { error: '--dispatch only applies to Redux stores' };
    e.store.dispatch(o.dispatch);
    return { name: e.name, dispatched: true };
  }
  if (e.kind === 'redux') return { error: 'Redux state is read-only; use --dispatch <action json>' };
  if (e.kind === 'bridge') {
    if (typeof e.bridge.setStore !== 'function') return { error: 'bridge has no setStore' };
    return { name: e.name, set: !!e.bridge.setStore(e.name, o.set) };
  }
  if (typeof e.store.setState !== 'function') return { error: 'store has no setState' };
  var cur = e.store.getState();
  if (!isObj(cur)) e.store.setState(isObj(o.set) && 'value' in o.set ? o.set.value : o.set, true);
  else e.store.setState(o.set);
  return { name: e.name, set: true };
}
`;

interface CommonOpts {
  maxBytes?: number;
}

function wrap(body: string): string {
  return `(async function() {
${STATE_RUNTIME}
try {
${body}
} catch (e) {
  return JSON.stringify({ error: String((e && e.message) || e) });
}
})()`;
}

const bytes = (o: CommonOpts): number => o.maxBytes ?? DEFAULT_MAX_BYTES;

export function makeNavigationScript(o: CommonOpts & { full?: boolean } = {}): string {
  return wrap(`var r = navigationSnapshot(${!!o.full});
return finalize(r, ${o.full ? "'state'" : 'null'}, r.state, ${bytes(o)});`);
}

export function makeNavigateScript(route: string, params: unknown): string {
  return wrap(`var refs = findNavRefs(), ref = refs[0];
if (!ref) return JSON.stringify({ error: fiberRoots().length ? 'no React Navigation container found' : noReactError() });
if (typeof ref.isReady === 'function' && !ref.isReady()) return JSON.stringify({ error: 'navigation container is not ready yet' });
var before = navigationSnapshot(false);
if (typeof ref.navigate === 'function') ref.navigate(${JSON.stringify(route)}, ${JSON.stringify(params ?? undefined) ?? 'undefined'});
else ref.dispatch({ type: 'NAVIGATE', payload: { name: ${JSON.stringify(route)}, params: ${JSON.stringify(params ?? undefined) ?? 'undefined'} } });
await new Promise(function(r) { setTimeout(r, 300); });
return JSON.stringify({ from: before, to: navigationSnapshot(false) });`);
}

export interface QueryCacheScriptOpts extends CommonOpts {
  key?: string;
  grep?: string;
  path?: string;
  summary?: boolean;
  data?: boolean;
  limit?: number;
  depth?: number;
}

export function makeQueryCacheScript(o: QueryCacheScriptOpts = {}): string {
  const args = JSON.stringify({
    key: o.key,
    grep: o.grep,
    path: o.path,
    summary: !!o.summary,
    data: !!o.data,
    limit: o.limit,
    depth: o.depth ?? 8,
  });
  return wrap(`var r = queryCacheSnapshot(${args});
var s = JSON.stringify(r);
if (s.length > ${bytes(o)} && r.queries) {
  var n = s.length;
  r.queries.forEach(function(q) { if (q.data !== undefined) q.data = summarize(q.data); });
  r.truncated = { bytes: n, maxBytes: ${bytes(o)}, hint: 'narrow with --key/--path, use --summary, or raise --max-bytes' };
  s = JSON.stringify(r);
}
return s;`);
}

export interface StoreScriptOpts extends CommonOpts {
  name?: string;
  path?: string;
  summary?: boolean;
  depth?: number;
  bridges?: string[];
}

export function makeStoreScript(o: StoreScriptOpts = {}): string {
  const args = JSON.stringify({
    name: o.name,
    path: o.path,
    summary: !!o.summary,
    depth: o.depth ?? 8,
    bridges: o.bridges ?? DEFAULT_BRIDGE_GLOBALS,
  });
  return wrap(`var r = storeSnapshot(${args});
var raw = r.raw; delete r.raw;
return finalize(r, r.value !== undefined ? 'value' : null, raw, ${bytes(o)});`);
}

export function makeStoreWriteScript(o: {
  name: string;
  set?: unknown;
  dispatch?: unknown;
  bridges?: string[];
}): string {
  const args = JSON.stringify({
    name: o.name,
    set: o.set,
    dispatch: o.dispatch,
    bridges: o.bridges ?? DEFAULT_BRIDGE_GLOBALS,
  });
  return wrap(`return JSON.stringify(storeWrite(${args}));`);
}

export function makeBridgeListScript(global: string): string {
  return wrap(`var g = globalThis[${JSON.stringify(global)}];
if (!g) {
  var cands = Object.keys(globalThis).filter(function(k) { return /bridge|mcp/i.test(k) && globalThis[k] && typeof globalThis[k] === 'object'; });
  return JSON.stringify({ error: 'globalThis.' + ${JSON.stringify(global)} + ' is not defined' + (cands.length ? ' (found: ' + cands.join(', ') + ')' : '') });
}
var methods = [], props = [], seenKeys = {}, o = g;
while (o && o !== Object.prototype) {
  Object.getOwnPropertyNames(o).forEach(function(k) {
    if (seenKeys[k] || k === 'constructor') return;
    seenKeys[k] = true;
    var v; try { v = g[k]; } catch (e) { return; }
    if (typeof v === 'function') methods.push({ name: k, arity: v.length });
    else props.push({ name: k, type: describeType(v) });
  });
  o = Object.getPrototypeOf(o);
}
methods.sort(function(a, b) { return a.name < b.name ? -1 : 1; });
return JSON.stringify({ global: ${JSON.stringify(global)}, methods: methods, props: props });`);
}

export function makeBridgeCallScript(
  global: string,
  method: string,
  args: unknown[],
  o: CommonOpts & { depth?: number } = {}
): string {
  return wrap(`var g = globalThis[${JSON.stringify(global)}];
if (!g) return JSON.stringify({ error: 'globalThis.' + ${JSON.stringify(global)} + ' is not defined' });
var fn = g[${JSON.stringify(method)}];
if (typeof fn !== 'function') return JSON.stringify({ error: ${JSON.stringify(method)} + ' is not a function on ' + ${JSON.stringify(global)} });
var raw = await fn.apply(g, ${JSON.stringify(args)});
var r = { result: ser(raw, ${o.depth ?? 8}) };
return finalize(r, 'result', raw, ${bytes(o)});`);
}

/** Evaluates an arbitrary expression (awaiting promises) and serializes it. */
export function makeExprScript(expr: string, o: CommonOpts & { depth?: number } = {}): string {
  return wrap(`var raw = await (
${expr}
);
var r = { value: ser(raw, ${o.depth ?? 8}) };
return finalize(r, 'value', raw, ${bytes(o)});`);
}

/** Parse a script's JSON reply; a string `error` field becomes a thrown Error. */
export function parseStateReply<T = Record<string, unknown>>(reply: unknown): T {
  if (typeof reply !== 'string') throw new Error(`unexpected reply from app: ${String(reply)}`);
  const parsed = JSON.parse(reply) as T & { error?: unknown };
  if (typeof parsed.error === 'string') throw new Error(parsed.error);
  return parsed;
}
