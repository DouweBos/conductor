---
name: conductor-profiler
description: Profile a running app's CPU, memory, and React render performance with the conductor CLI, and read crash reports. Use when investigating slowness, jank, memory growth or leaks, excessive React re-renders, or when an app has crashed and you need the crash report.
---

# Conductor — profiling & crashes

Measure a running app's performance and inspect crashes.

## Profiling

| Command | Purpose |
|---|---|
| `conductor profile cpu --duration <s> [--out <path>]` | Record a CPU trace (iOS: xctrace, Android: simpleperf) |
| `conductor profile memory --track <s> [--interval ms] [<appId>]` | Sample memory for N seconds, report deltas |
| `conductor profile react start` / `profile react stop [--top N]` | Install a React commit-profiler hook, then summarize captured commits |

## Memory

| Command | Purpose |
|---|---|
| `conductor memory [<appId>]` | Device + app memory usage |
| `conductor memory --objects` | Include per-class object counts (iOS heap; slower) |
| `conductor memory --leaks` | Run leak detection (iOS only; slow, can pause the app) |
| `conductor memory --save <name>` / `--diff <name>` / `--diff <name> --vs <other>` | Snapshot and diff memory reports |
| `conductor memory --filter <regex>` / `--growth-only` / `--top <n>` | Narrow object/class tables (great for leak-hunting) |

Typical leak hunt: `memory --save before`, exercise the screen, then
`memory --diff before --growth-only`.

## Crashes

| Command | Purpose |
|---|---|
| `conductor crashes list [--app <bundleId>] [--since <duration>]` | List recent crash reports (iOS host + Android logcat) |
| `conductor crashes show <id>` | Print a specific crash report |
| `conductor crashes tail` | Stream new crash reports as they appear |

## Tips

- Add `--json` to parse reports programmatically.
- These commands can be slow or pause the app — scope them with `--duration` / `--track` and avoid leaving `crashes tail` running.
