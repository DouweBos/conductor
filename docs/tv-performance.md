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

**Release-safe** — nothing required of the app at all:

- `profile frames` — reads HWUI's own counters over adb.
- `profile memory --track` — `dumpsys meminfo`, plus collections inferred from
  the heap series (see below; ART's own GC logging is not dependable).
- `press-key --measure` — its `pressToFrame` figure is derived from device-side
  clocks and gfxinfo, so it needs nothing from the app.

That is the whole list. Everything else needs the build to permit it.

**Needs `android:debuggable` or `<profileable android:shell="true"/>`:**

- `profile cpu [--report]` — simpleperf refuses to attach to a process that is
  neither. A stock release APK is neither, and the failure is otherwise opaque
  (`exited with 1` under a wall of PMU-probing chatter), so conductor checks the
  package flags and says which manifest change would fix it. `profileable` is
  the right one for a perf build: one line, and the build stays a release build.

**Needs a dev or profiling build** — both attach over Metro:

- `profile js` needs a Hermes runtime with the inspector reachable. **Release
  Hermes ships without the inspector and never connects to Metro**, so this is
  not a configuration you can turn on — there is simply no CDP target to attach
  to. One consequence worth planning around: the Hermes GC share is not
  measurable on a release build, so it cannot be compared across build types.
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

Before trusting a navigation capture, read *The harness perturbs what it
measures* below — on TV you cannot drive focus and measure frames independently,
and that affects how these numbers should be read.

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

## The harness perturbs what it measures, and TV gives you no way around it

`AndroidDriver.pressKeyEvent` — which every input path funnels through
(`press-key`, `run-flow`'s `pressKey`, `hide-keyboard`, the streaming-input
backend) — is `adb shell input keyevent`. That spawns an `app_process` JVM on
the device per keypress, measured at ~713ms. The process starts and tears down
*alongside* the frames being measured, so on a 1.7GB Stick it competes for
exactly the resources whose scarcity you are trying to detect.

On mobile this has an easy answer: fling the list and measure the momentum
scroll after your finger leaves the glass. **That answer does not exist on TV.**
Focus moves one discrete step per keypress and stops dead — no fling, no
inertia, nothing self-propelled. Navigation is 100% input-driven by
construction, which means the contamination lands precisely on the symptom
users complain about.

What you *can* capture with no harness input at all:

- idle screens
- screen-load settles and cold start
- self-running animations — autoplay previews, theme music, carousel
  auto-advance

That is a genuinely useful set, and an idle-screen capture is a good first
experiment. But it does not include navigation.

### Options for measuring navigation anyway

**1. A person with the physical remote.** For a diagnostic session — as opposed
to CI — this is the cleanest signal available: zero harness load, the real input
path, real event timestamps. Start the window and press the D-pad steadily:

```
conductor profile frames report <appId> --device <serial> --track 20
```

When stderr is a terminal the command announces the window (`▶ measuring … —
drive the device now` / `■ window closed`) so you can synchronise. `--json` on
stdout is unaffected. It doesn't automate and won't gate a PR, but for "is
navigation actually janky on this device" it beats every automated option, and
it is the correct cross-check on any automated number: **if the automated and
human-driven figures diverge, the harness is the difference.**

**2. `monkey -f <script>` — one JVM for a whole sequence.** `monkey`'s script
mode reads a file of `DispatchKey` / `UserWait` events and injects them from a
single `app_process` that lives for the entire run. Start it, let it get past
its own startup, and open the measurement window after — N spawn/teardown cycles
collapse to one, amortised outside the frames you care about. Coarser timing
granularity and a fiddlier event syntax than the alternatives, but it needs no
special permissions and no per-device node discovery.

**3. `sendevent` — fastest, least portable.** Writing raw events to
`/dev/input/eventN` costs ~60ms for a full key press versus ~713ms, and being a
`write()` to a chardev rather than a process spawn, it largely removes the
contention too. It needs the shell user to be in the `input` group (true on an
NVIDIA SHIELD; **unverified on stock Fire OS**), per-device node selection by
capability rather than a hardcoded path, and Linux input codes (`KEY_RIGHT=106`)
rather than Android keycodes (`22`).

Whichever you use, `press-key --measure` reports a `driver-perturbation` note
carrying the measured injection cost whenever the harness is doing the driving,
so a contaminated window is never silently presented as a clean one.

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

## One window is not a measurement

Frame timing on TV varies enough between identical captures to invent a
regression. Five consecutive release-build captures of the same screen on a Fire
TV Stick 4K Max, same app, same alternating D-pad input:

| run | janky | frame p50 | `issueDraw` p50 |
|---|---|---|---|
| 1 | 72.9% | 26.3ms | 12.73ms |
| 2 | 67.6% | 24.9ms | 13.03ms |
| 3 | 61.3% | 24.4ms | 12.31ms |
| 4 | 59.4% | 24.3ms | 12.91ms |
| 5 | 37.8% | 13.6ms | 6.19ms |

Jank spans 37.8–72.9% and `issueDraw` p50 spans 6.2–13.0ms **with nothing
changed**. A debug-build capture of the same screen (59.7% janky, 11.64ms) sits
inside both ranges, so on this evidence debug and release are indistinguishable
— a conclusion the single captures on either side appeared to contradict.

What moves it is content: run 5 scrolled fewer and smaller tiles into view.

**So treat `--repeat 5` as the default posture on TV, not an option.** A single
`--track` window carries no variance, cannot support a `--diff`, and the report
says so with a `single-window` note. Judge a change against the baseline's own
spread, which `--repeat` records and `--diff` then tests against.

## ART's GC logging is not dependable — use the heap deltas

`profile memory --track` scrapes ART collections from logcat, and on some builds
that returns nothing at all. Measured on a Fire TV Stick 4K Max (Fire OS, API
30), a 30s window under continuous D-pad input reported **no ART collections**
while the Java heap fell 11.8MB and `systemBytes` fell 21.1MB inside the same
window. Memory that size is not reclaimed without collections running, so
collections happened and none were logged.

**Absence of logged collections is therefore not absence of collection.** The
command reports `inferredGc` alongside the logcat result, counting
sample-to-sample decreases in the heap series — a heap that shrinks between two
samples was collected between them, and there is no other mechanism. Treat
logcat as best-effort and the deltas as the primary signal.

Note also that Android runs *two* collectors here and they can tell different
stories. On that same window Hermes GC accounted for ~30% of JS samples while
ART was quiet enough never to log: the JS heap was churning hard and the Java
heap was not. `profile js`'s `gcPercent` is the number that matters for a
Hermes app — with the caveat above that it needs a debug build.

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
