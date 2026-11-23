---
'@houwert/conductor': minor
---

Profiling parity with Argent's profiler tools. `profile react start`/`stop` now record React commits and Hermes CPU samples together into a saved profile directory, and three new readers work on it offline: `profile react renders` (render counts, the commits each component rendered in, and why it rendered: mount, props, state, parent or context), `profile react cpu` (JS hotspots mapped to source through Metro's source map) and `profile analyze` (ranked findings, with `--save-baseline`/`--diff`). `profile native start`/`stop`/`analyze` add bracketed native CPU profiling (xctrace on iOS/tvOS simulators and macOS, simpleperf on Android), and `run-flow --profile` runs a flow inside a profile. Metro-attached commands take `--app`/`--page` and refuse to guess when several apps share Metro, and the Hermes sampler re-attaches when the debugger session drops (tvOS navigation).

Metro debugger connections now send an Origin header, so `debug`, `network`, `profile js` and `profile react` attach again on React Native 0.83+ / Expo SDK 55+ Metro, which rejected them (401, or a silent disconnect under Expo).

Render reasons also name the changed hooks and contexts, the root-cause ancestor of parent re-renders, and React Compiler output; findings carry component source locations and the conductor action that preceded each slow commit; native hangs list the React commits around them. `profile native` adds `--leaks`/`--allocations` on iOS, physical iOS devices, and frame timing, GC and memory on Android. `profile status` shows what is recording, and `profile react start` will not silently take over another session's recording (`--force`). `profile cpu` on iOS now attaches by pid, and `profile memory`'s ART GC window works again on Android.
