---
"@houwert/conductor": minor
---

Profiling that works on release builds and real TV hardware.

**`profile frames`** (Android, incl. a physical Fire TV Stick over adb) parses
`dumpsys gfxinfo <pkg> framestats` into jank rate, p50–p99 frame times and a
per-frame phase breakdown — vsync delay, traversal, draw, sync, GPU issue,
swap — so a jank spike can be attributed rather than just observed. `--track <s>`
resets, samples and reports; because the on-device ring buffer only holds ~120
frames it polls and merges by vsync timestamp to cover the whole window, and
says so in a note when polling can't keep up rather than silently reporting the
tail. `--save-baseline` / `--diff` / `--baselines` make before-and-after
comparisons repeatable.

**`press-key <key> --measure`** times input-to-response. It reports focus→move
latency on every platform along with the cost of one hierarchy dump as an
explicit error bar, and on Android also reports on-device input→frame latency
taken from gfxinfo in nanoseconds, which excludes adb round-trip. `--repeat <n>`
gives a distribution; focus identity is keyed on accessibility id plus bounds,
not the visible label, so repeated TV row titles don't read as "no change".

**`profile js`** runs the Hermes sampling profiler over the Metro CDP
connection, ranking functions by self and total time with `file:line` and
writing the raw `.cpuprofile`. `record --duration <s>` is one shot; `start` /
`stop` bracket a flow you drive yourself, with a detached holder keeping the
CDP session open in between.

**`profile cpu --report`** runs `simpleperf report` on-device and returns a
ranked symbol table, so the command yields something an agent can read instead
of a binary `perf.data`.

**`profile memory --track`** now reports heap growth over the window and, on
Android, ART GC pause counts and durations scraped from logcat.

**`run-flow --benchmark --repeat <n>`** runs a flow repeatedly and reports
per-command p50/p90/stddev — TV run-to-run variance otherwise swamps the effect
sizes worth chasing.

**Fixed: `profile react` over-counted renders.** The injected hook walked the
whole fiber tree each commit and recorded every fiber with a non-zero
`actualDuration`. React does not clear that field on fibers it left alone, so
stale durations were re-counted on every subsequent commit: the reported
`renders` was really "commits in which this fiber had ever rendered" and
`totalMs` was inflated. The hook now tracks a watermark of the highest
`actualStartTime` seen and counts only fibers React began work on in that
commit. The same fact — React only begins work walking down from the root — lets
it prune, so the walk now costs the size of the rendered set rather than the
size of the tree. Per-component self time is computed properly as a fiber's
duration minus that of the children that rendered with it, and results sort by
`selfMs` (additive) with `totalMs` kept as the subtree-inclusive figure.

`profile react` also stops truncating silently: `--max-commits` and
`--max-components` are configurable and the output carries `truncated`,
`droppedCommits` and `droppedComponents`. `--json` now retains the per-commit
timeline with timestamps and durations (`--timeline` adds per-commit component
detail) so commits can be lined up against input events. On a release build,
where React strips the timing instrumentation, it now fails with an explanation
instead of reporting an empty result.

Metro-backed commands (`profile react`, `profile js`, `debug *`) auto-detect
Metro's port from the device instead of assuming 8081, and an unreachable Metro
now names the port it tried and how to override it.

**Absence is now structurally distinguishable from a good value.** An empty
`Distribution` reports `null` for every percentile rather than `0` — a missing
measurement that reads as `0ms` reads as a *perfect* one, and relying on every
consumer to check `count` first is relying on the wrong thing. `hasSamples()`
narrows the type where a real number is required. `profile frames` reports
`inputLatency` only when frames actually carried input timestamps, and says so
in a note when they did not.

**`press-key --measure` no longer conflates a boundary with a hang.** Focus
correctly declining to move at the end of a rail used to look identical to a
3000ms timeout, which would have manufactured evidence of the sluggishness the
command exists to find. Samples now carry
`outcome: 'moved' | 'unchanged' | 'query-failed'`, and only `moved` samples feed
the latency figures. Repeats are also no longer assumed to be repeated
measurements of one event — pressing Right twenty times walks twenty *different*
transitions, so results are grouped by the transition actually performed, with
`--sequence` to oscillate between two positions instead of drifting across the
UI. On Android it adds `pressToFrame`, computed entirely from device-side
clocks, and flags the polling-based figure as transport-bound when one focus
query costs more than the latency it is timing.

**Structured notes.** `notes` on frame and latency reports are now
`{code, message, ...}` rather than prose, so a caller can branch on `poll-gap`
and re-run at the reported `suggestedIntervalMs` instead of string-matching
wording that may change.

**Frame diffs carry polarity and significance.** Each row reports `better`
(`lower`/`higher`/`neutral`) and a `verdict`, so a consumer needn't hardcode
that more `totalFrames` in a fixed window is an improvement while more
`jankyFrames` is not. `profile frames report --track N --repeat M` captures M
windows and records their spread, and a baseline holding that spread lets
`--diff` mark a delta `significant: false` when it sits inside the noise.

**Phase attribution travels with the numbers.** Reports name the phase driving
the worst frames and, separately, the phase every frame pays for — measurement
on real hardware showed these are often different, and reporting only the first
would have pointed at an intermittent 16ms vsync delay while a steady 13ms
texture upload went unmentioned.

**Clock anchor.** Frame reports carry a `clockAnchor` reading the device's
monotonic and realtime clocks in a single adb invocation, so its accuracy is
bounded by on-device dump time (±16ms measured) rather than by network
round-trip. Frames carry `atDeviceRealtimeMs`, directly comparable to the
timestamps `profile react` records, which is what allows a specific dropped
frame to be attributed to a specific React commit.

Defaults and documentation are now measured rather than assumed, on a Fire TV
Stick 4K Max and an NVIDIA SHIELD: `--track --interval` defaults to 1000ms
(100% frame coverage on a saturated Stick, versus 66% at 3000ms), and
`docs/tv-performance.md` records adb transport costs, the ~713ms on-device cost
of `adb shell input keyevent`, and the device-dependence of `NewestInputEvent`.

`press-key --measure` on Android now injects inside the device-side bracket and
timestamps the press *after* the injection returns. `adb shell input keyevent`
costs ~713ms on the device because it spawns an `app_process` JVM per call, and
that cost lands before the event is dispatched — timestamping beforehand
attributed all of it to the app. It also reports a `driver-perturbation` note
carrying the measured injection cost, because spawning a JVM beside the frames
being measured is load on exactly the resources a memory-constrained TV is
short of, and `pressToFrame` can exclude the startup time but not the
contention.

`profile frames report --track` announces the measurement window on stderr when
stderr is a terminal, so a person driving the physical remote can synchronise
with it. That path matters more on TV than it sounds: focus moves one discrete
step per keypress with no momentum, so unlike mobile there is no way to capture
navigation frames without something driving input — and a human with the remote
is the only input path that applies no load of its own.
