/**
 * Tests for the profiling session layer: render reasons from the injected hook,
 * render/commit aggregation, CPU ↔ commit alignment, findings, baselines,
 * sampler segments, source maps and the native (xctrace / simpleperf) parsers.
 * All pure — fixtures in, reports out.
 */
import { TestSuite, assert } from './runner.js';
import {
  REACT_PROFILER_INSTALL,
  REACT_PROFILER_READ,
  REACT_PROFILER_STOP,
  ReactProfilerReadResult,
  ReactCommitComponent,
} from '../src/commands/profile.js';
import {
  computeRenders,
  cpuInWindow,
  buildFindings,
  toBaseline,
  diffBaselines,
  precedingStep,
} from '../src/commands/profile-analyze.js';
import { buildComponentIndex, locateComponent } from '../src/commands/component-index.js';
import {
  analyzeCpuProfile,
  analyzeCpuProfiles,
  mergeCpuProfiles,
  CpuProfile,
} from '../src/commands/profile-js.js';
import {
  parseXctraceTable,
  analyzeTimeProfile,
  threadName,
  parseSimpleperfThreads,
  parseAttrRows,
  summariseAllocations,
  summariseLeaks,
} from '../src/commands/profile-native.js';
import {
  SourceMapLookup,
  metroSourceMapUrl,
  shortSourcePath,
  scriptFileName,
} from '../src/source-map.js';
import { metroWsOrigin } from '../src/drivers/log-sources/metro.js';
import { matchAppProcess } from '../src/drivers/devicectl.js';

export const profilingSession = new TestSuite('profiling session');

// ── Render reasons from the real injected hook ────────────────────────────────

interface Fiber {
  tag: number;
  type: unknown;
  actualStartTime: number;
  actualDuration: number;
  child: Fiber | null;
  sibling: Fiber | null;
  alternate: Fiber | null;
  memoizedProps: Record<string, unknown> | null;
  memoizedState: unknown;
}

function f(
  name: string | null,
  opts: Partial<Fiber> & { start: number; dur: number; host?: boolean },
  ...children: Fiber[]
): Fiber {
  const node: Fiber = {
    tag: opts.tag ?? (opts.host ? 5 : 0),
    type: name === null ? null : opts.host ? name : { name },
    actualStartTime: opts.start,
    actualDuration: opts.dur,
    child: children[0] ?? null,
    sibling: null,
    alternate: opts.alternate ?? null,
    memoizedProps: opts.memoizedProps ?? {},
    memoizedState: opts.memoizedState ?? null,
  };
  for (let i = 0; i < children.length - 1; i++) children[i].sibling = children[i + 1];
  return node;
}

const g = globalThis as unknown as Record<string, unknown>;

function capture(roots: Fiber[], includeHosts = true): ReactProfilerReadResult {
  const hook = {
    renderers: new Map([[1, {}]]),
    getFiberRoots: () => new Set(),
    onCommitFiberRoot: undefined as unknown as (id: number, root: { current: Fiber }) => void,
  };
  delete g.__CONDUCTOR_REACT_PROFILER__;
  g.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook;
  try {
    eval(REACT_PROFILER_INSTALL(500, 200, includeHosts));
    for (const r of roots) hook.onCommitFiberRoot(1, { current: r });
    const read = eval(REACT_PROFILER_READ(50, true)) as ReactProfilerReadResult;
    eval(REACT_PROFILER_STOP);
    return read;
  } finally {
    delete g.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    delete g.__CONDUCTOR_REACT_PROFILER__;
  }
}

function comp(read: ReactProfilerReadResult, name: string, commit = 0): ReactCommitComponent {
  const c = read.commits![commit].components!.find((x) => x.name === name);
  assert(!!c, `${name} not captured in commit ${commit}`);
  return c!;
}

profilingSession.test('hook: first render is a mount and host elements are flagged', async () => {
  const read = capture([
    f(
      null,
      { start: 0, dur: 3 },
      f(
        'App',
        { start: 0, dur: 3 },
        f('View', { start: 0, dur: 2, host: true }, f('Inner', { start: 0, dur: 1 }))
      )
    ),
  ]);
  assert(comp(read, 'App').reason === 'mount', `reason ${comp(read, 'App').reason}`);
  assert(comp(read, 'View').host === true, 'View should be marked host');
  assert(comp(read, 'View').reason === undefined, 'host elements get no reason');
  assert(
    comp(read, 'Inner').parent === 'App',
    `parent skips host elements: ${comp(read, 'Inner').parent}`
  );
});

profilingSession.test(
  'hook: host elements are skipped by default but still count in parent time',
  async () => {
    const tree = (): Fiber =>
      f(
        null,
        { start: 0, dur: 5 },
        f('App', { start: 0, dur: 5 }, f('View', { start: 0, dur: 4, host: true }))
      );
    const read = capture([tree()], false);
    const names = read.commits![0].components!.map((c) => c.name);
    assert(!names.includes('View'), `hosts recorded: ${names}`);
    assert(comp(read, 'App').selfDuration === 1, `App self ${comp(read, 'App').selfDuration}`);
  }
);

profilingSession.test('hook: names changed props with their types', async () => {
  const onPress = (): void => undefined;
  const prev = f('Row', { start: 0, dur: 1, memoizedProps: { title: 'a', onPress, style: {} } });
  const next = f('Row', {
    start: 10,
    dur: 1,
    alternate: prev,
    memoizedProps: { title: 'b', onPress: () => undefined, style: prev.memoizedProps!.style },
  });
  const read = capture([f(null, { start: 10, dur: 1 }, next)]);
  const row = comp(read, 'Row');
  assert(row.reason === 'props', `reason ${row.reason}`);
  assert(
    JSON.stringify(row.changed) === JSON.stringify(['title:string', 'onPress:fn']),
    `changed ${JSON.stringify(row.changed)}`
  );
});

profilingSession.test(
  'hook: new props object with equal values is a parent re-render',
  async () => {
    const prev = f('Row', { start: 0, dur: 1, memoizedProps: { id: 1 } });
    const next = f('Row', { start: 10, dur: 1, alternate: prev, memoizedProps: { id: 1 } });
    const read = capture([f(null, { start: 10, dur: 1 }, next)]);
    assert(comp(read, 'Row').reason === 'parent', `reason ${comp(read, 'Row').reason}`);
  }
);

profilingSession.test('hook: only state hooks (with a queue) count as state changes', async () => {
  const props = { id: 1 };
  // An effect hook's object changes every render; that alone is not "state".
  const effectOnlyPrev = { memoizedState: { e: 1 }, queue: null, next: null };
  const effectOnlyNext = { memoizedState: { e: 2 }, queue: null, next: null };
  const a0 = f('A', { start: 0, dur: 1, memoizedProps: props, memoizedState: effectOnlyPrev });
  const a1 = f('A', {
    start: 10,
    dur: 1,
    alternate: a0,
    memoizedProps: props,
    memoizedState: effectOnlyNext,
  });

  const stPrev = { memoizedState: 1, queue: {}, next: null };
  const stNext = { memoizedState: 2, queue: {}, next: null };
  const b0 = f('B', { start: 0, dur: 1, memoizedProps: props, memoizedState: stPrev });
  const b1 = f('B', {
    start: 10,
    dur: 1,
    alternate: b0,
    memoizedProps: props,
    memoizedState: stNext,
  });

  const read = capture([f(null, { start: 10, dur: 2 }, a1, b1)]);
  assert(comp(read, 'A').reason === 'unknown', `A reason ${comp(read, 'A').reason}`);
  assert(comp(read, 'B').reason === 'state', `B reason ${comp(read, 'B').reason}`);
});

profilingSession.test(
  'hook: commits carry a monotonic index and the read carries clocks',
  async () => {
    const read = capture([
      f(null, { start: 0, dur: 1 }, f('A', { start: 0, dur: 1 })),
      f(null, { start: 5, dur: 1 }, f('A', { start: 5, dur: 1 })),
    ]);
    assert(read.commits!.map((c) => c.index).join(',') === '0,1', 'indices');
    assert(typeof read.startedAt === 'number' && typeof read.readAt === 'number', 'clocks');
  }
);

// ── Renders aggregation ───────────────────────────────────────────────────────

function readOf(
  commits: Array<{
    at: number;
    dur: number;
    comps: Array<Partial<ReactCommitComponent> & { name: string }>;
  }>
): ReactProfilerReadResult {
  return {
    installed: true,
    profilingSupported: true,
    startedAt: 1000,
    readAt: 1000 + (commits[commits.length - 1]?.at ?? 0) + 100,
    totalCommits: commits.length,
    commits: commits.map((c, i) => ({
      index: i,
      at: 1000 + c.at,
      durationMs: c.dur,
      componentCount: c.comps.length,
      droppedComponents: 0,
      components: c.comps.map((x) => ({
        depth: 1,
        actualDuration: x.selfDuration ?? 1,
        selfDuration: x.selfDuration ?? 1,
        ...x,
      })),
    })),
  };
}

profilingSession.test('renders: counts, commit membership, reasons and instances', async () => {
  const read = readOf([
    {
      at: 0,
      dur: 5,
      comps: [
        { name: 'List', reason: 'mount' },
        { name: 'Row', reason: 'mount' },
        { name: 'Row', reason: 'mount' },
      ],
    },
    {
      at: 500,
      dur: 5,
      comps: [
        { name: 'Row', reason: 'parent', parent: 'List' },
        { name: 'View', host: true },
      ],
    },
    { at: 900, dur: 5, comps: [{ name: 'Row', reason: 'props', changed: ['onPress:fn'] }] },
  ]);
  const r = computeRenders(read);
  const row = r.components.find((c) => c.name === 'Row')!;
  assert(row.renders === 4, `renders ${row.renders}`);
  assert(row.commits.join(',') === '0,1,2', `commits ${row.commits}`);
  assert(row.maxInstances === 2, `instances ${row.maxInstances}`);
  assert(
    row.reasons.parent === 1 && row.reasons.mount === 2 && row.reasons.props === 1,
    JSON.stringify(row.reasons)
  );
  assert(row.changedProps[0].prop === 'onPress:fn', 'changed props');
  assert(!r.components.some((c) => c.name === 'View'), 'host components excluded by default');
  assert(
    computeRenders(read, { includeHost: true }).components.some((c) => c.name === 'View'),
    '--hosts includes them'
  );
  assert(r.commits[1].atMs === 500, `atMs ${r.commits[1].atMs}`);
  assert(r.durationMs === 1000, `duration ${r.durationMs}`);
});

// ── CPU ↔ commit alignment ────────────────────────────────────────────────────

function prof(
  startUs: number,
  samples: Array<[number, number]>,
  names: Record<number, string>
): CpuProfile {
  return {
    startTime: startUs,
    endTime: startUs + samples.reduce((a, [, d]) => a + d, 0),
    nodes: [
      { id: 1, callFrame: { functionName: '[root]' }, children: Object.keys(names).map(Number) },
      ...Object.entries(names).map(([id, name]) => ({
        id: Number(id),
        callFrame: {
          functionName: name,
          url: 'http://localhost:8081/index.bundle',
          lineNumber: Number(id) * 10,
          columnNumber: 4,
        },
      })),
    ],
    samples: samples.map(([id]) => id),
    timeDeltas: samples.map(([, d]) => d),
  };
}

profilingSession.test('cpuInWindow credits only the overlapping part of each sample', async () => {
  // Samples every 10ms from runtime t=5000: A for 0–30ms, B for 30–60ms.
  const p = prof(
    1_000_000,
    [
      [2, 10_000],
      [2, 10_000],
      [2, 10_000],
      [3, 10_000],
      [3, 10_000],
      [3, 10_000],
    ],
    { 2: 'A', 3: 'B' }
  );
  const hot = cpuInWindow([p], { startedAtRuntimeMs: 5000 }, 5025, 5045);
  const a = hot.find((h) => h.name === 'A')!;
  const b = hot.find((h) => h.name === 'B')!;
  assert(a.selfMs === 5, `A ${a.selfMs}`);
  assert(b.selfMs === 15, `B ${b.selfMs}`);
});

profilingSession.test('segments: analysed together, gaps credit no function', async () => {
  const s1 = prof(
    0,
    [
      [2, 1000],
      [2, 1000],
    ],
    { 2: 'A' }
  );
  const s2 = prof(
    10_000_000,
    [
      [2, 1000],
      [3, 1000],
    ],
    { 2: 'A', 3: 'B' }
  );
  const summary = analyzeCpuProfiles([s1, s2], 10);
  const a = summary.top.find((t) => t.name === 'A')!;
  assert(a.selfMs === 3, `A ${a.selfMs}`);
  assert(summary.sampleCount === 4, `samples ${summary.sampleCount}`);
  assert(summary.durationMs === 4, `duration ${summary.durationMs} — the 10s gap must not count`);

  const merged = mergeCpuProfiles([s1, s2]);
  assert(merged.samples!.length === 4, 'merged samples');
  const ids = new Set(merged.nodes.map((n) => n.id));
  assert(ids.size === merged.nodes.length, 'merged node ids must be unique');
  assert(
    merged.samples!.every((s) => ids.has(s)),
    'merged samples must reference merged nodes'
  );
  assert(
    merged.timeDeltas![2] === 1000 + (10_000_000 - 2000),
    `gap lands in the first delta: ${merged.timeDeltas![2]}`
  );
  const single = analyzeCpuProfile(s1, 10);
  assert(
    single.top[0].url === 'http://localhost:8081/index.bundle' && single.top[0].columnNumber === 4,
    'raw position kept for symbolication'
  );
});

// ── Findings ──────────────────────────────────────────────────────────────────

profilingSession.test('findings: slow commit names components and JS during it', async () => {
  const read = readOf([
    {
      at: 100,
      dur: 60,
      comps: [
        { name: 'Heavy', selfDuration: 50, reason: 'state' },
        { name: 'Light', selfDuration: 2 },
      ],
    },
    { at: 2000, dur: 2, comps: [{ name: 'Light', selfDuration: 2 }] },
  ]);
  // CPU starts at runtime 1000 (= react start), so the commit (ends t=1100) spans 1040–1100.
  const p = prof(
    0,
    [
      [2, 50_000],
      [3, 50_000],
      [2, 50_000],
    ],
    { 2: 'idleish', 3: 'computePrimes' }
  );
  const findings = buildFindings({
    renders: computeRenders(read),
    reactStartedAt: 1000,
    cpuProfiles: [p],
    cpuAnchor: { startedAtRuntimeMs: 1000 },
  });
  const slow = findings.find((x) => x.kind === 'slow-commit')!;
  assert(slow.severity === 'high', `severity ${slow.severity}`);
  assert(slow.component === 'Heavy', `component ${slow.component}`);
  assert(/computePrimes/.test(slow.detail), `detail should name the JS hotspot: ${slow.detail}`);
});

profilingSession.test('findings: wasted (parent) renders and unstable callback props', async () => {
  const commits = Array.from({ length: 12 }, (_, i) => ({
    at: i * 300,
    dur: 3,
    comps: [
      { name: 'Card', reason: 'parent' as const, parent: 'Feed' },
      { name: 'Button', reason: 'props' as const, changed: ['onPress:fn'], parent: 'Card' },
    ],
  }));
  const findings = buildFindings({ renders: computeRenders(readOf(commits)) });
  const wasted = findings.find((x) => x.kind === 'wasted-renders' && x.component === 'Card');
  assert(!!wasted, 'Card should be flagged as wasted renders');
  assert(/React\.memo/.test(wasted!.suggestion), 'suggests React.memo');
  const unstable = findings.find((x) => x.kind === 'unstable-props' && x.component === 'Button');
  assert(
    !!unstable && /onPress/.test(unstable.title),
    'Button should be flagged for an unstable onPress'
  );
  // Sorted: no low before a medium/high.
  const ranks = findings.map((x) => ({ high: 0, medium: 1, low: 2 })[x.severity]);
  assert(
    ranks.every((r, i) => i === 0 || r >= ranks[i - 1]),
    'findings sorted by severity'
  );
});

profilingSession.test('findings: commit burst and GC pressure', async () => {
  const commits = Array.from({ length: 8 }, (_, i) => ({
    at: i * 10,
    dur: 1,
    comps: [{ name: 'X' }],
  }));
  const findings = buildFindings({
    renders: computeRenders(readOf(commits)),
    cpu: {
      durationMs: 1000,
      sampleCount: 1000,
      medianSampleIntervalMs: 1,
      attribution: { namedJsPercent: 50, gcPercent: 30, idlePercent: 20 },
      top: [],
      omitted: 0,
      notes: [],
    },
  });
  assert(
    findings.some((x) => x.kind === 'commit-burst'),
    'burst'
  );
  const gc = findings.find((x) => x.kind === 'gc-pressure');
  assert(gc?.severity === 'high', `gc ${gc?.severity}`);
});

// ── Baselines ─────────────────────────────────────────────────────────────────

profilingSession.test('baseline diff flags meaningful regressions only', async () => {
  const before = toBaseline({
    renders: computeRenders(
      readOf([
        {
          at: 0,
          dur: 1,
          comps: Array.from({ length: 10 }, () => ({ name: 'Row' })).concat([{ name: 'Tiny' }]),
        },
      ])
    ),
  });
  const after = toBaseline({
    renders: computeRenders(
      readOf([
        {
          at: 0,
          dur: 1,
          comps: Array.from({ length: 20 }, () => ({ name: 'Row' })).concat([
            { name: 'Tiny' },
            { name: 'Tiny' },
          ]),
        },
      ])
    ),
  });
  const diff = diffBaselines(before, after);
  const row = diff.find((d) => d.name === 'Row' && d.metric === 'renders');
  assert(row?.verdict === 'regression' && row.changePercent === 100, JSON.stringify(row));
  assert(
    !diff.some((d) => d.name === 'Tiny' && d.metric === 'renders'),
    '1→2 renders is noise, not a regression'
  );
});

// ── Source maps ───────────────────────────────────────────────────────────────

profilingSession.test('source map: maps a bundle position to the original line', async () => {
  // Line 1: col 0 → a.js:1:0; col 10 → b.js:5:2. Line 2: col 0 → b.js:6:0 (name "foo").
  const map = new SourceMapLookup({
    version: 3,
    sources: ['/repo/src/a.js', '/repo/node_modules/lib/b.js'],
    names: ['foo'],
    mappings: 'AAAA,UCIE;AACFA',
  });
  const p1 = map.originalPositionFor(1, 12)!;
  assert(
    p1.source === '/repo/node_modules/lib/b.js' && p1.line === 5 && p1.column === 2,
    JSON.stringify(p1)
  );
  const p0 = map.originalPositionFor(1, 3)!;
  assert(p0.source === '/repo/src/a.js' && p0.line === 1, JSON.stringify(p0));
  const p2 = map.originalPositionFor(2, 0)!;
  assert(p2.line === 6 && p2.name === 'foo', JSON.stringify(p2));
  assert(map.originalPositionFor(9, 0) === null, 'past the end');
  assert(shortSourcePath('/repo/src/a.js', '/repo') === 'src/a.js', 'project-relative');
  assert(
    shortSourcePath('/x/y/node_modules/lib/b.js', '/repo') === 'node_modules/lib/b.js',
    'node_modules tail'
  );
  assert(
    metroSourceMapUrl('http://localhost:8081/index.bundle?platform=ios&dev=true') ===
      'http://localhost:8081/index.map?platform=ios&dev=true',
    'bundle → map url'
  );
  assert(metroSourceMapUrl('InternalBytecode.js') === undefined, 'non-Metro url');
  // Metro serves indexed maps for lazy bundles; section offsets are 0-based.
  const indexed = new SourceMapLookup({
    version: 3,
    sources: [],
    mappings: '',
    sections: [
      {
        offset: { line: 0, column: 0 },
        map: { version: 3, sources: ['/[metro-project]/a.js'], mappings: 'AAAA' },
      },
      {
        offset: { line: 10, column: 0 },
        map: { version: 3, sources: ['/[metro-project]/src/b.tsx'], mappings: ';AAIE' },
      },
    ],
  });
  const pi = indexed.originalPositionFor(12, 3)!;
  assert(pi.source === '/[metro-project]/src/b.tsx' && pi.line === 5, JSON.stringify(pi));
  assert(shortSourcePath(pi.source) === 'src/b.tsx', 'metro-project prefix stripped');
  // Hermes reports RN bundle URLs with the query after `//&`.
  assert(
    metroSourceMapUrl(
      'http://localhost:8081/node_modules/expo-router/entry.bundle//&platform=ios&dev=true'
    ) === 'http://localhost:8081/node_modules/expo-router/entry.map?platform=ios&dev=true',
    'RN //& bundle url → map url'
  );
  assert(
    scriptFileName('http://localhost:8081/x/entry.bundle//&platform=ios&a=b/c') === 'entry.bundle',
    'file name'
  );
  assert(
    metroWsOrigin('ws://localhost:8081/inspector/debug?device=1') === 'http://127.0.0.1:8081',
    'origin'
  );
});

// ── xctrace / simpleperf ──────────────────────────────────────────────────────

// Shape of a real `xctrace export` of the time-profile table (Xcode 27.2):
// first occurrences carry id=, repeats are ref=.
const TIME_PROFILE = `<?xml version="1.0"?>
<trace-query-result>
<node xpath='//trace-toc[1]/run[1]/data[1]/table[28]'><schema name="time-profile"><col><mnemonic>time</mnemonic><name>Sample Time</name></col><col><mnemonic>thread</mnemonic><name>Thread</name></col><col><mnemonic>process</mnemonic><name>Process</name></col><col><mnemonic>core</mnemonic><name>Core</name></col><col><mnemonic>thread-state</mnemonic><name>State</name></col><col><mnemonic>weight</mnemonic><name>Weight</name></col><col><mnemonic>stack</mnemonic><name>Backtrace</name></col></schema>
<row><sample-time id="1" fmt="00:00.100">100000000</sample-time><thread id="2" fmt="Main Thread (0x9a1) (ProfilingTest, pid: 48516)"><tid id="3" fmt="0x9a1">1</tid><process id="4" fmt="ProfilingTest (48516)"><pid id="5" fmt="48516">48516</pid></process></thread><process ref="4"/><core id="7" fmt="CPU 6">6</core><thread-state id="8" fmt="Running">Running</thread-state><weight id="9" fmt="1.00 ms">1000000</weight><tagged-backtrace id="10"><frame id="11" name="layoutSubviews &amp; co" addr="0x1"><binary id="12" name="UIKitCore" path="/Library/Developer/CoreSimulator/Volumes/iOS/RuntimeRoot/System/Library/PrivateFrameworks/UIKitCore.framework/UIKitCore"/></frame><frame id="13" name="-[AppDelegate render]" addr="0x2"><binary id="14" name="ProfilingTest" path="/Users/x/Library/Developer/CoreSimulator/Devices/U/data/Containers/Bundle/Application/A/ProfilingTest.app/ProfilingTest"/></frame></tagged-backtrace></row>
<row><sample-time id="17" fmt="00:00.101">101000000</sample-time><thread ref="2"/><process ref="4"/><core ref="7"/><thread-state ref="8"/><weight ref="9"/><tagged-backtrace ref="10"/></row>
<row><sample-time id="18" fmt="00:00.102">102000000</sample-time><thread id="19" fmt="com.facebook.react.runtime.JavaScript (0x9b2) (ProfilingTest, pid: 48516)"><tid id="20" fmt="0x9b2">2</tid><process ref="4"/></thread><process ref="4"/><core ref="7"/><thread-state ref="8"/><weight ref="9"/><tagged-backtrace id="21"><frame id="22" name="hermes::vm::Interpreter::run" addr="0x3"><binary id="23" name="hermes" path="/Users/x/ProfilingTest.app/Frameworks/hermes.framework/hermes"/></frame><frame ref="13"/></tagged-backtrace></row>
<row><sample-time id="24" fmt="00:00.400">400000000</sample-time><thread ref="2"/><process ref="4"/><sentinel/><thread-state ref="8"/><weight ref="9"/><tagged-backtrace ref="10"/></row>
</node></trace-query-result>`;

const HANGS = `<?xml version="1.0"?><trace-query-result><node><schema name="potential-hangs"><col><mnemonic>start</mnemonic></col><col><mnemonic>duration</mnemonic></col><col><mnemonic>hang-type</mnemonic></col><col><mnemonic>thread</mnemonic></col><col><mnemonic>process</mnemonic></col></schema>
<row><start-time id="1" fmt="00:00.099">99000000</start-time><duration id="2" fmt="300 ms">300000000</duration><hang-type id="3" fmt="Hang">Hang</hang-type><thread id="4" fmt="Main Thread"/><process id="5" fmt="P"/></row>
</node></trace-query-result>`;

profilingSession.test('xctrace: parses rows, resolving id/ref and sentinels', async () => {
  const t = parseXctraceTable(TIME_PROFILE);
  assert(
    t.columns.join(',') === 'time,thread,process,core,thread-state,weight,stack',
    `columns ${t.columns}`
  );
  assert(t.rows.length === 4, `rows ${t.rows.length}`);
  assert(t.rows[1].thread?.attrs.fmt?.startsWith('Main Thread') === true, 'thread ref resolved');
  assert(t.rows[1].stack?.children.length === 2, 'backtrace ref resolved with its frames');
  assert(t.rows[3].core === null, 'sentinel → null');
  assert(t.rows[0].stack!.children[0].attrs.name === 'layoutSubviews & co', 'entities decoded');
  assert(
    threadName(t.rows[2].thread?.attrs.fmt) === 'com.facebook.react.runtime.JavaScript',
    'thread name'
  );
});

profilingSession.test('xctrace: ranks self time, threads, app frames and hangs', async () => {
  const r = analyzeTimeProfile(parseXctraceTable(TIME_PROFILE), parseXctraceTable(HANGS), {
    top: 10,
    appExecutable: 'ProfilingTest',
    trace: 't.trace',
    platform: 'ios',
  });
  assert(r.totalSamples === 4, `samples ${r.totalSamples}`);
  assert(
    r.symbols[0].symbol === 'layoutSubviews & co' && r.symbols[0].percent === 75,
    JSON.stringify(r.symbols[0])
  );
  assert(r.symbols[0].app === false, 'UIKit is not app code');
  assert(
    r.threads[0].name === 'Main Thread' && r.threads[0].percent === 75,
    JSON.stringify(r.threads)
  );
  assert(
    r.appFrames[0].symbol === '-[AppDelegate render]' && r.appFrames[0].percent === 100,
    JSON.stringify(r.appFrames)
  );
  const hermes = r.symbols.find((s) => s.library === 'hermes')!;
  assert(hermes.app === false, 'the RN runtime inside the .app is not app code');
  assert(r.hangs!.length === 1 && r.hangs![0].durationMs === 300, JSON.stringify(r.hangs));
  assert(r.hangs![0].top[0].symbol === 'layoutSubviews & co', 'main-thread work during the hang');
  const findings = buildFindings({ native: r });
  assert(
    findings[0].kind === 'hang' || findings[0].kind === 'native-hotspot',
    'native findings produced'
  );
});

profilingSession.test('xctrace: an idle app is a note, not an error', async () => {
  const empty = TIME_PROFILE.replace(/<row>[\s\S]*<\/row>\n/, '');
  const r = analyzeTimeProfile(parseXctraceTable(empty), undefined, {
    top: 5,
    trace: 't',
    platform: 'ios',
  });
  assert(r.totalSamples === 0 && r.notes.length === 1, JSON.stringify(r.notes));
});

profilingSession.test('simpleperf: per-thread report', async () => {
  const out = `Cmdline: /system/bin/simpleperf record --app com.x
Samples: 1234
Event count: 99

Overhead  Command
41.20%    mqt_v_js
30.05%    RenderThread
12.00%    com.x
`;
  const t = parseSimpleperfThreads(out);
  assert(t.length === 3 && t[0].name === 'mqt_v_js' && t[0].percent === 41.2, JSON.stringify(t));
});

profilingSession.test(
  'findings: framework components are re-pointed at the app parent',
  async () => {
    const commits = Array.from({ length: 12 }, (_, i) => ({
      at: i * 300,
      dur: 3,
      comps: [
        {
          name: 'Pressable',
          reason: 'props' as const,
          changed: ['onPress:fn', 'style:object'],
          parent: 'RowInner',
        },
        {
          name: 'CellRenderer',
          reason: 'props' as const,
          changed: ['renderItem:fn'],
          parent: 'VirtualizedList',
        },
      ],
    }));
    const findings = buildFindings({ renders: computeRenders(readOf(commits)) });
    const row = findings.find((x) => x.kind === 'unstable-props' && x.component === 'RowInner');
    assert(
      !!row && /RowInner passes new onPress, style to Pressable/.test(row.title),
      JSON.stringify(row?.title)
    );
    const cell = findings.find(
      (x) => x.kind === 'unstable-props' && x.component === 'CellRenderer'
    );
    assert(cell?.severity === 'low', `framework-only chain ranks low: ${cell?.severity}`);
    assert(
      !findings.some((x) => x.kind === 'frequent-renders' && x.component === 'Pressable'),
      'no frequency noise for framework'
    );
  }
);

profilingSession.test(
  'findings: native hotspots come from app code, not the RN runtime',
  async () => {
    const native = {
      platform: 'ios',
      tool: 'xctrace' as const,
      trace: 't',
      symbols: [
        { symbol: 'fmod', library: 'libsystem_m.dylib', percent: 40, app: false },
        { symbol: 'Interpreter::run', library: 'hermesvm', percent: 30, app: false },
      ],
      appFrames: [{ symbol: '-[PlayerView layout]', library: 'App', percent: 12, app: true }],
      libraries: [],
      threads: [],
      notes: [],
    };
    const findings = buildFindings({ native }).filter((x) => x.kind === 'native-hotspot');
    assert(
      findings.length === 1 && findings[0].function === '-[PlayerView layout]',
      JSON.stringify(findings.map((x) => x.function))
    );
  }
);

profilingSession.test(
  'devicectl: app pid comes from the bundle URL, not an extension',
  async () => {
    const url = 'file:///private/var/containers/Bundle/Application/DEF6/Plex.app/';
    const procs = [
      {
        processIdentifier: 10,
        executable:
          'file:///private/var/containers/Bundle/Application/DEF6/Plex.app/PlugIns/Widget.appex/Widget',
      },
      {
        processIdentifier: 11,
        executable: 'file:///private/var/containers/Bundle/Application/DEF6/Plex.app/Plex',
      },
      {
        processIdentifier: 12,
        executable: 'file:///private/var/containers/Bundle/Application/AAAA/Slack.app/Slack',
      },
    ];
    assert(matchAppProcess(procs, url, 'tv.plex.rn.app') === 11, 'main executable');
    assert(matchAppProcess(procs.slice(2), url, 'tv.plex.rn.app') === undefined, 'not running');
  }
);

// ── Causes, steps, hangs ↔ commits, memory tables ─────────────────────────────

profilingSession.test(
  'hook: parent renders carry the root cause; hooks and contexts are named',
  async () => {
    const ctx = { displayName: 'ThemeContext' };
    const hookPrev = { memoizedState: 1, queue: {}, next: null };
    const hookNext = { memoizedState: 2, queue: {}, next: null };
    const feedPrev = f('Feed', { start: 0, dur: 1, memoizedProps: {}, memoizedState: hookPrev });
    const feedNext = f('Feed', {
      start: 10,
      dur: 3,
      alternate: feedPrev,
      memoizedProps: feedPrev.memoizedProps,
      memoizedState: hookNext,
    });
    (feedNext as unknown as { _debugHookTypes: string[] })._debugHookTypes = ['useState'];
    const cardPrev = f('Card', { start: 0, dur: 1, memoizedProps: { id: 1 } });
    const cardNext = f('Card', {
      start: 10,
      dur: 1,
      alternate: cardPrev,
      memoizedProps: { id: 1 },
    });
    feedNext.child = cardNext;
    const themedPrev = f('Themed', { start: 0, dur: 1, memoizedProps: {} });
    (themedPrev as unknown as { dependencies: unknown }).dependencies = {
      firstContext: { context: ctx, memoizedValue: 'light', next: null },
    };
    const themedNext = f('Themed', {
      start: 10,
      dur: 1,
      alternate: themedPrev,
      memoizedProps: themedPrev.memoizedProps,
    });
    (themedNext as unknown as { dependencies: unknown }).dependencies = {
      firstContext: { context: ctx, memoizedValue: 'dark', next: null },
    };
    (themedNext as unknown as { updateQueue: unknown }).updateQueue = { memoCache: {} };
    const read = capture([f(null, { start: 10, dur: 4 }, feedNext, themedNext)]);
    assert(
      JSON.stringify(comp(read, 'Feed').hooks) === '["useState#0"]',
      `hooks ${JSON.stringify(comp(read, 'Feed').hooks)}`
    );
    assert(comp(read, 'Card').reason === 'parent', 'Card parent');
    assert(
      comp(read, 'Card').cause === 'Feed (state useState#0)',
      `cause ${comp(read, 'Card').cause}`
    );
    assert(comp(read, 'Themed').reason === 'context', `Themed ${comp(read, 'Themed').reason}`);
    assert(comp(read, 'Themed').contexts?.[0] === 'ThemeContext', 'context named');
    assert(comp(read, 'Themed').compiled === true, 'compiler memo cache detected');
  }
);

profilingSession.test(
  'findings: context churn, root cause text, step label and compiler bail-out',
  async () => {
    const commits = Array.from({ length: 8 }, (_, i) => ({
      at: 1000 + i * 300,
      dur: i === 0 ? 40 : 2,
      comps: [
        { name: 'Themed', reason: 'context' as const, contexts: ['ThemeContext'] },
        {
          name: 'Card',
          reason: 'parent' as const,
          parent: 'Feed',
          cause: 'Feed (state useState#0)',
        },
        { name: 'Compiled', reason: 'state' as const, compiled: true },
      ],
    }));
    const renders = computeRenders(readOf(commits));
    const findings = buildFindings({
      renders,
      reactStartedAt: 1000,
      steps: [{ label: 'tapOn "Load"', atMs: 1000 + 1000 - 120, ok: true }],
    });
    assert(
      findings.some((x) => x.kind === 'context-churn' && /ThemeContext/.test(x.title)),
      'context churn'
    );
    const wasted = findings.find((x) => x.kind === 'wasted-renders')!;
    assert(/Root cause: Feed \(state useState#0\)/.test(wasted.detail), wasted.detail);
    const slow = findings.find((x) => x.kind === 'slow-commit')!;
    assert(/120ms after tapOn "Load"/.test(slow.detail), slow.detail);
    assert(
      findings.some((x) => x.kind === 'compiler-bailout' && x.component === 'Card'),
      'bail-out flagged'
    );
    assert(
      precedingStep([{ label: 'a', atMs: 0, ok: true }], 6000) === undefined,
      'steps older than 5s are not a cause'
    );
  }
);

profilingSession.test('findings: a hang lists the React commits around it', async () => {
  const renders = computeRenders(
    readOf([{ at: 2100, dur: 80, comps: [{ name: 'Heavy', selfDuration: 70 }] }])
  );
  const findings = buildFindings({
    renders,
    reactStartedAt: 1000,
    nativeStartedAtRuntimeMs: 1000,
    native: {
      platform: 'ios',
      tool: 'xctrace',
      trace: 't',
      symbols: [],
      libraries: [],
      threads: [],
      notes: [],
      hangs: [{ startMs: 2000, traceMs: 2000, durationMs: 400, kind: 'Hang', top: [] }],
    },
  });
  const hang = findings.find((x) => x.kind === 'hang')!;
  assert(/#0 80ms \(Heavy\)/.test(hang.detail), hang.detail);
});

profilingSession.test('allocations and leaks tables', async () => {
  const stats = `<node><row category="All Heap &amp; Anonymous VM" persistent-bytes="1000" count-persistent="10" total-bytes="1500" transient-bytes="500" count-transient="5"/>
<row category="Malloc 16.00 KiB" persistent-bytes="800" count-persistent="2" count-transient="0"/>
<row category="CFString" persistent-bytes="100" count-persistent="7" count-transient="3"/></node>`;
  const a = summariseAllocations(parseAttrRows(stats))!;
  assert(a.persistentBytes === 1000 && a.transientCount === 5, JSON.stringify(a));
  assert(a.top[0].category === 'Malloc 16.00 KiB' && a.top.length === 2, JSON.stringify(a.top));
  const leaks = summariseLeaks(
    `<node><row leaked-object="NSMutableArray" size="64 Bytes" responsible-frame="-[Player load]" responsible-library="App"/>` +
      `<row leaked-object="NSMutableArray" size="64 Bytes" responsible-frame="-[Player load]" responsible-library="App"/></node>`
  );
  assert(
    leaks.length === 1 && leaks[0].count === 2 && leaks[0].bytes === 128,
    JSON.stringify(leaks)
  );
  const nf = buildFindings({
    native: {
      platform: 'ios',
      tool: 'xctrace',
      trace: 't',
      symbols: [],
      libraries: [],
      threads: [],
      notes: [],
      leaks,
    },
  });
  assert(nf[0].kind === 'native-leak' && nf[0].severity === 'high', JSON.stringify(nf[0]));
});

profilingSession.test('android extras: jank and memory growth findings', async () => {
  const nf = buildFindings({
    native: {
      platform: 'android',
      tool: 'simpleperf',
      trace: 't',
      symbols: [],
      libraries: [],
      threads: [],
      notes: [],
      frames: {
        totalFrames: 120,
        jankyPercent: 40,
        p50Ms: 20,
        p95Ms: 90,
        dominantPhase: 'issueDraw',
      },
      memory: { startPssBytes: 200 * 1048576, endPssBytes: 330 * 1048576 },
    },
  });
  assert(
    nf.some((x) => x.kind === 'jank' && x.severity === 'high'),
    'jank'
  );
  assert(
    nf.some((x) => x.kind === 'memory-growth' && x.severity === 'high'),
    'growth'
  );
});

profilingSession.test('component index: finds definitions and resolves display names', async () => {
  const os = await import('node:os');
  const fsp = await import('node:fs/promises');
  const path = await import('node:path');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cidx-'));
  await fsp.mkdir(path.join(dir, 'src/app'), { recursive: true });
  await fsp.mkdir(path.join(dir, 'node_modules/x'), { recursive: true });
  await fsp.writeFile(
    path.join(dir, 'src/app/profile.tsx'),
    'export default function ProfileScreen() {}\nconst Row = memo((p) => null);\n'
  );
  await fsp.writeFile(
    path.join(dir, 'src/Card.tsx'),
    'export const Card: React.FC<P> = ({ a }) => null;\nclass Old extends React.Component {}\n'
  );
  await fsp.writeFile(path.join(dir, 'node_modules/x/View.js'), 'function View() {}\n');
  const idx = await buildComponentIndex(dir);
  assert(
    locateComponent(idx, 'ProfileScreen(./profile.tsx)') === 'src/app/profile.tsx:1',
    'expo-router name'
  );
  assert(locateComponent(idx, 'Memo(Row)') === 'src/app/profile.tsx:2', 'memo arrow');
  assert(locateComponent(idx, 'Card') === 'src/Card.tsx:1', 'typed const arrow');
  assert(locateComponent(idx, 'Old') === 'src/Card.tsx:2', 'class');
  assert(locateComponent(idx, 'View') === undefined, 'node_modules skipped');
  await fsp.rm(dir, { recursive: true, force: true });
});
