# Profiling TV performance

"Sluggish" on a TV is a frame-timing complaint. This page covers which
measurements Conductor can take, which target each one works against, and
where the numbers can and can't be trusted.

## Target matrix

Three things get called "Fire TV" and they are not the same target.

| Target                                   | Conductor platform | How you connect                     |
| ---------------------------------------- | ------------------ | ----------------------------------- |
| Physical Fire TV Stick / Fire TV Cube    | `android`          | USB, or `adb connect <ip>:5555`     |
| Physical Android TV (Shield, Chromecast) | `android`          | `adb connect <ip>:5555`             |
| Android TV emulator (AVD)                | `android`          | booted AVD, `emulator-<port>`       |
| Vega VVD (Amazon's virtual device)       | `vega`             | `conductor start-device --platform vega` |

**Fire OS is Android.** A physical Fire TV Stick reports as `android` and every
Android capability below applies to it unchanged — that includes `dumpsys`,
`simpleperf` and logcat.

**Vega is not Android.** Vega OS is Amazon's own Linux-based platform for newer
devices. It has no `dumpsys`, no `simpleperf` and no ART, so the Android-only
rows below are genuinely unavailable there rather than merely unimplemented.

| Capability                                    | android (incl. Fire TV Stick) | vega | ios / tvos |
| --------------------------------------------- | ----------------------------- | ---- | ---------- |
| `profile frames` (gfxinfo jank / frame timing) | ✅                             | ❌    | ❌          |
| `profile cpu` (native trace)                   | ✅ simpleperf                  | ❌    | ✅ xctrace  |
| `profile cpu --report` (symbolized table)      | ✅                             | ❌    | ❌          |
| `profile memory --track` (heap growth + GC)    | ✅                             | partial | partial |
| `press-key --measure` focus→move latency       | ✅                             | ✅    | ✅          |
| `press-key --measure` device-side press→frame  | ✅                             | ❌    | ❌          |
| gfxinfo `inputLatency` (NewestInputEvent)      | device-dependent — see below  | ❌    | ❌          |
| `profile js` (Hermes sampler)                  | ✅ via Metro                   | ✅ via Metro | ✅ via Metro |
| `profile react` (commit profiler)              | ✅ via Metro                   | ✅ via Metro | ✅ via Metro |
| `memory --leaks`                               | ❌                             | ❌    | ✅          |

## What works on a release build

This is usually the constraint that matters: a debug build is already slower
than what users run, so a measurement that requires one can't confirm the
reported problem.

**Release-safe** — no debugger, no DevTools hook, no instrumentation:

- `profile frames` — reads HWUI's own counters over adb.
- `profile cpu [--report]` — simpleperf samples the process as it is.
- `profile memory --track` — `dumpsys meminfo` plus ART's GC logging.
- `press-key --measure` — its `pressToFrame` figure is derived from device-side
  clocks and gfxinfo, so it needs nothing from the app.

**Needs a dev or profiling build** — both attach over Metro:

- `profile js` needs a Hermes runtime with the inspector reachable.
- `profile react` additionally needs React's profiling instrumentation
  (`actualDuration` on fibers), which release builds strip. It says so
  explicitly rather than reporting zeroes.

## Reading `profile frames`

```
conductor profile frames report --track 20 --device <serial>
```

Resets the counters, samples for 20s, then reports. Two independent views:

- **Summary counters** — cumulative and exact for the whole window
  (`totalFrames`, `jankyFrames`, the platform's own percentiles, and the
  `slowUiThread` / `missedVsync` / `slowBitmapUploads` breakdown).
- **Per-frame stats** — computed from the `framestats` CSV, giving p50–p99 of
  `IntendedVsync → FrameCompleted` plus a phase breakdown.

The phase breakdown is the attribution step. Compare each phase's p95 against
its p50:

| Phase dominates | Usually means                                                |
| --------------- | ------------------------------------------------------------ |
| `vsyncDelay`    | The UI thread was busy elsewhere and missed its wake-up — on RN this is often JS blocking the bridge or a long native callback. |
| `traversal`     | Measure/layout cost — deep view trees, expensive `onLayout`.  |
| `draw`          | Display-list recording — overdraw, complex shadows/rounding.  |
| `issueDraw`     | Render-thread GPU work, including texture uploads.            |
| `swap`          | Buffer queue / display back-pressure, not app work.           |

The on-device `framestats` ring buffer only holds ~120 frames (about 2s at
60fps), so `--track` polls and merges by frame vsync timestamp to cover the
whole window. If polling can't keep up, the report says so in a `note` instead
of silently reporting the tail. The summary counters are unaffected either way.

## Comparing before and after

```
conductor profile frames report --track 20 --save-baseline before
# ... change something, rebuild, reinstall ...
conductor profile frames report --track 20 --diff before
```

`--baselines` lists what you've saved. Baselines live in
`~/.conductor/frame-baselines/`.

For flows, `run-flow --benchmark --repeat 10 --json` gives per-command p50/p90
and standard deviation, which is what you want on TV where single-run variance
is large.

## Measured transport and device numbers

These are measurements, not estimates. Taken on an NVIDIA SHIELD Android TV
(`darcy`, arm64-v8a, 3.0GB, over networked adb) and a Fire TV Stick 4K Max
(`AFTKM`/`karat`, **armeabi-v7a**, 1.7GB, over USB), both Android 11 / API 30.

| | Fire TV Stick 4K Max (USB) | SHIELD (networked adb) |
|---|---|---|
| `adb shell true` round trip | 28ms | 35ms (bursts to 220ms) |
| One `dumpsys gfxinfo framestats` | 73ms | 307ms |
| framestats ring buffer | 120 frames | 120 frames |
| `adb shell input keyevent` **on-device cost** | — | **713ms** |
| `sendevent` (full key press) on-device | — | 60ms |
| `NewestInputEvent` populated? | **yes** (1–2 frames/press) | **no**, ever |

Three things fall out of that table:

**Prefer USB to networked adb for anything host-timed.** The round trip itself
is similar, but transferring a framestats dump is 4× cheaper over USB, and
networked adb has a long tail that a cable does not.

**`adb shell input keyevent` costs ~713ms on the device**, because it starts a
JVM (`app_process`) per invocation. That is not transport — it is on-device
time, and it dwarfs anything you are trying to measure. It also means a
`run-flow --benchmark` driving a TV app through `input` is substantially
measuring JVM startup. Benchmark numbers are only comparable within one
connection type and one input path.

**The Stick is 32-bit** (`armeabi-v7a`) where the Shield is 64-bit. Different
Hermes build, different native ABI, different JIT behaviour. Do not assume a
native CPU profile transfers between them even in shape.

## `--track` interval, and why the default is 1000ms

The ring buffer holds 120 frames, which at 60fps drains in ~2s. `--track` polls
and merges by vsync timestamp, so the interval plus one dump must stay inside
that window.

Measured on a Fire TV Stick 4K Max with the UI under continuous D-pad input
(~60fps sustained, 596 frames in 10s):

| `--interval` | Frames counted | Frames captured | Coverage |
|---|---|---|---|
| 1000ms (default) | 596 | 596 | 100% |
| 3000ms | 609 | 404 | 66% |

1000ms achieves full coverage on the slower of the two devices while it is
genuinely saturated, and spends ~7% of the window dumping over USB (~30% over
networked adb). Going tighter buys nothing and perturbs more.

When coverage does drop, the report carries a structured `poll-gap` note with
the measured `coveragePercent` and a `suggestedIntervalMs` — at 3000ms above it
suggested 1592ms. A poll merely *seeing* a full buffer is normal on a busy
device and is not by itself reported as a problem; only actual frame loss is.

## `NewestInputEvent` is opportunistic — check before relying on it

The framestats CSV has `OldestInputEvent` / `NewestInputEvent` columns that give
input-to-frame latency measured on-device in nanoseconds. **Whether they are
populated at all is device- and app-dependent**, and the failure is silent —
unpopulated columns hold `0` and `INT64_MAX` respectively, which a naive parser
reads as a timestamp.

Measured with the *same* injected `adb shell input keyevent`:

- Fire TV Stick 4K Max + Fire TV launcher: **populated**, 1–2 frames per press,
  yielding input→frame latencies of 25–72ms.
- SHIELD + Google TV launcher: **never populated**, across key and touch events,
  and including injection through the kernel input node (`sendevent`) which is
  indistinguishable from a physical remote press at the framework level.

So this is not "automation can't use it" — the same automation works on one
device and not the other. Treat the field as a bonus: `profile frames` reports
`inputLatency` only when frames actually carried timestamps, and emits a
`no-input-timestamps` note when they did not, so absence is never mistaken for
"no input occurred". For a measurement that does not depend on it, use
`press-key --measure`, whose `pressToFrame` is derived from device-side clocks.

## Correlating frames with React commits

Every `profile frames` report carries a `clockAnchor`. The device's
`CLOCK_MONOTONIC` (the domain of framestats vsync timestamps) and
`CLOCK_REALTIME` (the domain of `Date.now()` inside the app, which is what
`profile react` stamps commits with) are read in a *single* adb invocation
bracketing the dump, so adb round-trip affects when the offset is learned, not
how accurate it is. Measured anchor error: **±16ms on the Shield, ±44ms on a
busy Fire TV** — and the derived offset was stable to ~3ms across repeats.

Each frame in `worst` carries `atDeviceRealtimeMs`, directly comparable to a
React commit's `at`. That is what turns "component X is expensive on average"
into "component X caused *that* dropped frame".

## Emulator fidelity — the honest answer

**Use real hardware for anything you intend to trust.**

An Android TV AVD on an Apple-silicon Mac runs an arm64 guest on a much faster
host with a far faster GPU. A Fire TV Stick 4K is roughly an order of magnitude
slower on both. In practice this means a jank problem reported on a Stick often
will not reproduce on the AVD at all, and a fix "verified" on the AVD is not
verified.

Conductor deliberately does not offer a `--throttle` flag for native Android,
because there is no knob that would make one honest:

- The Android emulator has no CPU-throttling equivalent to CDP's
  `Emulation.setCPUThrottlingRate` (which is why the Lightning/web benchmark
  harness in this repo can throttle and this cannot).
- `adb shell` cpuset/cgroup pinning needs root, which stock Fire OS does not
  give you, and on an emulator it changes scheduling without changing per-core
  speed or GPU throughput — so it distorts the profile rather than scaling it.
- Creating an AVD with fewer cores and less RAM does shift the numbers, but not
  in proportion to any real device, so the result is a different machine rather
  than a slower one.

What is worth doing on an emulator: catching *algorithmic* regressions that show
up as a raw work count rather than as wall-clock time — React commit counts from
`profile react`, JS self-time ranking from `profile js`, GC collection counts
from `profile memory --track`. Those are comparable across machines in a way
that frame timing is not. Take frame timing on the device you actually ship to.
