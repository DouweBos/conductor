---
name: conductor-metro-debugger
description: Inspect a running app's JS runtime, state, logs, and network with the conductor CLI — evaluate JS in React Native (Hermes) or the web page, read the current navigation route, React Query cache and Redux/Zustand stores, call an in-app bridge, watch state change live, dump the React component tree, read console/Metro/device logs, and inspect or follow HTTP traffic. Use when debugging app behavior, checking which screen/route the app is on, inspecting cached server data or store state, reading logs, evaluating expressions in the live runtime, inspecting React components, or examining network traffic.
---

# Conductor — runtime debugging, logs & network

Inspect what a running app is doing under the UI — its JS runtime, console
output, and HTTP traffic. Works against React Native (Hermes/Fusebox) and
Playwright web.

## Runtime (React Native / web)

| Command | Purpose |
|---|---|
| `conductor debug status [--port N]` | RN debugger connection info |
| `conductor debug evaluate <expr> [--port N]` | Run JS in the app runtime (Hermes or web page) |
| `conductor debug component-tree [--port N]` | On-screen React component tree |
| `conductor debug inspect-element <x,y>` | React component at a screen point |
| `conductor debug log-registry [--source metro]` | Summarize recent Metro/Hermes console logs |
| `conductor native-rn-set --react-tag <n> --path <dot.path> --value <json>` | Live-edit an RN component's props via React DevTools `overrideProps` (text via `--path children`, color via `--path style.color`). Dev builds only |
| `conductor native-rn-props --react-tag <n>` | Raw JSX props (`memoizedProps`) of an RN fiber by reactTag — the JS-side truth for Fabric where native `/props` `rawProps` is null |

When several apps on the device share one Metro, `debug` commands fail listing
the targets rather than attaching to the wrong app — pass `--app <bundleId>`
(or `--page <id>` from that list).

`--react-tag` comes from `native-inspect`'s `rn.reactTag` (see `conductor-native`
for the native-plane instrument). `--value` is JSON (a bare
string works for text). `--path` is a dot path into props: `children`, `style.color`,
`style.fontSize`, `accessibilityLabel`. `style.color` works whether the component's
`style` is an object or a composed array. These drive React itself over Metro CDP, so
they need a **dev/debug build** (the DevTools backend must be active) and a running
Metro; on a release build they return a clear "not a dev build" error. Output is
`{"status":"ok","applied":true}` or `{"status":"error","message":"…"}`.

## App state (no in-app dependency)

These find React Navigation, TanStack Query and react-redux by walking the
React fiber tree over Metro, so any dev build works without app changes.

| Command | Purpose |
|---|---|
| `conductor debug navigation [--full]` | Focused route: name, params, nested path (`Root › Tabs › Home`). `--full` adds the whole navigation state. Works for expo-router |
| `conductor debug navigate <route> [--params '<json>']` | Navigate through the app's navigation container |
| `conductor debug query-cache` | Every cached query: key, status/fetchStatus, observers, age, stale |
| `conductor debug query-cache --key <substr> [--path a.b[0]] [--summary]` | Narrow to matching keys and include their data (projected / keys→types) |
| `conductor debug query-cache --grep <value>` | Which queries contain a value, and at which paths |
| `conductor debug store` | List stores: Redux (auto), Zustand registered in `globalThis.__CONDUCTOR_STORES__ = { name: useStore }`, and stores a bridge exposes via `listStores` |
| `conductor debug store <name> [--path p] [--summary]` | Read one store |
| `conductor debug store <name> --set '<json>'` / `--dispatch '<json>'` | Merge into a Zustand/bridge store / dispatch a Redux action |
| `conductor debug bridge list [--bridge <global>]` | Methods on an app-provided bridge global (default `__conductorBridge`; or set `CONDUCTOR_BRIDGE_GLOBAL`) |
| `conductor debug bridge call <method> [jsonArgs…] [--bridge <global>]` | Call a bridge method and print its awaited result |
| `conductor debug watch <navigation\|query-cache\|store <name>\|expr '<js>'>` | Poll and print each change as a diff (`--interval ms`, `--duration s`; NDJSON with `--json`) |

Big values are capped at `--max-bytes` (default 100000): the reply is
summarized with a hint to narrow with `--path` / `--summary`. `--depth` sets
the serializer's depth (default 8). Always bound `debug watch` with
`--duration` when running it as an agent.

## Logs

| Command | Purpose |
|---|---|
| `conductor logs --recent <n>` | Last N buffered log lines — **agent-friendly, exits immediately** |
| `conductor logs [--source metro\|device] [--level …] [--json] [--duration s]` | Stream logs (bound it with `--duration`) |
| `conductor logs --list` | List Metro debugger targets for this device |

Physical iPhones/Apple TVs stream device logs through `idevicesyslog`
(`brew install libimobiledevice`); without it only Metro logs are collected.

Prefer `logs --recent N` over a bare `logs` stream — don't leave a stream
running indefinitely.

## Network

| Command | Purpose |
|---|---|
| `conductor network logs [--limit N]` | Recent HTTP traffic (RN fetch/XHR shim; web via Playwright) |
| `conductor network logs --follow [--duration s]` | Print requests as they complete (NDJSON with `--json`) |
| `conductor network request <url> [--method M] [--body STR] [--header K=V]` | Issue an HTTP request from the app's context |

## Metro bundler

| Command | Purpose |
|---|---|
| `conductor metro reload [--port N] [--target N]` | Reload the JS bundle without restarting native |
| `conductor metro stop [--port N]` | Stop the Metro bundler on a port (default 8081) |
| `conductor metro use <port\|host:port> [<appId>]` | Point the app at a specific Metro (iOS/tvOS simulators, react-native-macos apps) |
| `conductor metro use --reset [<appId>]` | Drop that override, back to the compiled-in port |

An app asks for the Metro port compiled into React-Core from `RCT_METRO_PORT` at
pod-install time, so a build can end up asking for a port nothing is serving —
typically a git worktree whose Metro runs elsewhere, or a pod install from a
shell that lacked the env var. Symptom: the app never loads a bundle (or keeps
running a stale one) while `conductor metro reload` works fine against the port
you expect. `metro use` overrides it via the `RCT_jsLocation` preference, so no
recompile is needed and the setting survives reinstalls. **Relaunch the app**
afterwards — it is read when the bridge starts. The app id defaults to the
current session's. On macOS (`--device macos`) it writes the host's `defaults`
for the app — into the app's container when it is sandboxed.

Android has no such preference; map the port with
`adb -s <serial> reverse tcp:8081 tcp:<metro-port>` instead.

## Tips

- `--port N` targets a specific Metro/debugger port when auto-detection isn't enough.
- Add `--json` for machine-readable output.
- For crashes and performance, see `conductor-profiler`.
