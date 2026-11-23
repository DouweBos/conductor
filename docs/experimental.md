# Experimental commands

Conductor ships a set of commands that depend on **React Native runtime internals**
(`__REACT_DEVTOOLS_GLOBAL_HOOK__`, fiber shape, `UIManager` / `nativeFabricUIManager`,
`renderer.rendererConfig`). They work — they're modelled directly on the patterns
used by tools like `react-devtools` — but RN reorganises these internals occasionally,
so the scripts may need maintenance per RN major version.

If you hit a breakage, the failure mode is usually a clear error (`"No React DevTools hook"`,
`"No fiber roots"`, `"rendererConfig.getInspectorDataForViewAtPoint unavailable"`) and the
underlying Metro / app is unaffected — you can fall back to native inspection.

All three groups below talk to **Metro's Chrome DevTools Protocol endpoint** (`/json` on
port 8081 by default). Pass `--port <n>` to point at a different bundler, `--target <n>`
to pick a specific debugger target when several are connected.

---

## RN debugger

| Command                          | What it does                                                                       |
| -------------------------------- | ---------------------------------------------------------------------------------- |
| `debug status`                   | Show Metro target list, connection state, loaded scripts, enabled CDP domains.     |
| `debug evaluate <expr>`          | `Runtime.evaluate` in the app's JS context. Awaits promises. Reads Redux, calls app functions, inspects state. |
| `debug component-tree`           | Walk the React fiber tree, batch-measure on-screen rects via `UIManager.measureInWindow` (Paper) or `nativeFabricUIManager.measure` (Fabric). Filters out wrapper noise. |
| `debug inspect-element <x,y>`    | Use `renderer.rendererConfig.getInspectorDataForViewAtPoint` (React's own inspector) to find the component at a screen point. Walks UP via `.return` and resolves source via `_debugStack` / `_debugSource`. |
| `debug log-registry`             | Summary of recent Metro console output — counts by level and clustering.            |
| `debug reload`                   | `Page.reload` over CDP. Same as `metro reload`.                                     |

**Caveats**

- Requires Hermes (`__REACT_DEVTOOLS_GLOBAL_HOOK__` is registered on Hermes startup).
- `debug component-tree` works on both Fabric and Paper, but the SKIP list of wrapper component names is hard-coded — new RN versions may surface new wrappers we don't filter.
- `debug inspect-element` requires `getInspectorDataForViewAtPoint` on the renderer; this exists on RN 0.70+. Older versions error out.
- Source frames come from `_debugStack` (RN ≥ 0.76) or `_debugSource` (`@babel/plugin-transform-react-jsx-source`). With neither, the frame is `null`.

---

## Network inspection

| Command                                         | What it does                                                                       |
| ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| `network logs [--limit n]`                      | Install a `fetch`/`XHR` shim into the running app (idempotent — only once per JS context) and read the captured entries. Each entry: `{ id, kind, method, url, status, durationMs, error, start }`. |
| `network request <url> [--method --body --header k=v]` | Issue an HTTP request from the app's network context. Honours the app's cookies, headers, and TLS pinning. |

**Caveats**

- Shim only sees `fetch` and `XMLHttpRequest` — apps that use native networking modules directly (e.g. `okhttp` on Android via a TurboModule) bypass it.
- A `metro reload` or app reload clears the shim — call `network logs` once to reinstall.
- The shim's ring buffer caps at ~200 entries; tune by re-installing if needed.

---

## Profiling

| Command                            | What it does                                                                       |
| ---------------------------------- | ---------------------------------------------------------------------------------- |
| `profile frames report [--track <s>]` | Android only. Parse `dumpsys gfxinfo <pkg> framestats` into jank counts, p50–p99 frame times, and a per-phase breakdown of where each frame's time went. Works on release builds and on real Fire TV hardware over adb. `--save-baseline` / `--diff` compare runs. |
| `profile frames reset`             | Zero the counters, so the next `report` covers only what follows.                  |
| `profile cpu --duration <s>`       | Record a CPU trace. iOS: `xcrun xctrace record --template "Time Profiler"`. Android: `adb shell simpleperf record`. Writes to `--out <path>` or a `tmp/` file. |
| `profile cpu --report [--top n]`   | Android only. Also runs `simpleperf report` on-device and returns a ranked symbol table, so an agent gets something readable instead of a binary `perf.data`. |
| `profile memory --track <s>`       | Poll memory at `--interval <ms>` (default 1000ms) for `track` seconds. On Android also reports heap growth over the window and ART GC pause counts / durations scraped from logcat. |
| `profile js record --duration <s>` | Run the Hermes sampling profiler over the Metro CDP connection. Returns a self/total time ranking by function with `file:line`, and writes the raw `.cpuprofile`. |
| `profile js start` / `js stop`     | The same, bracketing a flow you drive yourself. A detached holder keeps the CDP session open in between. |
| `profile react start`              | Record React commits (a hook on `__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot`) **and** Hermes CPU samples into one profile directory (`~/.conductor/profiles/<device>/<ts>`, or `--out <dir>`). `--no-cpu` records commits only; `--max-commits` / `--max-components` size the buffers. |
| `profile react stop [--top n]`     | Stop both, save the profile, rank components by self time and summarise the CPU profile. `--json` carries the per-commit timeline; `--timeline` adds per-commit component detail. JS functions are mapped to their original `file:line` through Metro's source map (`--no-symbolicate` to skip). |
| `profile react renders [<dir>]`    | Per-component render count, the commits each one rendered in, and **why** it rendered: `mount`, `props` (changed props named, with their type), `state` (changed hooks named), `parent` (a new props object whose values are all equal — `React.memo` would have skipped it — with the ancestor that actually changed as its root cause), `context` (contexts named) or `unknown`. Also marks React Compiler output and the component's source file:line. `--filter <regex>`, `--hosts`, `--project-root`. |
| `profile react cpu [<dir>]`        | Hermes CPU hotspots by JS function — self/total ms, share, source location. `--components-only` keeps PascalCase (component) functions; `--stack <regex>` shows the caller chains through matching functions. |
| `profile status`                   | What is recording now, whether the sampler and xctrace/simpleperf are alive, and whether the app still holds the commit hook. |
| `profile analyze [<dir>]`          | Ranked findings across everything recorded in the profile: slow commits (≥16ms, with the JS that ran during them), commit bursts, wasted (`parent`) renders, unstable function/object props, render hotspots, long unvirtualized lists, JS hotspots, GC pressure, native hotspots and hangs. `--save-baseline <name\|path>` / `--diff <name\|path>` compare runs (±20%). |
| `profile native start [<appId>]` / `native stop` | Native CPU sampling bracketing a flow. iOS/tvOS (simulators and physical devices) and macOS: `xctrace` Time Profiler attached to the app's pid, plus Leaks / Allocations with `--leaks` / `--allocations` (`--malloc-stack-logging` relaunches the app so leaks are attributed). Android: on-device `simpleperf record --app`, plus gfxinfo frame timing, ART GC and PSS over the same window. `stop` exports and ranks: per-thread split, hottest functions, deepest app frame per sample, main-thread hangs (iOS `potential-hangs`, lined up with React commits), leaks, live allocations, jank and memory growth. Writes into the active profile directory when a React profile is running. |
| `profile native analyze [<dir>]`   | Re-print a saved native report. |
| `run-flow <file> --profile [react\|native\|all]` | Run a flow (optionally `--repeat n`) inside a profile and print the findings — a repeatable profile from a recorded flow. `--profile-out <dir>` picks the directory. |
| `press-key <key> --measure`        | Time the response to an input. Reports focus→move latency (all platforms, with its own resolution as an error bar) and, on Android, the on-device input→frame latency from gfxinfo. `--repeat n` gives a distribution. |

**Caveats**

- `profile cpu` requires `xctrace` (Xcode) or `simpleperf` (Android NDK) on `PATH`. `--report` uses the device's own `/system/bin/simpleperf`, which resolves against the libraries actually loaded there; a stripped app library still won't symbolize.
- `profile js` / `profile react` pick the Metro target for the session's device. When several apps on that device share Metro the choice is ambiguous and they fail with the list of targets rather than guessing; pass `--app <bundleId>` or `--page <id>` (the app from `launch-app` is used when it disambiguates). The recording is then pinned to that target's logical device and app.
- The commit data lives in the app's JS runtime, not in the debugger session, so a dropped CDP connection (some tvOS apps drop it on navigation) loses nothing: the Hermes sampler re-attaches on its own and `stop` re-attaches too. Only a JS reload (full Fast Refresh reload, `metro reload`, app restart) loses the recording, and `stop` says so. Re-attaches are listed as gaps.
- `profile native` on physical iOS/tvOS devices resolves the app's pid through `devicectl` and needs a development-signed build (xctrace cannot attach to App Store builds).
- Every conductor action run during a recording is logged to `steps.jsonl` in the profile, so slow commits name the action that preceded them.
- `profile react` is Hermes-only and intercepts `onCommitFiberRoot` — interaction with other DevTools clients (the standalone React DevTools window, Flipper) is undefined; only run one profiler at a time.
- `profile react` needs a dev or profiling build. A release build strips React's timing instrumentation, and the command says so rather than reporting zeroes.
- `profile react` counts a component as having rendered in a commit only when React began work on it in that commit, tracked via an `actualStartTime` watermark. `selfMs` is additive across components; `totalMs` is subtree-inclusive and double-counts parents by design.
- `profile memory` is a polling shim over `memory` — for finer detail use the underlying `conductor memory` directly. ART only logs collections it considers noteworthy, so a window with no GC lines is a real signal rather than a parse failure.
- For which of these work against a Fire TV Stick, a Vega VVD, or an emulator — and how far to trust emulator numbers — see [TV performance](/conductor/docs/tv-performance).


---

## When experimental graduates

Each command above moves to the main [Command catalogue](/conductor/docs/commands)
once it survives a full RN minor-version cycle without script changes. Until then,
expect that an RN upgrade may briefly break one of these and a Conductor patch
release will follow.
