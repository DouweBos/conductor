---
"@houwert/conductor": patch
---

Two bugs found running 0.29.0 against a Fire TV Stick 4K Max.

**`profile frames` reported percentiles over a window with no frames.** With
nothing drawn, `dumpsys gfxinfo` still prints percentiles, filled from the top
histogram bucket — so a static screen reported `p50 4950ms … p99 4950ms`
alongside `frames rendered: 0`. Read quickly that is catastrophic jank; the
truth is that no frame existed. The platform percentiles and `jankyPercent` are
now omitted entirely when `totalFrames` is 0, and a `no-frames` note says the
app drew nothing and suggests why. This was the same principle the rest of the
release already applied — absence must not be representable as a value — missed
in the one path that took its numbers from the platform rather than computing
them.

**`profile js` failed outright on React Native's Fusebox backend.** It answers
`Profiler.enable` with `-32601 Unsupported method` while implementing
`Profiler.start` perfectly well, so enabling is now best-effort rather than a
precondition. Without this the command could not start on any modern RN target.

**`profile js` now reports where the sampled time actually went** before ranking
anything: `namedJsPercent`, `gcPercent` and `idlePercent`. On real hardware a
capture came back 69.7% in `[root]`, 30% in Hermes GC frames and almost nothing
in named functions, which made the top-30 function table noise assembled from
single-digit hit counts — while looking exactly like a normal ranking. Below 25%
named-JS attribution the summary carries a `low-attribution` note explaining
that a large empty-stack share is itself a result (the JS thread was idle when
sampled, so JS is not the bottleneck) and that a large GC share is a memory
finding to follow with `profile memory --track`, not a function ranking.
