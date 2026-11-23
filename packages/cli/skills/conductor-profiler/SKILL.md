---
name: conductor-profiler
description: Profile a running app's frame timing, input latency, JS CPU, native CPU, memory and React renders (with why each component re-rendered and ranked findings) with the conductor CLI, and read crash reports. Use when investigating jank or sluggishness, slow navigation, input lag on TV remotes, memory growth or leaks, GC pauses, excessive React re-renders, profiling a recorded flow before/after a change, or when an app has crashed and you need the crash report.
---

# Conductor — profiling & crashes

Measure a running app's performance and inspect crashes.

## Pick the right instrument

| Symptom the user reports | Measure with |
|---|---|
| "Scrolling/navigation is janky" | `profile frames` (Android) — objective jank rate and per-phase attribution |
| "I press a key and it takes a moment" | `press-key <key> --measure --repeat 20` |
| "It's slow, where does the time go?" (JS) | `profile js record --duration 10` |
| "It's slow, where does the time go?" (native) | `profile cpu --duration 10 --report` |
| "Which component re-renders, and why?" | `profile react start` → interact → `profile react stop` → `profile analyze` |
| "Profile flow X" / before-vs-after a change | `run-flow x.yaml --profile [--repeat n]`, then `profile analyze --diff <baseline>` |
| "Is it native?" (iOS/tvOS sim, Android) | `profile native start` → interact → `profile native stop` |
| "Memory grows / it stutters periodically" | `profile memory --track 30` |

Only `profile frames` and `profile memory` work on a **stock release build**.
`profile cpu` needs `android:debuggable` or `<profileable android:shell="true"/>`
in the manifest; `profile js` and `profile react` attach over Metro, and release
Hermes ships without the inspector so there is no target to attach to.

On TV, run `profile frames --track` with `--repeat 5`. Identical captures of one
screen have been measured spanning 37.8-72.9% janky — a single window can invent
a regression or hide one, and cannot support a `--diff`.

## Frame timing & jank (Android, incl. Fire TV / Android TV)

| Command | Purpose |
|---|---|
| `conductor profile frames reset [<appId>]` | Zero the gfxinfo counters |
| `conductor profile frames report [<appId>]` | Jank rate, p50–p99 frame times, per-phase breakdown |
| `conductor profile frames report --track <s> [--interval <ms>]` | Reset, sample for N seconds, then report |
| `conductor profile frames report --save-baseline <name>` / `--diff <name>` / `--baselines` | Save and compare runs |

Reads `dumpsys gfxinfo <pkg> framestats`, so it needs no instrumentation.

**On TV, be deliberate about who is driving.** `press-key` injects with
`adb shell input keyevent`, which spawns a JVM on the device (~713ms) beside
the frames you are measuring. Mobile's answer — fling and measure the momentum
scroll — does not exist on TV, where focus moves one step per press and stops.
So a navigation capture is always partly a measurement of the harness. Idle
screens, load settles, cold start and self-running animations are clean; for
navigation, prefer asking a human to drive the physical remote during the
window (the command announces the window on stderr for exactly this), and treat
a divergence between human-driven and automated numbers as the harness.

Not available on `roku` (ECP exposes no counters) or `vega` — but a **physical Fire TV Stick runs Fire OS
(Android)** over adb and works fine.

Attribute jank by comparing each phase's p95 against its p50: `vsyncDelay` means
the UI thread was blocked elsewhere, `traversal` means measure/layout,
`draw` means display-list recording, `issueDraw` means render-thread/GPU.

## Input latency

| Command | Purpose |
|---|---|
| `conductor press-key <key> --measure` | Time the app's response to the press |
| `conductor press-key <key> --measure --repeat <n>` | Take n samples and report a distribution |
| `--sequence <k1,k2>` | Cycle keys so repeats oscillate instead of drifting across the UI |
| `--timeout <ms>` / `--poll-interval <ms>` / `--settle <ms>` | Give-up time; poll delay; render time to allow |

Read `outcome` per sample before the aggregates. `moved` is a measurement;
`unchanged` means focus queries kept working and the app simply declined to move
(a rail edge, or a key this screen ignores) and is **not** a hang;
`query-failed` is the one that suggests something is wedged.

`--repeat` is not repeated measurement of one event — pressing Right twenty
times walks twenty different transitions. Read `byTransition` before the
aggregate, or use `--sequence` to oscillate between two positions.

On Android `pressToFrame` is derived from device-side clocks and is the figure
to trust. `focusChange` is bounded by how long one hierarchy dump takes, and a
`round-trip-bound` note fires when that floor dominates. gfxinfo's own
`inputLatency` appears only when the device populates `NewestInputEvent` — it
does on a Fire TV Stick, it never does on an NVIDIA SHIELD — so treat it as a
bonus, never as something whose absence means no input occurred.

## JS CPU (Hermes sampling profiler)

| Command | Purpose |
|---|---|
| `conductor profile js record --duration <s> [--top n] [--out <path>]` | Sample, then rank functions by self time with `file:line` |
| `conductor profile js start` / `conductor profile js stop [--top n]` | Same, bracketing a flow you drive in between |

Writes a raw `.cpuprofile` you can load in Chrome DevTools (Performance → Load
profile) or convert with `npx hermes-profile-transformer`.

## Native CPU (fixed duration)

| Command | Purpose |
|---|---|
| `conductor profile cpu --duration <s> [--out <path>] [<appId>]` | Record a trace (iOS: xctrace, Android: simpleperf; macOS: xctrace attached to the app's pid — the app from `launch-app` if no appId) |
| `conductor profile cpu --duration <s> --report [--top n]` | Android: also return a ranked symbol table |

Without `--report` on Android you get a binary `perf.data` you cannot read —
pass `--report` when you need the answer rather than the artefact.

## React renders + JS CPU (one recording)

| Command | Purpose |
|---|---|
| `conductor profile react start [--no-cpu] [--out <dir>]` | Record React commits **and** Hermes CPU samples into a profile directory |
| `conductor profile react stop [--top n]` | Stop both, save, and print a summary (components by self time, JS hotspots) |
| `conductor profile react renders [<dir>] [--filter <regex>] [--hosts]` | Per component: renders, share of commits, self/max ms, **why** (mount / props / state / parent / context), changed props |
| `conductor profile react cpu [<dir>] [--components-only]` | JS functions by self time, mapped to original `file:line` via Metro's source map |
| `conductor profile react cpu --stack <regex>` | Where a hot function is called from: top caller chains, source-mapped |
| `conductor profile analyze [<dir>] [--project-root <dir>]` | Ranked findings with a suggested fix each, and the component's source file:line |
| `conductor profile status` | What is recording now, and whether the app still holds it |
| `conductor profile analyze --save-baseline <name\|path>` / `--diff <name\|path>` | Save a run / compare against one (flags ±20% changes that are also large in absolute terms) |

`renders`, `cpu` and `analyze` read the last finished profile for the device
(or the `<dir>` you pass) — they work after the app is gone. `--json` on
`renders` includes `commits: [indices]` per component and the commit list.

Reading the reasons: `parent` means the component got a new props object whose
values were all equal — only its parent re-rendered, and `React.memo` would
have skipped it; `root cause` names the nearest ancestor that changed for its
own reason (e.g. `Feed (state useState#0)`). `props` lists the changed props
with their type; when they are all `fn`/`object`/`array`, the parent is
recreating them inline (useCallback / useMemo). `state` names the hooks that
changed, `context` the contexts. `unknown` means nothing visible changed
(external store subscription or forced update). Components compiled by the
React Compiler are marked, and uncompiled ones that keep re-rendering are
flagged as likely bail-outs.

Every conductor action you run while recording (tap-on, press-key, swipe,
run-flow steps…) is logged, and a slow commit says which one preceded it
("132ms after tapOn increment-button"). Component source locations come from
scanning the project the recording was started in (`--project-root` to
override).

`start` refuses to take over a recording another conductor session is running
on the same app; `--force` takes it over.

Findings cover: commits over the 16ms frame budget (with the JS functions that
ran during that commit), bursts of commits within 100ms (setState cascades),
wasted `parent` renders, unstable function/object props, render hotspots,
unvirtualized long lists, JS hotspots ≥5% of samples, GC ≥10%, and — when a
native recording is in the same profile — native hotspots and main-thread hangs.

Choosing the target: when several apps on the device share one Metro, the
command fails listing the targets instead of guessing. Pass `--app <bundleId>`
(or `--page <id>`). The recording is pinned to that app's logical device.

Dropped debugger sessions: commit data lives in the app's JS runtime, so a CDP
drop (some tvOS apps drop it on navigation) loses nothing — the sampler re-attaches
itself and `stop` re-attaches too; gaps are reported. A JS reload does lose the
recording, and `stop` says so.

Needs a dev or profiling build. A release build fails with a clear message.

## Native CPU (start / stop)

| Command | Purpose |
|---|---|
| `conductor profile native start [<appId>] [--leaks] [--allocations] [--malloc-stack-logging]` | Start sampling the app (iOS/tvOS simulators, physical devices, macOS: xctrace Time Profiler, optionally Leaks/Allocations; Android: simpleperf plus frame timing, GC and memory) |
| `conductor profile native stop [--top n]` | Stop, export and rank: per-thread split, hottest functions, deepest app frame per sample, hangs |
| `conductor profile native analyze [<dir>]` | Re-print a saved native report |

`--malloc-stack-logging` cold-relaunches the app with `MallocStackLogging=1` so
leaks name their allocation site — start it before `profile react start`.

Started while `profile react` is recording, it writes into the same profile
directory so `profile analyze` ranks React, JS and native findings together —
and a native hang lists the React commits that happened around it.
Android needs a debuggable or `profileable` build; emulators fall back to the
`cpu-clock` event at 1kHz. "App code" in a debug build includes third-party
native modules linked into the app binary.

## Repeatable profiles from a flow

`conductor run-flow <file> --profile [react|native|all] [--repeat n] [--profile-out <dir>] [--leaks] [--allocations]`
records a profile around the whole run and prints the findings. Record the
flow once with `flow record start` / `flow record finish`, then re-run it under
the profiler before and after a change:

```
conductor run-flow home-to-details.yaml --profile all
conductor profile analyze --save-baseline home-to-details
# …change code…
conductor run-flow home-to-details.yaml --profile all
conductor profile analyze --diff home-to-details
```

## Memory & GC

| Command | Purpose |
|---|---|
| `conductor memory [<appId>]` | Device + app memory usage |
| `conductor memory --objects` | Include per-class object counts (iOS heap; slower) |
| `conductor memory --leaks` | Run leak detection (iOS only; slow, can pause the app) |
| `conductor memory --save <name>` / `--diff <name>` / `--diff <name> --vs <other>` | Snapshot and diff memory reports |
| `conductor memory --filter <regex>` / `--growth-only` / `--top <n>` | Narrow object/class tables (great for leak-hunting) |
| `conductor profile memory --track <s> [--interval <ms>]` | Sample over a window; on Android also reports heap growth and ART GC pause counts/durations |

Typical leak hunt: `memory --save before`, exercise the screen, then
`memory --diff before --growth-only`.

## Repeatable benchmarking

`conductor run-flow <file> --benchmark --repeat <n> --json` runs the flow n
times and reports per-command p50/p90/stddev. Use it on TV, where single-run
variance is large enough to swamp the effect you're looking for.

## Crashes

| Command | Purpose |
|---|---|
| `conductor crashes list [--app <bundleId>] [--since <duration>]` | List recent crash reports (iOS host + Android logcat) |
| `conductor crashes show <id>` | Print a specific crash report |
| `conductor crashes tail` | Stream new crash reports as they appear |

## Tips

- Add `--json` to parse reports programmatically.
- `--port` is auto-detected from the device for Metro-backed commands; pass it
  explicitly only if that fails.
- These commands can be slow or pause the app — scope them with `--duration` /
  `--track` and avoid leaving `crashes tail` running.
- An Android TV emulator is far faster than a Fire TV Stick. Trust frame timing
  only from real hardware; emulators are fine for counts (React commits, GC
  collections, JS self-time ranking).
