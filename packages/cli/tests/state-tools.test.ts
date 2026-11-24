/**
 * Tests for the bridge-free React state readers, `debug watch` diffing, the
 * launch-timing parser and physical-device syslog parsing.
 *
 * The in-app scripts run here in Node against a fake fiber tree, so this is
 * the same code the app evaluates.
 */
import fs from 'fs';
import path from 'path';
import { TestSuite, assert } from './runner.js';
import {
  STATE_RUNTIME,
  makeNavigationScript,
  makeNavigateScript,
  makeQueryCacheScript,
  makeStoreScript,
  makeStoreWriteScript,
  makeBridgeListScript,
  makeBridgeCallScript,
  makeExprScript,
  parseStateReply,
} from '../src/drivers/metro-state-scripts.js';
import { diffJson, formatChange } from '../src/drivers/json-diff.js';
import { parseBridgeArgs, watchScript } from '../src/commands/debug-state.js';
import {
  parseAmStart,
  parseAndroidLaunch,
  parseLogcatLine,
  parsePlusDuration,
  buildMarks,
  summariseLaunchRuns,
  compileMarkRegex,
  LaunchRun,
} from '../src/commands/profile-launch.js';
import { parseSyslogLine } from '../src/drivers/log-sources/ios.js';

export const stateTools = new TestSuite('state-tools');

type Rt = {
  ser: (v: unknown, d?: number) => unknown;
  project: (v: unknown, p?: string) => { found: boolean; value?: unknown; at?: string };
  parsePath: (p: string) => string[];
  summarize: (v: unknown) => unknown;
  search: (v: unknown, n: string, max?: number) => Array<{ path: string; value: unknown }>;
  finalize: (p: Record<string, unknown>, f: string | null, raw: unknown, max: number) => string;
};

const rt = new Function(
  `${STATE_RUNTIME}; return { ser, project, parsePath, summarize, search, finalize };`
)() as Rt;

const g = globalThis as Record<string, unknown>;

async function runScript<T = Record<string, unknown>>(script: string): Promise<T> {
  return parseStateReply<T>(await (0, eval)(script));
}

// ── Fake React app ────────────────────────────────────────────────────────────

interface Fiber {
  type: unknown;
  memoizedProps?: Record<string, unknown> | null;
  memoizedState?: unknown;
  ref?: unknown;
  child?: Fiber | null;
  sibling?: Fiber | null;
}

function chain(...fibers: Fiber[]): Fiber {
  for (let i = 0; i < fibers.length - 1; i++) fibers[i].child = fibers[i + 1];
  return fibers[0];
}

function makeApp() {
  let navState = {
    key: 'root',
    index: 0,
    routes: [
      {
        name: 'Tabs',
        key: 'tabs-1',
        state: {
          key: 'tabs',
          index: 1,
          routes: [
            { name: 'Home', key: 'home-1' },
            { name: 'Library', key: 'lib-1', params: { section: 4 } },
          ],
        },
      },
    ],
  };
  const navRef = {
    getRootState: () => navState,
    dispatch: () => {},
    isReady: () => true,
    navigate: (name: string, params?: unknown) => {
      navState = {
        ...navState,
        routes: [...navState.routes, { name, key: `${name}-2`, params } as never],
        index: navState.routes.length,
      };
    },
  };
  const queries = [
    {
      queryHash: '["user",1]',
      queryKey: ['user', 1],
      state: {
        status: 'success',
        fetchStatus: 'idle',
        dataUpdatedAt: 2000,
        data: { name: 'Ada', items: [{ title: 'Needle in data' }] },
      },
      getObserversCount: () => 2,
      isStale: () => false,
    },
    {
      queryHash: '["hubs"]',
      queryKey: ['hubs'],
      state: { status: 'pending', fetchStatus: 'fetching', dataUpdatedAt: 0, data: undefined },
      getObserversCount: () => 0,
      isStale: () => true,
    },
  ];
  const queryClient = { getQueryCache: () => ({ getAll: () => queries }) };
  let reduxState = { session: { user: 'ada' }, count: 1 };
  const redux = {
    getState: () => reduxState,
    dispatch: (a: { type: string }) => {
      if (a.type === 'inc') reduxState = { ...reduxState, count: reduxState.count + 1 };
    },
    subscribe: () => () => {},
  };

  const root = chain(
    { type: 'HostRoot', memoizedProps: null },
    { type: function ReduxProvider() {}, memoizedProps: { store: redux } },
    { type: function QueryClientProvider() {}, memoizedProps: { client: queryClient } },
    { type: { $$typeof: Symbol.for('react.context') }, memoizedProps: { value: navRef } },
    { type: function App() {}, memoizedProps: {} }
  );
  g.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    renderers: new Map([[1, {}]]),
    getFiberRoots: () => new Set([{ current: root }]),
  };
  let zState = { theme: 'dark', volume: 3 };
  g.__CONDUCTOR_STORES__ = {
    prefs: {
      getState: () => zState,
      setState: (p: Record<string, unknown>) => (zState = { ...zState, ...p }),
    },
  };
  return { redux, queries };
}

function cleanupApp(): void {
  delete g.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  delete g.__CONDUCTOR_STORES__;
  delete g.__conductorBridge;
}

// ── Serializer / projection ───────────────────────────────────────────────────

stateTools.test('ser: cycles, functions, Map/Set/Date/Error, depth cap', async () => {
  const o: Record<string, unknown> = { fn: function named() {}, d: new Date(0) };
  o.self = o;
  o.m = new Map([['k', { v: 1 }]]);
  o.s = new Set([1, 2]);
  o.e = new Error('boom');
  o.deep = { a: { b: { c: 1 } } };
  o.big = BigInt(5);
  o.nan = NaN;
  const s = rt.ser(o, 2) as Record<string, any>;
  assert(s.fn === '[Function: named]', `fn: ${s.fn}`);
  assert(s.self === '[Circular]', `self: ${s.self}`);
  assert(s.d.__type === 'Date' && s.d.value === '1970-01-01T00:00:00.000Z', 'date');
  assert(s.m.__type === 'Map' && s.m.entries[0][0] === 'k', 'map');
  assert(s.s.__type === 'Set' && s.s.values.length === 2, 'set');
  assert(s.e.__type === 'Error' && s.e.message === 'boom', 'error');
  assert(s.deep.a.b === '[MaxDepth]', `depth: ${JSON.stringify(s.deep)}`);
  assert(s.big === '5n' && s.nan === 'NaN', 'bigint/nan');
});

stateTools.test('ser: shared (non-cyclic) references are not marked circular', async () => {
  const shared = { x: 1 };
  const s = rt.ser({ a: shared, b: shared }) as Record<string, unknown>;
  assert(JSON.stringify(s) === '{"a":{"x":1},"b":{"x":1}}', JSON.stringify(s));
});

stateTools.test('project: dots, brackets, quoted keys, Maps, misses', async () => {
  assert(
    JSON.stringify(rt.parsePath('a.b[0]["x.y"]')) === '["a","b","0","x.y"]',
    rt.parsePath('a.b[0]["x.y"]').join('|')
  );
  const v = { a: { b: [{ 'x.y': 7 }] }, m: new Map([['k', 3]]) };
  assert(rt.project(v, 'a.b[0]["x.y"]').value === 7, 'quoted');
  assert(rt.project(v, 'm.k').value === 3, 'map');
  assert(rt.project(rt.ser(v), 'm.k').value === 3, 'serialized map');
  const miss = rt.project(v, 'a.nope.z');
  assert(!miss.found && miss.at === 'a', JSON.stringify(miss));
});

stateTools.test('summarize and search', async () => {
  const s = rt.summarize({ a: [1, 2], b: { c: 1 }, d: 'x', e: null }) as Record<string, string>;
  assert(
    s.a === 'array(2)' && s.b === 'object(1 keys)' && s.d === 'string' && s.e === 'null',
    JSON.stringify(s)
  );
  const hits = rt.search({ list: [{ title: 'Hello World' }], hello: 1 }, 'hello');
  assert(
    hits.some((h) => h.path === 'list[0].title'),
    JSON.stringify(hits)
  );
  assert(
    hits.some((h) => h.path === 'hello'),
    'key match'
  );
});

stateTools.test('finalize swaps an oversized field for its summary', async () => {
  const raw = { big: 'x'.repeat(500), n: 1 };
  const out = JSON.parse(rt.finalize({ value: raw }, 'value', raw, 100));
  assert(out.truncated && out.truncated.bytes > 100, JSON.stringify(out.truncated));
  assert(out.value.big === 'string', JSON.stringify(out.value));
});

// ── Navigation / query cache / stores, end to end ─────────────────────────────

stateTools.test('navigation: focused nested route and path', async () => {
  makeApp();
  try {
    const r = await runScript<{ name: string; path: string[]; params: unknown; state?: unknown }>(
      makeNavigationScript()
    );
    assert(r.name === 'Library', `name ${r.name}`);
    assert(r.path.join('>') === 'Tabs>Library', r.path.join('>'));
    assert(JSON.stringify(r.params) === '{"section":4}', JSON.stringify(r.params));
    assert(r.state === undefined, 'no state without --full');
    const full = await runScript<{ state: { routes: unknown[] } }>(
      makeNavigationScript({ full: true })
    );
    assert(full.state.routes.length === 1, 'full state');
  } finally {
    cleanupApp();
  }
});

stateTools.test('navigation: v5 container ref on BaseNavigationContainer', async () => {
  const state = { key: 'r', index: 0, routes: [{ name: 'Only', key: 'o' }] };
  const ref = { current: { getRootState: () => state, dispatch: () => {} } };
  const root = chain(
    { type: 'HostRoot' },
    { type: function BaseNavigationContainer() {}, memoizedProps: {}, ref }
  );
  g.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    renderers: new Map([[1, {}]]),
    getFiberRoots: () => new Set([{ current: root }]),
  };
  try {
    const r = await runScript<{ name: string }>(makeNavigationScript());
    assert(r.name === 'Only', r.name);
  } finally {
    cleanupApp();
  }
});

stateTools.test('navigation: clear errors without React or a container', async () => {
  cleanupApp();
  let msg = '';
  try {
    await runScript(makeNavigationScript());
  } catch (e) {
    msg = (e as Error).message;
  }
  assert(msg.includes('DevTools hook'), msg);
});

stateTools.test('navigate dispatches through the container ref', async () => {
  makeApp();
  try {
    const r = await runScript<{ to: { name: string; params: unknown } }>(
      makeNavigateScript('Details', { id: 9 })
    );
    assert(r.to.name === 'Details', r.to.name);
    assert(JSON.stringify(r.to.params) === '{"id":9}', JSON.stringify(r.to.params));
  } finally {
    cleanupApp();
  }
});

stateTools.test('query-cache: metadata, key filter, grep, path', async () => {
  makeApp();
  try {
    const all = await runScript<{ total: number; queries: Array<Record<string, any>> }>(
      makeQueryCacheScript()
    );
    assert(all.total === 2 && all.queries.length === 2, JSON.stringify(all));
    assert(all.queries[0].queryHash === '["user",1]', 'sorted by dataUpdatedAt desc');
    assert(all.queries[0].observers === 2 && all.queries[0].data === 'object(2 keys)', 'meta');
    assert(all.queries[1].stale === true && all.queries[1].fetchStatus === 'fetching', 'stale');

    const byKey = await runScript<{ queries: Array<Record<string, any>> }>(
      makeQueryCacheScript({ key: 'USER', path: 'items[0].title' })
    );
    assert(
      byKey.queries.length === 1 && byKey.queries[0].data === 'Needle in data',
      JSON.stringify(byKey)
    );

    const grep = await runScript<{ queries: Array<Record<string, any>> }>(
      makeQueryCacheScript({ grep: 'needle' })
    );
    assert(grep.queries.length === 1, 'grep filters');
    assert(
      grep.queries[0].matches[0].path === 'items[0].title',
      JSON.stringify(grep.queries[0].matches)
    );
  } finally {
    cleanupApp();
  }
});

stateTools.test('store: lists Redux + __CONDUCTOR_STORES__ + bridge stores', async () => {
  makeApp();
  g.__conductorBridge = {
    listStores: () => [{ name: 'player' }, { name: 'prefs' }],
    getStore: (n: string) => (n === 'player' ? { playing: true } : null),
    setStore: () => true,
  };
  try {
    const r = await runScript<{ stores: Array<{ name: string; kind: string }> }>(makeStoreScript());
    const names = r.stores.map((s) => `${s.name}:${s.kind}`).join(',');
    assert(names === 'redux:redux,prefs:zustand,player:bridge', names);
    const player = await runScript<{ value: unknown }>(makeStoreScript({ name: 'player' }));
    assert(JSON.stringify(player.value) === '{"playing":true}', JSON.stringify(player.value));
    const sub = await runScript<{ value: unknown }>(
      makeStoreScript({ name: 'redux', path: 'session.user' })
    );
    assert(sub.value === 'ada', String(sub.value));
  } finally {
    cleanupApp();
  }
});

stateTools.test(
  'store: --set merges into Zustand, --dispatch hits Redux, Redux --set refused',
  async () => {
    const { redux } = makeApp();
    try {
      await runScript(makeStoreWriteScript({ name: 'prefs', set: { volume: 7 } }));
      const prefs = await runScript<{ value: Record<string, unknown> }>(
        makeStoreScript({ name: 'prefs' })
      );
      assert(prefs.value.volume === 7 && prefs.value.theme === 'dark', JSON.stringify(prefs.value));
      await runScript(makeStoreWriteScript({ name: 'redux', dispatch: { type: 'inc' } }));
      assert(redux.getState().count === 2, 'dispatched');
      let msg = '';
      try {
        await runScript(makeStoreWriteScript({ name: 'redux', set: { count: 0 } }));
      } catch (e) {
        msg = (e as Error).message;
      }
      assert(msg.includes('--dispatch'), msg);
    } finally {
      cleanupApp();
    }
  }
);

stateTools.test('bridge: list methods and await a call', async () => {
  g.__conductorBridge = { ping: async (x: number) => ({ pong: x }), version: '1' };
  try {
    const list = await runScript<{
      methods: Array<{ name: string }>;
      props: Array<{ name: string }>;
    }>(makeBridgeListScript('__conductorBridge'));
    assert(list.methods.map((m) => m.name).join() === 'ping', JSON.stringify(list));
    assert(list.props[0].name === 'version', 'props');
    const r = await runScript<{ result: unknown }>(
      makeBridgeCallScript('__conductorBridge', 'ping', parseBridgeArgs(['42']))
    );
    assert(JSON.stringify(r.result) === '{"pong":42}', JSON.stringify(r.result));
    let msg = '';
    try {
      await runScript(makeBridgeListScript('__missingBridge'));
    } catch (e) {
      msg = (e as Error).message;
    }
    assert(msg.includes('not defined') && msg.includes('__conductorBridge'), msg);
  } finally {
    cleanupApp();
  }
});

stateTools.test('parseBridgeArgs: JSON when possible, else string', async () => {
  const a = parseBridgeArgs([1, '{"a":1}', 'plain', 'true']);
  assert(JSON.stringify(a) === '[1,{"a":1},"plain",true]', JSON.stringify(a));
});

stateTools.test('expr script awaits promises and serializes', async () => {
  const r = await runScript<{ value: unknown }>(
    makeExprScript('Promise.resolve(new Map([["a", 1]]))')
  );
  assert((r.value as { __type: string }).__type === 'Map', JSON.stringify(r));
});

stateTools.test('watchScript validates targets', async () => {
  assert('error' in watchScript('store', [], {}), 'store needs a name');
  assert('error' in watchScript('bogus', [], {}), 'unknown target');
  assert('script' in watchScript('navigation', [], {}), 'navigation');
});

// ── diff ──────────────────────────────────────────────────────────────────────

stateTools.test('diffJson: object changes, adds, removes', async () => {
  const d = diffJson({ a: 1, b: { c: 2 }, gone: true }, { a: 1, b: { c: 3 }, added: 'x' });
  const s = d.map((c) => formatChange(c)).join('\n');
  assert(d.length === 3, s);
  assert(s.includes('~ $.b.c: 2 → 3'), s);
  assert(s.includes('- $.gone'), s);
  assert(s.includes('+ $.added = "x"'), s);
});

stateTools.test('diffJson: arrays keyed by identity (queryHash) survive reordering', async () => {
  const a = [
    { queryHash: 'a', status: 'pending' },
    { queryHash: 'b', status: 'success' },
  ];
  const b = [
    { queryHash: 'b', status: 'success' },
    { queryHash: 'a', status: 'success' },
    { queryHash: 'c', status: 'pending' },
  ];
  const d = diffJson(a, b);
  assert(d.length === 2, JSON.stringify(d));
  assert(d[0].path === '$[queryHash="a"].status' && d[0].to === 'success', JSON.stringify(d[0]));
  assert(d[1].op === 'add' && d[1].path === '$[queryHash="c"]', JSON.stringify(d[1]));
});

stateTools.test('diffJson: positional arrays and equal values', async () => {
  assert(diffJson([1, 2], [1, 2]).length === 0, 'equal');
  const d = diffJson(['Tabs', 'Home'], ['Tabs', 'Library', 'Details']);
  assert(d.length === 2 && d[0].path === '$[1]' && d[1].op === 'add', JSON.stringify(d));
});

// ── launch timing ─────────────────────────────────────────────────────────────

const FIX = path.join(__dirname, '../../tests/fixtures/launch');
const fixture = (name: string, file: string): string =>
  fs.readFileSync(path.join(FIX, name, file), 'utf-8');
const PERFMARK = compileMarkRegex('^PERFMARK\\s+(?<name>\\S+)\\s+(?<time>-?[\\d.]+)');

stateTools.test('parseAmStart: API 34 and API 25 output', async () => {
  const a34 = parseAmStart(fixture('api34', 'am_start.txt'));
  assert(
    a34.TotalTime === 2681 && a34.WaitTime === 2694 && a34.LaunchState === 'COLD',
    JSON.stringify(a34)
  );
  const a25 = parseAmStart(fixture('api25', 'am_start.txt'));
  assert(
    a25.ThisTime === 3410 && a25.TotalTime === 3410 && a25.LaunchState === undefined,
    JSON.stringify(a25)
  );
});

stateTools.test('parseLogcatLine and +duration', async () => {
  const l = parseLogcatLine('09-01 20:20:00.600  5450  5532 I ReactNativeJS: PERFMARK a 1.0 2 {}');
  assert(
    l !== null && l.tag === 'ReactNativeJS' && l.message.startsWith('PERFMARK a'),
    JSON.stringify(l)
  );
  assert(
    parsePlusDuration('+1s261ms') === 1261 && parsePlusDuration('+981ms') === 981,
    'durations'
  );
  assert(parseLogcatLine('--------- beginning of main') === null, 'separator');
});

stateTools.test('parseAndroidLaunch: API 34 Displayed, fully drawn, marks', async () => {
  const t = parseAndroidLaunch(fixture('api34', 'logcat.txt'), 'tv.plex.app.debug', PERFMARK);
  assert(t.procStartMs === 0, `procStart ${t.procStartMs}`);
  assert(t.displayedMs === 2681, `displayed ${t.displayedMs}`);
  assert(t.fullyDrawnMs === 3402, `fullyDrawn ${t.fullyDrawnMs}`);
  const entry = t.marks.find((m) => m.name === 'launch:index-entry')!;
  assert(entry.atMs === 600 && entry.appMs === 118, JSON.stringify(entry));
  const poly = t.marks.find((m) => m.name === 'launch:polyfills-done')!;
  assert(poly.deltaMs === 142, JSON.stringify(poly));
});

stateTools.test('parseAndroidLaunch: API 25 "Displayed pkg/.Act: +Xms" form', async () => {
  const t = parseAndroidLaunch(fixture('api25', 'logcat.txt'), 'tv.plex.app.debug');
  assert(t.displayedMs === 2681, `displayed ${t.displayedMs}`);
  assert(t.marks.length === 0, 'no marks without a regex');
});

stateTools.test(
  'parseAndroidLaunch: release build, "for user 0" Displayed, nav-ready mark',
  async () => {
    const t = parseAndroidLaunch(
      fixture('cc-rel-press', 'logcat.txt'),
      'tv.plex.app.debug',
      PERFMARK
    );
    assert(t.displayedMs === 1261, `displayed ${t.displayedMs}`);
    const nav = t.marks.find((m) => m.name === 'launch:nav-ready')!;
    assert(nav && nav.atMs === 3467, JSON.stringify(nav));
  }
);

stateTools.test('parseAndroidLaunch: our launch marker anchors times', async () => {
  const log = [
    '09-01 20:19:59.900  1000  1000 I conductor: conductor-launch-start',
    '09-01 20:20:00.000  1189  1300 I am_proc_start: [0,5450,10123,com.example,activity,com.example/.Main]',
    '09-01 20:20:00.400  5450  5532 I ReactNativeJS: MARK ready',
  ].join('\n');
  const t = parseAndroidLaunch(log, 'com.example', compileMarkRegex('MARK (?<name>\\w+)'));
  assert(t.procStartMs === 100, `procStart ${t.procStartMs}`);
  assert(t.marks[0].atMs === 500, JSON.stringify(t.marks));
});

stateTools.test('buildMarks keeps first occurrence and computes deltas', async () => {
  const m = buildMarks([
    { name: 'b', atMs: 300 },
    { name: 'a', atMs: 100 },
    { name: 'a', atMs: 900 },
  ]);
  assert(
    m.map((x) => `${x.name}@${x.atMs}+${x.deltaMs}`).join() === 'a@100+100,b@300+200',
    JSON.stringify(m)
  );
});

stateTools.test('summariseLaunchRuns: median/min/max per metric and mark', async () => {
  const run = (n: number, total: number, mark: number): LaunchRun => ({
    run: n,
    totalTimeMs: total,
    procStartMs: null,
    displayedMs: total + 10,
    fullyDrawnMs: null,
    marks: [{ name: 'ready', atMs: mark, deltaMs: mark }],
  });
  const s = summariseLaunchRuns([run(1, 1000, 2000), run(2, 1200, 2100), run(3, 1100, 1900)]);
  assert(
    s.totalTimeMs.p50Ms === 1100 && s.totalTimeMs.minMs === 1000 && s.totalTimeMs.maxMs === 1200,
    JSON.stringify(s.totalTimeMs)
  );
  assert(s['mark:ready'].p50Ms === 2000, JSON.stringify(s['mark:ready']));
  assert(!('fullyDrawnMs' in s), 'absent metrics omitted');
});

// ── physical iOS syslog ───────────────────────────────────────────────────────

stateTools.test('parseSyslogLine: idevicesyslog lines, levels, continuation', async () => {
  const now = new Date('2026-11-24T12:00:00');
  const l = parseSyslogLine(
    'Nov 24 10:00:00.123456 Douwes-iPhone Plex(UIKitCore)[1234] <Error>: something broke',
    now
  );
  assert(
    l !== null && l.process === 'Plex' && l.pid === 1234 && l.level === 'error',
    JSON.stringify(l)
  );
  assert(l!.message === 'something broke', l!.message);
  assert(new Date(l!.timestamp).getMilliseconds() === 123, l!.timestamp);
  const old = parseSyslogLine(
    'Dec 31 23:59:59 iPad SpringBoard[55] <Notice>: hi',
    new Date('2027-01-01T00:00:10')
  );
  assert(old !== null && new Date(old.timestamp).getFullYear() === 2026, old!.timestamp);
  assert(parseSyslogLine('    continuation of a multi-line message') === null, 'continuation');
  const colored = parseSyslogLine('\x1b[32mNov 24 10:00:00\x1b[0m phone app[1] <Debug>: x', now);
  assert(colored !== null && colored.level === 'debug', 'ansi stripped');
});
