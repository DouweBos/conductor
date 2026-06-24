---
name: conductor-create-flow
description: Author and run Maestro-compatible YAML flows and command sequences with the conductor CLI, including recording flows from live interactions and sharding them across devices. Use when scripting a repeatable multi-step app journey, running an existing Maestro flow, recording a flow by interacting with the app, or running flows in parallel across booted devices.
---

# Conductor — flows

A **flow** is a YAML file describing a sequence of conductor commands.
Conductor's format is a subset of [Maestro](https://maestro.mobile.dev)'s — most
existing Maestro flows run unchanged. Use flows for repeatable journeys; use
`conductor-device-interact` for one-off ad-hoc steps.

## Run flows

| Command | Purpose |
|---|---|
| `conductor run-flow <file> [--env K=V] [--benchmark]` | Run a Maestro YAML flow file |
| `conductor run-flow-inline '<yaml>' [--benchmark]` | Run inline YAML from the command line |
| `conductor run-sequence [--file path.json]` | Run a JSON sequence of conductor commands serially; reads stdin if no `--file` |
| `conductor run-parallel --flows-dir <path>` | Shard a directory of flows across all booted devices |

`--benchmark` prints elapsed time per command and total flow time.

## Flow YAML

```yaml
appId: com.example.myapp
---
- launchApp
- tapOn: "Sign In"
- inputText: "user@example.com"
- assertVisible: "Dashboard"
```

`run-sequence` JSON shape (stops on first non-zero exit):

```json
{ "steps": [ { "cmd": "tap-on", "args": ["Login"] }, { "cmd": "input-text", "args": ["user@example.com"] } ] }
```

## Record a flow from your interactions

| Command | Purpose |
|---|---|
| `conductor flow record start [--out path]` | Start recording this session's interactions to a YAML file |
| `conductor flow record echo <text>` | Insert a `console.log` step |
| `conductor flow record status` | Show the active recording path |
| `conductor flow record finish` | Close the recording, print the file path |

Record, then interact via `conductor-device-interact`; each action is appended
to the flow. `finish` gives you a runnable `.yaml`.

## Tips

- Add `--json` for machine-readable output; a failed step exits non-zero.
- `conductor run-flow --help` (and friends) for exact flags.
