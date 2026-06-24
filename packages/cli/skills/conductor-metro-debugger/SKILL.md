---
name: conductor-metro-debugger
description: Inspect a running app's JS runtime, logs, and network with the conductor CLI — evaluate JS in React Native (Hermes) or the web page, dump the React component tree, read console/Metro/device logs, and inspect or issue HTTP requests. Use when debugging app behavior, reading logs, evaluating expressions in the live runtime, inspecting React components, or examining network traffic.
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

## Logs

| Command | Purpose |
|---|---|
| `conductor logs --recent <n>` | Last N buffered log lines — **agent-friendly, exits immediately** |
| `conductor logs [--source metro\|device] [--level …] [--json] [--duration s]` | Stream logs (bound it with `--duration`) |
| `conductor logs --list` | List Metro debugger targets for this device |

Prefer `logs --recent N` over a bare `logs` stream — don't leave a stream
running indefinitely.

## Network

| Command | Purpose |
|---|---|
| `conductor network logs [--limit N]` | Recent HTTP traffic (RN fetch/XHR shim; web via Playwright) |
| `conductor network request <url> [--method M] [--body STR] [--header K=V]` | Issue an HTTP request from the app's context |

## Metro bundler

| Command | Purpose |
|---|---|
| `conductor metro reload [--port N] [--target N]` | Reload the JS bundle without restarting native |
| `conductor metro stop [--port N]` | Stop the Metro bundler on a port (default 8081) |

## Tips

- `--port N` targets a specific Metro/debugger port when auto-detection isn't enough.
- Add `--json` for machine-readable output.
- For crashes and performance, see `conductor-profiler`.
