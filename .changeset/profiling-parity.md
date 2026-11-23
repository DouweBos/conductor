---
'@houwert/conductor': minor
---

Profiling parity with Argent's profiler tools. `profile react start`/`stop` now record React commits and Hermes CPU samples together into a saved profile directory, and three new readers work on it offline: `profile react renders` (render counts, the commits each component rendered in, and why it rendered: mount, props, state, parent or context), `profile react cpu` (JS hotspots mapped to source through Metro's source map) and `profile analyze` (ranked findings, with `--save-baseline`/`--diff`). `profile native start`/`stop`/`analyze` add bracketed native CPU profiling (xctrace on iOS/tvOS simulators and macOS, simpleperf on Android), and `run-flow --profile` runs a flow inside a profile. Metro-attached commands take `--app`/`--page` and refuse to guess when several apps share Metro, and the Hermes sampler re-attaches when the debugger session drops (tvOS navigation).

Metro debugger connections now send an Origin header, so `debug`, `network`, `profile js` and `profile react` attach again on React Native 0.83+ / Expo SDK 55+ Metro, which rejected them (401, or a silent disconnect under Expo).
