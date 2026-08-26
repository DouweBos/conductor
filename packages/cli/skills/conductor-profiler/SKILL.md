---
name: conductor-profiler
description: Profile a running app's frame timing, input latency, JS CPU, native CPU, memory and React renders with the conductor CLI, and read crash reports. Use when investigating jank or sluggishness, slow navigation, input lag on TV remotes, memory growth or leaks, GC pauses, excessive React re-renders, or when an app has crashed and you need the crash report.
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
| "Which component re-renders on every input?" | `profile react start` → interact → `profile react stop` |
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

## Native CPU

| Command | Purpose |
|---|---|
| `conductor profile cpu --duration <s> [--out <path>]` | Record a trace (iOS: xctrace, Android: simpleperf) |
| `conductor profile cpu --duration <s> --report [--top n]` | Android: also return a ranked symbol table |

Without `--report` on Android you get a binary `perf.data` you cannot read —
pass `--report` when you need the answer rather than the artefact.

## React renders

| Command | Purpose |
|---|---|
| `conductor profile react start [--max-commits n] [--max-components n]` | Install the commit-profiler hook |
| `conductor profile react stop [--top n] [--timeline] [--json]` | Stop and rank components by self time |

Sort key is `selfMs`, which is additive across components; `totalMs` is
subtree-inclusive and double-counts parents. `--json` includes the per-commit
timeline (timestamps + durations) so you can line a jank spike up with an input;
`--timeline` adds per-commit component detail. If either buffer overflows the
output says `truncated: true` with the dropped counts — raise the limits rather
than trusting the tail. On a release build it fails with a clear message instead
of reporting zeroes.

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
