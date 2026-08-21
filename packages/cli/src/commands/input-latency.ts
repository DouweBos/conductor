/**
 * Input-to-response latency for `press-key --measure`.
 *
 * Three things had to be got right here, all of them learned by measuring on
 * real Android TV hardware over networked adb rather than assumed:
 *
 *  - **A repeat is not a repeated measurement.** Pressing Right twenty times
 *    walks focus across twenty *different* transitions, some cheap, some
 *    crossing into a lazily-mounted row. Samples are therefore grouped by the
 *    transition they actually performed, and the aggregate is reported
 *    alongside — never instead of — the per-transition breakdown.
 *
 *  - **Focus refusing to move is not a hang.** At the end of a rail the app is
 *    correctly declining to move focus. Reporting that as a timeout would be
 *    evidence of the sluggishness we are hunting, invented out of correct
 *    behaviour. `outcome` distinguishes `moved` / `unchanged` / `query-failed`.
 *
 *  - **Over networked adb, host-side polling cannot measure this at all.** One
 *    hierarchy dump costs a full round trip (~400ms on a LAN); focus on a
 *    healthy TV app moves in 50-150ms. The polling result is then a measurement
 *    of the network with a deceptively tight variance, so when `pollCost`
 *    dominates we say so in a structured note. The measurement that does work
 *    is `pressToFrame`, which is computed entirely from device-side clocks.
 */
import { getDriver, detectFirstDevice } from '../runner.js';
import { detectPlatform } from '../drivers/bootstrap.js';
import { queryFocused, focusKey } from './focused.js';
import { dispatchKey, ANDROID_KEYCODE, Key, AnyDriver } from './press-key.js';
import { describe, round, fmt, Distribution, hasSamples } from '../stats.js';
import { adbShell, shellBracketed, resolveAndroidForegroundApp } from '../android/device.js';
import { parseFramestats, toFrameSample, FrameSample } from './profile-frames.js';

export interface MeasureOptions {
  repeat: number;
  timeoutMs: number;
  /** Delay between focus polls. 0 = poll as fast as the hierarchy dump returns. */
  pollIntervalMs: number;
  /** Keys to cycle through, so repeats can oscillate instead of drifting. */
  sequence?: Key[];
  appId?: string;
  holdSeconds?: number;
  /** How long to let the device render after a press before reading frames. */
  settleMs: number;
}

export type SampleOutcome = 'moved' | 'unchanged' | 'query-failed';

export interface LatencyNote {
  code:
    | 'round-trip-bound'
    | 'no-press-to-frame'
    | 'boundary-refusals'
    | 'query-failures'
    | 'driver-perturbation';
  message: string;
  pollCostP50Ms?: number;
  focusChangeP50Ms?: number;
  ratio?: number;
  /** For driver-perturbation: what the injection itself costs on the device. */
  injectionCostMs?: number;
}

/** Device-side view of what the app did in response to one press. */
export interface PressResponse {
  /**
   * First responding frame's completion, measured from the *end* of the
   * dispatch window — a lower bound that contains no host or adb time.
   */
  pressToFrameMs: number;
  /** Same, measured from the start of the window: the upper bound. */
  pressToFrameUpperMs: number;
  /** Width of the dispatch window, i.e. how imprecisely the press is located. */
  dispatchWindowMs: number;
  /** First response frame's vsync → last frame's completion: time to settle. */
  renderBurstMs: number;
  framesInBurst: number;
  /** Frames in the burst that exceeded one 60Hz budget. */
  jankyInBurst: number;
}

export interface LatencySample {
  index: number;
  key: string;
  outcome: SampleOutcome;
  /** Press → first poll that saw different focus. `null` unless outcome is `moved`. */
  elapsedMs: number | null;
  /** Host→device time to deliver the press. Not latency the user feels. */
  dispatchMs: number;
  polls: number;
  from: string;
  to: string;
  response?: PressResponse;
  /** On-device cost of the injection itself. Load applied beside the measurement. */
  injectionCostMs?: number;
}

export interface TransitionStats {
  from: string;
  to: string;
  key: string;
  count: number;
  focusChange: Distribution;
  pressToFrame: Distribution;
}

export interface LatencyReport {
  keys: string[];
  deviceId: string;
  platform: string;
  appId?: string;
  samples: LatencySample[];
  outcomes: Record<SampleOutcome, number>;
  /** Aggregate over samples that moved. Read `byTransition` before trusting it. */
  focusChange?: Distribution;
  /** Device-side press→frame across samples that produced a response. */
  pressToFrame?: Distribution;
  /** Cost of a single focus query — the resolution floor of `focusChange`. */
  pollCost?: Distribution;
  /** Per distinct focus transition, so one slow rail is visible as one slow rail. */
  byTransition: TransitionStats[];
  notes: LatencyNote[];
}

async function resolveDeviceId(sessionName: string): Promise<string> {
  if (sessionName !== 'default') return sessionName;
  const detected = await detectFirstDevice().catch(() => undefined);
  if (!detected) throw new Error('no device found; pass --device');
  return detected;
}

/**
 * Reset, inject, timestamp, settle and dump — all inside one device-side shell.
 *
 * The timestamp is taken *after* the injection command returns rather than
 * before it. `adb shell input keyevent` costs ~713ms on the device because it
 * spawns an `app_process` JVM per invocation, and that cost lands entirely
 * before the event is dispatched (`input` injects with WAIT_FOR_FINISH and then
 * exits). Reading the clock afterwards therefore puts the press timestamp
 * within a few ms of the actual injection instead of 713ms early, which is the
 * difference between reporting the app's latency and reporting JVM startup.
 *
 * What this does *not* fix is contention: spawning and tearing down a JVM
 * beside the frames being measured is load, and on a 1.7GB device it competes
 * for exactly the resources whose scarcity we are looking for. That residual is
 * reported as a `driver-perturbation` note rather than hidden.
 */
async function measurePressResponse(
  deviceId: string,
  appId: string,
  keycode: number,
  settleMs: number
): Promise<{ response: PressResponse; injectionCostMs: number } | undefined> {
  const bracket = await shellBracketed(
    deviceId,
    `dumpsys gfxinfo ${appId} reset; cat /proc/uptime; input keyevent ${keycode}; ` +
      `cat /proc/uptime; sleep ${(settleMs / 1000).toFixed(2)}; ` +
      `dumpsys gfxinfo ${appId} framestats`
  );
  if (!bracket) return undefined;
  const stamps = [...bracket.stdout.matchAll(/^\s*(\d+\.\d+)\s+\d+\.\d+\s*$/gm)].map(
    (m) => Number(m[1]) * 1000
  );
  if (stamps.length < 2) return undefined;
  const [beforeInject, afterInject] = stamps;

  const frames = parseFramestats(bracket.stdout)
    .map((r) => toFrameSample(r))
    .filter((f): f is FrameSample => f !== null)
    .sort((a, b) => a.vsyncNs - b.vsyncNs);

  // A frame that *started* after the injection is a response to it. Frames
  // drawn during JVM startup are in the buffer too and must not be counted.
  const responding = frames.filter((f) => f.vsyncNs / 1e6 >= afterInject);
  if (responding.length === 0) return undefined;

  const first = responding[0];
  const last = responding[responding.length - 1];
  return {
    injectionCostMs: round(afterInject - beforeInject),
    response: {
      pressToFrameMs: round(first.completedNs / 1e6 - afterInject),
      pressToFrameUpperMs: round(first.completedNs / 1e6 - beforeInject),
      dispatchWindowMs: round(afterInject - beforeInject),
      renderBurstMs: round((last.completedNs - first.vsyncNs) / 1e6),
      framesInBurst: responding.length,
      jankyInBurst: responding.filter((f) => f.totalMs > 16.67).length,
    },
  };
}

/** One sample: press, then poll focus until its identity changes or we give up. */
async function sampleOnce(
  driver: AnyDriver,
  key: Key,
  index: number,
  opts: MeasureOptions,
  pollCosts: number[],
  androidTarget: { deviceId: string; appId: string } | undefined
): Promise<LatencySample> {
  let before: Record<string, unknown> | null;
  try {
    before = await queryFocused(driver);
  } catch {
    return {
      index,
      key,
      outcome: 'query-failed',
      elapsedMs: null,
      dispatchMs: 0,
      polls: 0,
      from: '(unknown)',
      to: '(unknown)',
    };
  }
  const beforeKey = focusKey(before);

  let response: PressResponse | undefined;
  let injectionCostMs: number | undefined;
  let dispatchMs = 0;

  const t0 = performance.now();
  const keycode = androidTarget ? ANDROID_KEYCODE[key] : undefined;
  if (androidTarget && keycode !== undefined) {
    // Injection happens inside the device-side bracket, so the press is timed
    // in the device's own clock domain with no host or adb time in the window.
    const measured = await measurePressResponse(
      androidTarget.deviceId,
      androidTarget.appId,
      keycode,
      opts.settleMs
    );
    dispatchMs = round(performance.now() - t0);
    response = measured?.response;
    injectionCostMs = measured?.injectionCostMs;
    // The bracket already waited out the settle, so focus has landed.
  } else {
    const t = performance.now();
    await dispatchKey(driver, key, opts.holdSeconds);
    dispatchMs = round(performance.now() - t);
  }

  const deadline = performance.now() + opts.timeoutMs;
  let polls = 0;
  let queryFailed = false;
  let lastKey = beforeKey;

  while (performance.now() < deadline) {
    const pollStart = performance.now();
    let current: Record<string, unknown> | null;
    try {
      current = await queryFocused(driver);
    } catch {
      queryFailed = true;
      break;
    }
    const pollEnd = performance.now();
    pollCosts.push(round(pollEnd - pollStart));
    polls++;
    lastKey = focusKey(current);
    if (lastKey !== beforeKey) {
      return {
        index,
        key,
        outcome: 'moved',
        // pollEnd is an upper bound: the change could have landed any time
        // during this dump. pollCost is the error bar.
        elapsedMs: round(pollEnd - t0),
        dispatchMs,
        polls,
        from: beforeKey,
        to: lastKey,
        response,
        injectionCostMs,
      };
    }
    if (opts.pollIntervalMs > 0) {
      await new Promise((r) => setTimeout(r, opts.pollIntervalMs));
    }
  }

  return {
    index,
    key,
    // Focus queries kept succeeding and the identity never changed: the app is
    // responding, it simply did not move focus. That is a boundary, not a hang.
    outcome: queryFailed ? 'query-failed' : 'unchanged',
    elapsedMs: null,
    dispatchMs,
    polls,
    from: beforeKey,
    to: lastKey,
    response,
    injectionCostMs,
  };
}

function groupByTransition(samples: LatencySample[]): TransitionStats[] {
  const groups = new Map<string, LatencySample[]>();
  for (const s of samples) {
    if (s.outcome !== 'moved') continue;
    const id = `${s.key} ${s.from} ${s.to}`;
    groups.set(id, [...(groups.get(id) ?? []), s]);
  }
  return [...groups.entries()]
    .map(([id, group]) => {
      const [key, from, to] = id.split(' ');
      return {
        key,
        from,
        to,
        count: group.length,
        focusChange: describe(group.map((s) => s.elapsedMs).filter((v): v is number => v !== null)),
        pressToFrame: describe(
          group.map((s) => s.response?.pressToFrameMs).filter((v): v is number => v !== undefined)
        ),
      };
    })
    .sort(
      (a, b) =>
        (b.pressToFrame.p50Ms ?? b.focusChange.p50Ms ?? 0) -
        (a.pressToFrame.p50Ms ?? a.focusChange.p50Ms ?? 0)
    );
}

export async function measureKeyLatency(
  sessionName: string,
  keys: Key[],
  opts: MeasureOptions
): Promise<LatencyReport> {
  const deviceId = await resolveDeviceId(sessionName);
  const platform = await detectPlatform(deviceId).catch(() => 'unknown');
  const driver = await getDriver(sessionName);
  const notes: LatencyNote[] = [];

  let androidTarget: { deviceId: string; appId: string } | undefined;
  let appId: string | undefined;
  if (platform === 'android') {
    appId = opts.appId ?? (await resolveAndroidForegroundApp(deviceId));
    if (appId) {
      const probe = await adbShell(deviceId, ['dumpsys', 'gfxinfo', appId]);
      if (probe.success) androidTarget = { deviceId, appId };
    }
  }

  const pollCosts: number[] = [];
  const samples: LatencySample[] = [];
  for (let i = 0; i < opts.repeat; i++) {
    samples.push(
      await sampleOnce(driver, keys[i % keys.length], i, opts, pollCosts, androidTarget)
    );
  }

  const outcomes: Record<SampleOutcome, number> = { moved: 0, unchanged: 0, 'query-failed': 0 };
  for (const s of samples) outcomes[s.outcome]++;

  const moved = samples.filter((s) => s.elapsedMs !== null).map((s) => s.elapsedMs!);
  const responses = samples
    .map((s) => s.response?.pressToFrameMs)
    .filter((v): v is number => v !== undefined);

  const focusChange = moved.length > 0 ? describe(moved) : undefined;
  const pollCost = pollCosts.length > 0 ? describe(pollCosts) : undefined;
  const pressToFrame = responses.length > 0 ? describe(responses) : undefined;

  // A poll that costs more than the thing it is timing is measuring itself.
  if (hasSamples(focusChange) && hasSamples(pollCost)) {
    const ratio = round(pollCost.p50Ms / focusChange.p50Ms);
    if (ratio > 0.5) {
      notes.push({
        code: 'round-trip-bound',
        message:
          `One focus query costs ${pollCost.p50Ms}ms against a focusChange of ` +
          `${focusChange.p50Ms}ms, so this result is bounded by transport, not by the app. ` +
          `Its small variance reflects a stable connection rather than a precise measurement. ` +
          (pressToFrame
            ? 'Use pressToFrame, which is computed from device-side clocks.'
            : 'Connect over USB rather than networked adb, or profile with `profile frames`.'),
        pollCostP50Ms: pollCost.p50Ms,
        focusChangeP50Ms: focusChange.p50Ms,
        ratio,
      });
    }
  }

  // The harness spawns a JVM per keypress. On a memory-constrained TV that is
  // load landing on exactly the resources whose scarcity we are measuring, so
  // it is declared rather than left for the reader to infer.
  const injectionCosts = samples
    .map((s) => s.injectionCostMs)
    .filter((v): v is number => v !== undefined);
  if (injectionCosts.length > 0) {
    const cost = describe(injectionCosts);
    if (hasSamples(cost) && cost.p50Ms > 100) {
      notes.push({
        code: 'driver-perturbation',
        message:
          `Each press is injected with \`adb shell input keyevent\`, which spawns an ` +
          `app_process JVM on the device and cost ${cost.p50Ms}ms here. That process starts and ` +
          `tears down alongside the frames being measured, so on a memory-constrained device ` +
          `some of the jank in this window is the harness. pressToFrame excludes the startup ` +
          `time but cannot exclude the contention.`,
        injectionCostMs: cost.p50Ms,
      });
    }
  }

  if (androidTarget && !pressToFrame) {
    notes.push({
      code: 'no-press-to-frame',
      message:
        'No frames were attributable to any press, so the device-side measurement is absent. ' +
        'The app may not be redrawing in response, or --settle is too short.',
    });
  }

  if (outcomes.unchanged > 0) {
    notes.push({
      code: 'boundary-refusals',
      message:
        `${outcomes.unchanged}/${samples.length} press(es) left focus where it was while focus ` +
        `queries kept succeeding. That is the app declining to move — a rail edge, or a key this ` +
        `screen ignores — not a hang, and it is excluded from the latency figures.`,
    });
  }
  if (outcomes['query-failed'] > 0) {
    notes.push({
      code: 'query-failures',
      message:
        `${outcomes['query-failed']}/${samples.length} sample(s) could not read the focused ` +
        `element at all. Unlike a boundary refusal this does suggest the app or driver is wedged.`,
    });
  }

  return {
    keys: [...new Set(keys)],
    deviceId,
    platform,
    appId,
    samples,
    outcomes,
    focusChange,
    pressToFrame,
    pollCost,
    byTransition: groupByTransition(samples),
    notes,
  };
}

function line(label: string, d: Distribution | undefined): string {
  if (!hasSamples(d)) return `  ${label.padEnd(14)} n/a`;
  return (
    `  ${label.padEnd(14)} p50 ${fmt(d.p50Ms)}  p90 ${fmt(d.p90Ms)}  p99 ${fmt(d.p99Ms)}  ` +
    `max ${fmt(d.maxMs)}  (n=${d.count}, σ ${fmt(d.stddevMs)})`
  );
}

function shortId(key: string): string {
  const [id, , bounds] = key.split('|');
  return id || bounds || key;
}

export function printLatencyReport(r: LatencyReport): void {
  console.log(
    `press-key ${r.keys.join(',')} --measure — ${r.samples.length} sample(s) on ${r.deviceId}`
  );
  console.log(
    `  outcomes:      moved=${r.outcomes.moved} unchanged=${r.outcomes.unchanged} ` +
      `queryFailed=${r.outcomes['query-failed']}`
  );
  if (r.pressToFrame) console.log(line('press→frame', r.pressToFrame));
  console.log(line('focus→move', r.focusChange));
  console.log(line('poll cost', r.pollCost));

  if (r.byTransition.length > 0) {
    console.log('\n  by transition (aggregates above mix these together)');
    for (const t of r.byTransition) {
      const primary = hasSamples(t.pressToFrame) ? t.pressToFrame : t.focusChange;
      const which = hasSamples(t.pressToFrame) ? 'press→frame' : 'focus→move';
      console.log(
        `    ${t.key}  ${shortId(t.from)} → ${shortId(t.to)}  ` +
          `${which} p50 ${fmt(primary.p50Ms)} max ${fmt(primary.maxMs)} (n=${t.count})`
      );
    }
  }

  const withBurst = r.samples.filter((s) => s.response);
  if (withBurst.length > 0) {
    const burst = describe(withBurst.map((s) => s.response!.renderBurstMs));
    console.log(line('render burst', burst));
    const window = describe(withBurst.map((s) => s.response!.dispatchWindowMs));
    console.log(
      `  dispatch window p50 ${fmt(window.p50Ms)} — press→frame is a lower bound; ` +
        `its upper bound is that much higher.`
    );
  }

  for (const note of r.notes) console.log(`\n  note [${note.code}]: ${note.message}`);
}
