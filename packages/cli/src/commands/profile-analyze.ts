/**
 * Pure analysis over a saved profiling session: per-component render stats,
 * commit ↔ CPU alignment, ranked findings and baseline diffs.
 *
 * Inputs are the files `profile react stop` / `profile native stop` write; no
 * device access happens here, so everything is exercised by unit tests.
 */
import { round } from '../stats.js';
import { scriptFileName } from '../source-map.js';
import type { ReactProfilerReadResult, RenderReason } from './profile.js';
import type { CpuProfile, JsProfileSummary, ProfileNode } from './profile-js.js';

// ── Renders ───────────────────────────────────────────────────────────────────

export interface ComponentRenders {
  name: string;
  renders: number;
  /** Indices of the commits it rendered in (deduplicated, ascending). */
  commits: number[];
  /** Share of all captured commits this component rendered in. */
  commitShare: number;
  selfMs: number;
  totalMs: number;
  avgSelfMs: number;
  maxSelfMs: number;
  /** Most instances of it rendered in a single commit. */
  maxInstances: number;
  reasons: Partial<Record<RenderReason, number>>;
  /** Most frequently changed props (`name:type`), with counts. */
  changedProps: Array<{ prop: string; count: number }>;
  /** Most common nearest composite parents. */
  parents: Array<{ name: string; count: number }>;
  host: boolean;
}

export interface CommitSummary {
  index: number;
  /** Commit time relative to profiler start (runtime clock). */
  atMs: number;
  durationMs: number;
  components: number;
  top: Array<{ name: string; selfMs: number; reason?: RenderReason }>;
}

export interface RendersReport {
  totalCommits: number;
  durationMs: number;
  components: ComponentRenders[];
  commits: CommitSummary[];
  truncated: boolean;
}

export function computeRenders(
  read: ReactProfilerReadResult,
  opts: { includeHost?: boolean } = {}
): RendersReport {
  const commits = read.commits ?? [];
  const t0 = read.startedAt ?? commits[0]?.at ?? 0;
  const by = new Map<
    string,
    ComponentRenders & {
      commitSet: Set<number>;
      props: Map<string, number>;
      parentMap: Map<string, number>;
    }
  >();
  const commitSummaries: CommitSummary[] = [];

  commits.forEach((c, i) => {
    const index = c.index ?? i;
    const perCommit = new Map<string, number>();
    const comps = (c.components ?? []).filter((x) => opts.includeHost || !x.host);
    for (const comp of comps) {
      let e = by.get(comp.name);
      if (!e) {
        e = {
          name: comp.name,
          renders: 0,
          commits: [],
          commitShare: 0,
          selfMs: 0,
          totalMs: 0,
          avgSelfMs: 0,
          maxSelfMs: 0,
          maxInstances: 0,
          reasons: {},
          changedProps: [],
          parents: [],
          host: !!comp.host,
          commitSet: new Set(),
          props: new Map(),
          parentMap: new Map(),
        };
        by.set(comp.name, e);
      }
      e.renders++;
      e.commitSet.add(index);
      e.selfMs += comp.selfDuration;
      e.totalMs += comp.actualDuration;
      e.maxSelfMs = Math.max(e.maxSelfMs, comp.selfDuration);
      if (comp.reason) e.reasons[comp.reason] = (e.reasons[comp.reason] ?? 0) + 1;
      for (const p of comp.changed ?? []) e.props.set(p, (e.props.get(p) ?? 0) + 1);
      if (comp.parent) e.parentMap.set(comp.parent, (e.parentMap.get(comp.parent) ?? 0) + 1);
      perCommit.set(comp.name, (perCommit.get(comp.name) ?? 0) + 1);
    }
    for (const [name, n] of perCommit) {
      const e = by.get(name)!;
      e.maxInstances = Math.max(e.maxInstances, n);
    }
    commitSummaries.push({
      index,
      atMs: round(c.at - t0),
      durationMs: round(c.durationMs),
      components: comps.length,
      top: [...comps]
        .sort((a, b) => b.selfDuration - a.selfDuration)
        .slice(0, 3)
        .map((x) => ({ name: x.name, selfMs: round(x.selfDuration), reason: x.reason })),
    });
  });

  const topN = (m: Map<string, number>, n: number): Array<[string, number]> =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);

  const components: ComponentRenders[] = [...by.values()]
    .map(({ commitSet, props, parentMap, ...e }) => ({
      ...e,
      commits: [...commitSet].sort((a, b) => a - b),
      commitShare: commits.length > 0 ? round(commitSet.size / commits.length, 3) : 0,
      selfMs: round(e.selfMs),
      totalMs: round(e.totalMs),
      maxSelfMs: round(e.maxSelfMs),
      avgSelfMs: e.renders > 0 ? round(e.selfMs / e.renders, 3) : 0,
      changedProps: topN(props, 5).map(([prop, count]) => ({ prop, count })),
      parents: topN(parentMap, 3).map(([name, count]) => ({ name, count })),
    }))
    .sort((a, b) => b.renders - a.renders || b.selfMs - a.selfMs);

  const end = read.readAt ?? commits[commits.length - 1]?.at ?? t0;
  return {
    totalCommits: commits.length,
    durationMs: round(Math.max(0, end - t0)),
    components,
    commits: commitSummaries,
    truncated: !!read.truncated,
  };
}

// ── CPU ↔ commit alignment ────────────────────────────────────────────────────

/** Where profile segment 0 started, in the app runtime's `Date.now()` clock. */
export interface CpuAnchor {
  startedAtRuntimeMs: number;
}

export interface WindowHotspot {
  name: string;
  location: string;
  selfMs: number;
}

function isIdleFrame(name: string): boolean {
  return !name || name.startsWith('[') || name.startsWith('(');
}

/**
 * Self time per named JS function inside a runtime-clock window. Each sample
 * covers the interval since the previous one; only the part overlapping the
 * window is counted.
 */
export function cpuInWindow(
  profiles: CpuProfile[],
  anchor: CpuAnchor,
  fromMs: number,
  toMs: number,
  top = 5,
  /** `url:line:col` → original `file:line`, from the profile's symbols.json. */
  symbols?: Record<string, string | null>
): WindowHotspot[] {
  if (profiles.length === 0) return [];
  const origin = profiles[0].startTime;
  const self = new Map<string, { name: string; location: string; us: number }>();
  for (const p of profiles) {
    const byId = new Map<number, ProfileNode>(p.nodes.map((n) => [n.id, n]));
    const samples = p.samples ?? [];
    const deltas = p.timeDeltas ?? [];
    let t = p.startTime;
    for (let i = 0; i < samples.length; i++) {
      const prev = t;
      t += deltas[i] ?? 0;
      const sStart = anchor.startedAtRuntimeMs + (prev - origin) / 1000;
      const sEnd = anchor.startedAtRuntimeMs + (t - origin) / 1000;
      const overlap = Math.min(sEnd, toMs) - Math.max(sStart, fromMs);
      if (overlap <= 0) continue;
      const node = byId.get(samples[i]);
      const fn = node?.callFrame.functionName ?? '';
      if (!node || isIdleFrame(fn)) continue;
      const cf = node.callFrame;
      const file = scriptFileName(cf.url);
      const location =
        symbols?.[`${cf.url}:${cf.lineNumber}:${cf.columnNumber}`] ??
        (cf.lineNumber !== undefined ? `${file}:${cf.lineNumber + 1}` : file);
      const key = `${fn} ${location}`;
      const slot = self.get(key) ?? { name: fn, location, us: 0 };
      slot.us += overlap * 1000;
      self.set(key, slot);
    }
  }
  return [...self.values()]
    .sort((a, b) => b.us - a.us)
    .slice(0, top)
    .map((s) => ({ name: s.name, location: s.location, selfMs: round(s.us / 1000) }));
}

// ── Native analysis shape (filled by profile-native) ──────────────────────────

export interface NativeSymbol {
  symbol: string;
  library: string;
  /** Share of all sampled CPU time. */
  percent: number;
  selfMs?: number;
  /** True for frames in the app's own binary rather than a system library. */
  app?: boolean;
}

export interface NativeThread {
  name: string;
  percent: number;
  selfMs?: number;
}

export interface NativeHang {
  startMs: number;
  durationMs: number;
  kind: string;
  /** Busiest functions on the main thread during the hang. */
  top: Array<{ symbol: string; selfMs: number }>;
}

export interface NativeReport {
  platform: string;
  tool: 'xctrace' | 'simpleperf';
  trace: string;
  durationMs?: number;
  totalSamples?: number;
  symbols: NativeSymbol[];
  libraries: Array<{ library: string; percent: number }>;
  threads: NativeThread[];
  hangs?: NativeHang[];
  /** Deepest frame in the app's own binaries per sample (iOS). */
  appFrames?: NativeSymbol[];
  notes: string[];
}

// ── Findings ──────────────────────────────────────────────────────────────────

export type Severity = 'high' | 'medium' | 'low';

export interface Finding {
  severity: Severity;
  kind:
    | 'slow-commit'
    | 'commit-burst'
    | 'wasted-renders'
    | 'unstable-props'
    | 'frequent-renders'
    | 'render-hotspot'
    | 'many-instances'
    | 'js-hotspot'
    | 'gc-pressure'
    | 'native-hotspot'
    | 'hang';
  title: string;
  detail: string;
  suggestion: string;
  component?: string;
  function?: string;
  location?: string;
  /** Rough cost in ms the finding accounts for, used to rank within a severity. */
  impactMs: number;
  evidence: Record<string, unknown>;
}

const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

/** One frame at 60Hz. */
export const FRAME_BUDGET_MS = 16;

export interface AnalyzeInput {
  renders?: RendersReport;
  cpu?: JsProfileSummary;
  /** Raw CPU segments + anchor, for attributing slow commits to JS functions. */
  cpuProfiles?: CpuProfile[];
  cpuAnchor?: CpuAnchor;
  /** Source-map lookups (`url:line:col` → `file:line`) for JS locations. */
  symbols?: Record<string, string | null>;
  /** Runtime-clock start of the React recording, to place commits on the CPU timeline. */
  reactStartedAt?: number;
  native?: NativeReport;
}

function sev(value: number, medium: number, high: number): Severity {
  return value >= high ? 'high' : value >= medium ? 'medium' : 'low';
}

function list(items: string[], n = 3): string {
  return items.slice(0, n).join(', ') + (items.length > n ? ', …' : '');
}

/**
 * React Native / navigation building blocks. Their re-renders are real cost but
 * the fix lives in the app component that renders them, so findings about them
 * are re-pointed at an app-owned parent or ranked low.
 */
const FRAMEWORK_COMPONENT =
  /^(View|Text|TextImpl|Image|ImageBackground|TextInput|Pressable|PressabilityDebugView|Touchable\w*|ScrollView\w*|FlatList|SectionList|VirtualizedList\w*|VirtualizedSectionList|CellRenderer\w*|Animated\w*|AnimatedComponent\w*|RCT\w*|RNS\w*|SafeArea\w*|Screen\w*|ScreenStack\w*|NativeTabs\w*|Stack\w*|Tabs?\w*|Navigation\w*|Navigator\w*|ExpoRoot|Route\w*|Slot|Suspense|Fragment|Provider|Consumer|\w+(Context|ContextProvider|Provider))$/;

export function isFrameworkComponent(name: string): boolean {
  return FRAMEWORK_COMPONENT.test(name);
}

function propType(p: string): string {
  return p.slice(p.lastIndexOf(':') + 1);
}

export function buildFindings(input: AnalyzeInput): Finding[] {
  const findings: Finding[] = [];
  const r = input.renders;

  if (r) {
    // Slow commits — the only React signal that maps directly onto dropped frames.
    const slow = r.commits
      .filter((c) => c.durationMs >= FRAME_BUDGET_MS)
      .sort((a, b) => b.durationMs - a.durationMs);
    for (const c of slow.slice(0, 5)) {
      let hotspots: WindowHotspot[] = [];
      if (input.cpuProfiles && input.cpuAnchor && input.reactStartedAt !== undefined) {
        const end = input.reactStartedAt + c.atMs;
        hotspots = cpuInWindow(
          input.cpuProfiles,
          input.cpuAnchor,
          end - c.durationMs - 5,
          end + 1,
          3,
          input.symbols
        );
      }
      findings.push({
        severity: c.durationMs >= 50 ? 'high' : 'medium',
        kind: 'slow-commit',
        title: `Commit #${c.index} took ${c.durationMs}ms (frame budget ${FRAME_BUDGET_MS}ms)`,
        detail:
          `At t+${(c.atMs / 1000).toFixed(2)}s, ${c.components} component(s) rendered; most ` +
          `self time in ${list(c.top.map((t) => `${t.name} ${t.selfMs}ms${t.reason ? ` (${t.reason})` : ''}`))}.` +
          (hotspots.length
            ? ` JS during the commit: ${list(hotspots.map((h) => `${h.name} ${h.selfMs}ms (${h.location})`))}.`
            : ''),
        suggestion:
          'Start with the top self-time component of this commit; if its reason is `parent`, ' +
          'memoize it, otherwise move the expensive work out of render (useMemo, or defer it).',
        component: c.top[0]?.name,
        impactMs: c.durationMs - FRAME_BUDGET_MS,
        evidence: { commit: c, cpuDuringCommit: hotspots },
      });
    }
    if (slow.length > 5) {
      findings.push({
        severity: 'medium',
        kind: 'slow-commit',
        title: `${slow.length - 5} more commit(s) over the ${FRAME_BUDGET_MS}ms frame budget`,
        detail: `Commits: ${slow
          .slice(5, 20)
          .map((c) => `#${c.index} ${c.durationMs}ms`)
          .join(', ')}${slow.length > 20 ? ', …' : ''}.`,
        suggestion: 'See `profile react renders --json` for the full commit list.',
        impactMs: slow.slice(5).reduce((a, c) => a + c.durationMs - FRAME_BUDGET_MS, 0),
        evidence: { commits: slow.slice(5).map((c) => c.index) },
      });
    }

    // Bursts: many commits back to back usually means a setState cascade.
    const times = r.commits.map((c) => c.atMs);
    let best = { n: 0, from: 0, to: 0 };
    for (let i = 0, j = 0; j < times.length; j++) {
      while (times[j] - times[i] > 100) i++;
      if (j - i + 1 > best.n) best = { n: j - i + 1, from: i, to: j };
    }
    if (best.n >= 5) {
      const burst = r.commits.slice(best.from, best.to + 1);
      const busy = burst.flatMap((c) => c.top.map((t) => t.name));
      findings.push({
        severity: best.n >= 10 ? 'high' : 'medium',
        kind: 'commit-burst',
        title: `${best.n} commits within 100ms (commits #${burst[0].index}–#${burst[burst.length - 1].index})`,
        detail:
          `Back-to-back commits at t+${(burst[0].atMs / 1000).toFixed(2)}s usually mean cascading ` +
          `updates — state set in an effect, or several stores notifying separately. ` +
          `Components involved: ${list([...new Set(busy)], 5)}.`,
        suggestion:
          'Batch the updates (one state object, or derive instead of syncing state in useEffect).',
        impactMs: burst.reduce((a, c) => a + c.durationMs, 0),
        evidence: { commits: burst.map((c) => c.index) },
      });
    }

    const totalSelf = r.components.reduce((a, c) => a + c.selfMs, 0);
    for (const c of r.components) {
      if (c.host) continue;
      const framework = isFrameworkComponent(c.name);
      // The app component to fix when a framework component is the one re-rendering.
      const appParent = framework
        ? c.parents.map((p) => p.name).find((p) => !isFrameworkComponent(p))
        : undefined;
      const parentRenders = c.reasons.parent ?? 0;
      if (parentRenders >= 3 && parentRenders / c.renders >= 0.5) {
        const wasted = round(c.avgSelfMs * parentRenders);
        const severity: Severity =
          parentRenders >= 20 || wasted >= FRAME_BUDGET_MS ? 'high' : sev(parentRenders, 10, 20);
        findings.push({
          severity: framework && !appParent ? 'low' : severity,
          kind: 'wasted-renders',
          title: appParent
            ? `${appParent} re-renders its ${c.name} children with unchanged props (${parentRenders}×)`
            : `${c.name} re-rendered ${parentRenders}× with unchanged props`,
          detail:
            `${parentRenders} of ${c.name}'s ${c.renders} renders got a new props object whose values were ` +
            `all identical — only its parent (${list(c.parents.map((p) => p.name))}) re-rendered. ` +
            `~${wasted}ms of self time.`,
          suggestion: appParent
            ? `Memoize ${appParent} (React.memo) or whatever makes it re-render.`
            : framework
              ? `${c.name} is a framework component; fix the app component above it.`
              : `Wrap ${c.name} in React.memo, or stop ${c.parents[0]?.name ?? 'its parent'} re-rendering.`,
          component: appParent ?? c.name,
          impactMs: wasted,
          evidence: {
            component: c.name,
            renders: c.renders,
            reasons: c.reasons,
            parents: c.parents,
          },
        });
      }
      const propRenders = c.reasons.props ?? 0;
      const unstable = c.changedProps.filter((p) => /^(fn|object|array)$/.test(propType(p.prop)));
      if (
        propRenders >= 3 &&
        unstable.length > 0 &&
        unstable[0].count >= propRenders * 0.5 &&
        unstable.length === c.changedProps.filter((p) => !/:removed$/.test(p.prop)).length
      ) {
        const props = [...new Set(unstable.map((p) => p.prop.slice(0, p.prop.lastIndexOf(':'))))];
        const owner = appParent ?? c.parents[0]?.name;
        const severity = sev(propRenders, 10, 30);
        findings.push({
          severity: framework && !appParent ? 'low' : severity,
          kind: 'unstable-props',
          title: appParent
            ? `${appParent} passes new ${list(props)} to ${c.name} on every render (${propRenders}×)`
            : `${c.name} re-rendered ${propRenders}× because ${list(props)} changed identity`,
          detail:
            `Only function/object props changed (${list(unstable.map((p) => `${p.prop} ×${p.count}`))}); ` +
            `these are usually recreated inline by ${owner ?? 'the parent'} on every render.`,
          suggestion: `Stabilise them in ${owner ?? 'the parent'} with useCallback / useMemo (or hoist constants).`,
          component: appParent ?? c.name,
          impactMs: round(c.avgSelfMs * propRenders),
          evidence: { component: c.name, changedProps: c.changedProps, parents: c.parents },
        });
      }
      if (framework) continue;
      if (c.renders >= 10 && c.commitShare >= 0.5 && r.totalCommits >= 10) {
        findings.push({
          severity: 'low',
          kind: 'frequent-renders',
          title: `${c.name} rendered in ${Math.round(c.commitShare * 100)}% of commits (${c.renders} renders)`,
          detail: `Reasons: ${Object.entries(c.reasons)
            .map(([k, v]) => `${k} ${v}`)
            .join(', ')}.`,
          suggestion:
            'A component that renders on nearly every commit is subscribed to something too broad — ' +
            'narrow its store/context selector.',
          component: c.name,
          impactMs: c.selfMs,
          evidence: { renders: c.renders, commitShare: c.commitShare, reasons: c.reasons },
        });
      }
      if (totalSelf > 0 && c.selfMs >= FRAME_BUDGET_MS && c.selfMs / totalSelf >= 0.1) {
        findings.push({
          severity: c.maxSelfMs >= FRAME_BUDGET_MS ? 'high' : 'medium',
          kind: 'render-hotspot',
          title: `${c.name} accounts for ${Math.round((c.selfMs / totalSelf) * 100)}% of render time (${c.selfMs}ms)`,
          detail: `${c.renders} renders, avg ${c.avgSelfMs}ms, max ${c.maxSelfMs}ms of its own work.`,
          suggestion: 'Move heavy computation out of render (useMemo) or split the component.',
          component: c.name,
          impactMs: c.selfMs,
          evidence: { selfMs: c.selfMs, renders: c.renders, maxSelfMs: c.maxSelfMs },
        });
      }
      if (c.maxInstances >= 50) {
        findings.push({
          severity: 'low',
          kind: 'many-instances',
          title: `${c.maxInstances} instances of ${c.name} rendered in one commit`,
          detail: 'A long list is rendering every row at once.',
          suggestion: 'Virtualize it (FlatList/FlashList) or memoize the row component.',
          component: c.name,
          impactMs: c.selfMs,
          evidence: { maxInstances: c.maxInstances },
        });
      }
    }
  }

  const cpu = input.cpu;
  if (cpu) {
    for (const f of cpu.top) {
      if (isIdleFrame(f.name) || f.selfPercent < 5 || f.samples < 10) continue;
      findings.push({
        severity: f.selfPercent >= 15 ? 'high' : 'medium',
        kind: 'js-hotspot',
        title: `JS function ${f.name} took ${f.selfPercent}% of sampled time (${f.selfMs}ms self)`,
        detail: `${f.samples} samples at ${f.source ?? f.location}; ${f.totalMs}ms including callees.`,
        suggestion:
          'Check whether it runs more often than needed (in render, per item, per frame).',
        function: f.name,
        location: f.source ?? f.location,
        impactMs: f.selfMs,
        evidence: { ...f },
      });
    }
    if (cpu.attribution.gcPercent >= 10) {
      findings.push({
        severity: cpu.attribution.gcPercent >= 25 ? 'high' : 'medium',
        kind: 'gc-pressure',
        title: `Hermes spent ${cpu.attribution.gcPercent}% of sampled time in GC`,
        detail:
          'Allocation churn — many short-lived objects/arrays/closures per render or per frame.',
        suggestion:
          'Look for objects/arrays rebuilt every render and large lists copied on update; ' +
          'confirm with `profile memory --track`.',
        impactMs: round((cpu.durationMs * cpu.attribution.gcPercent) / 100),
        evidence: { attribution: cpu.attribution },
      });
    }
  }

  const n = input.native;
  if (n) {
    // Only app-owned native code is actionable here; system and RN-runtime symbols
    // (the Hermes interpreter running JS, libm called from JS) are what the JS
    // profile already explains.
    const own = n.appFrames ?? n.symbols.filter((x) => x.app);
    for (const s of own) {
      if (s.percent < 5) continue;
      findings.push({
        severity: s.percent >= 15 ? 'high' : 'medium',
        kind: 'native-hotspot',
        title: `Native ${s.symbol} was on the stack in ${s.percent}% of CPU samples`,
        detail: `In ${s.library} (app code)${s.selfMs !== undefined ? `, ${s.selfMs}ms on the stack` : ''}.`,
        suggestion:
          'The app’s own native code — open the trace in Instruments / Android Studio for its call tree.',
        function: s.symbol,
        impactMs: s.selfMs ?? 0,
        evidence: { ...s },
      });
    }
    for (const h of n.hangs ?? []) {
      findings.push({
        severity: h.durationMs >= 500 || /severe|^hang$/i.test(h.kind) ? 'high' : 'medium',
        kind: 'hang',
        title: `Main thread hung for ${h.durationMs}ms (${h.kind}) at t+${(h.startMs / 1000).toFixed(2)}s`,
        detail: h.top.length
          ? `Busiest during the hang: ${list(h.top.map((t) => `${t.symbol} ${t.selfMs}ms`))}.`
          : 'No main-thread samples attributed to the hang window.',
        suggestion: 'Move the work off the main thread, or split it across frames.',
        impactMs: h.durationMs,
        evidence: { ...h },
      });
    }
  }

  return findings.sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.impactMs - a.impactMs
  );
}

// ── Baselines ─────────────────────────────────────────────────────────────────

export interface ProfileBaseline {
  version: 1;
  savedAt: string;
  totalCommits?: number;
  components: Record<string, { renders: number; selfMs: number }>;
  functions: Record<string, { selfMs: number }>;
  native: Record<string, { percent: number }>;
}

export function toBaseline(input: AnalyzeInput): ProfileBaseline {
  const b: ProfileBaseline = {
    version: 1,
    savedAt: new Date().toISOString(),
    totalCommits: input.renders?.totalCommits,
    components: {},
    functions: {},
    native: {},
  };
  for (const c of input.renders?.components ?? []) {
    if (!c.host) b.components[c.name] = { renders: c.renders, selfMs: c.selfMs };
  }
  for (const f of input.cpu?.top ?? []) {
    if (isIdleFrame(f.name)) continue;
    b.functions[`${f.name} ${f.source ?? f.location}`] = { selfMs: f.selfMs };
  }
  for (const s of input.native?.symbols ?? []) {
    b.native[`${s.symbol} [${s.library}]`] = { percent: s.percent };
  }
  return b;
}

export interface BaselineDelta {
  kind: 'component' | 'function' | 'native';
  name: string;
  metric: 'renders' | 'selfMs' | 'percent';
  before: number;
  after: number;
  changePercent: number | null;
  verdict: 'regression' | 'improvement' | 'new' | 'gone';
}

/**
 * Compare two runs. Flags changes beyond ±20% that are also large in absolute
 * terms — a component going from 1 to 2 renders is +100% and means nothing.
 */
export function diffBaselines(
  before: ProfileBaseline,
  after: ProfileBaseline,
  thresholdPercent = 20
): BaselineDelta[] {
  const out: BaselineDelta[] = [];
  const cmp = (
    kind: BaselineDelta['kind'],
    name: string,
    metric: BaselineDelta['metric'],
    a: number | undefined,
    b: number | undefined,
    minAbs: number
  ): void => {
    if (a === undefined && b === undefined) return;
    if (a === undefined) {
      if (b! >= minAbs)
        out.push({ kind, name, metric, before: 0, after: b!, changePercent: null, verdict: 'new' });
      return;
    }
    if (b === undefined) {
      if (a >= minAbs)
        out.push({ kind, name, metric, before: a, after: 0, changePercent: null, verdict: 'gone' });
      return;
    }
    if (Math.abs(b - a) < minAbs) return;
    const pct = a > 0 ? round(((b - a) / a) * 100, 1) : null;
    if (pct !== null && Math.abs(pct) < thresholdPercent) return;
    out.push({
      kind,
      name,
      metric,
      before: a,
      after: b,
      changePercent: pct,
      verdict: b > a ? 'regression' : 'improvement',
    });
  };
  const names = (x: Record<string, unknown>, y: Record<string, unknown>): string[] => [
    ...new Set([...Object.keys(x), ...Object.keys(y)]),
  ];
  for (const k of names(before.components, after.components)) {
    cmp('component', k, 'renders', before.components[k]?.renders, after.components[k]?.renders, 3);
    cmp('component', k, 'selfMs', before.components[k]?.selfMs, after.components[k]?.selfMs, 2);
  }
  for (const k of names(before.functions, after.functions)) {
    cmp('function', k, 'selfMs', before.functions[k]?.selfMs, after.functions[k]?.selfMs, 5);
  }
  for (const k of names(before.native, after.native)) {
    cmp('native', k, 'percent', before.native[k]?.percent, after.native[k]?.percent, 1);
  }
  const order = { regression: 0, new: 1, improvement: 2, gone: 3 };
  return out.sort(
    (x, y) =>
      order[x.verdict] - order[y.verdict] ||
      Math.abs(y.after - y.before) - Math.abs(x.after - x.before)
  );
}
