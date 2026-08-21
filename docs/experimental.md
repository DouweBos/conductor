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
| `profile react start`              | Install a React commit-profiler hook via `__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot`. `--max-commits` / `--max-components` size the buffers. |
| `profile react stop [--top n]`     | Stop the profiler and rank components by self time. `--json` carries the per-commit timeline; `--timeline` adds per-commit component detail. |
| `press-key <key> --measure`        | Time the response to an input. Reports focus→move latency (all platforms, with its own resolution as an error bar) and, on Android, the on-device input→frame latency from gfxinfo. `--repeat n` gives a distribution. |

**Caveats**

- `profile cpu` requires `xctrace` (Xcode) or `simpleperf` (Android NDK) on `PATH`. `--report` uses the device's own `/system/bin/simpleperf`, which resolves against the libraries actually loaded there; a stripped app library still won't symbolize.
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
