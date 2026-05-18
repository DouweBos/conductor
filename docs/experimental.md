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
| `profile cpu --duration <s>`       | Record a CPU trace. iOS: `xcrun xctrace record --template "Time Profiler"`. Android: `adb shell simpleperf record`. Writes to `--out <path>` or a `tmp/` file. |
| `profile memory --track <s>`       | Poll memory at `--interval <ms>` (default 1000ms) for `track` seconds. Reports per-sample app + system memory; suitable for spotting leaks under repeated interactions. |
| `profile react start`              | Install a React commit-profiler hook via `__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot`. Subsequent commits are collected into a ring buffer with per-component `actualDuration`. |
| `profile react stop [--top n]`     | Stop the profiler, summarise the top N components by total render time across commits. |

**Caveats**

- `profile cpu` requires `xctrace` (Xcode) or `simpleperf` (Android NDK) on `PATH`. Argent's profiling tools also have a query layer over saved traces — Conductor only does record + summary today.
- `profile react` is Hermes-only and intercepts `onCommitFiberRoot` — interaction with other DevTools clients (the standalone React DevTools window, Flipper) is undefined; only run one profiler at a time.
- `profile memory` is a polling shim over `memory` — for finer detail use the underlying `conductor memory` directly.

---

## When experimental graduates

Each command above moves to the main [Command catalogue](/conductor/docs/commands)
once it survives a full RN minor-version cycle without script changes. Until then,
expect that an RN upgrade may briefly break one of these and a Conductor patch
release will follow.
