# Flows

A **flow** is a YAML file describing a sequence of Conductor commands.
Conductor's flow format is a subset of
[Maestro](https://maestro.mobile.dev)'s — most existing Maestro flows
run unchanged.

This page covers the flow file format, environment-variable injection,
and parallel execution across devices.

---

## File format

A minimal flow:

```yaml
appId: com.example.myapp
---
- launchApp
- tapOn: "Sign In"
- inputText: "user@example.com"
- assertVisible: "Dashboard"
```

The header (before `---`) declares metadata; the body is a list of
steps. Each step is either a string (no-arg command like `launchApp`)
or a single-key map (like `tapOn: …`).

Recognised header fields:

| Field   | Meaning                                                              |
| ------- | -------------------------------------------------------------------- |
| `appId` | Default app for `launchApp` steps without an explicit argument.      |
| `env`   | Map of variable names → values, available as `${VAR}` in step args.  |

Recognised step shapes mirror the CLI command names — `launchApp`,
`stopApp`, `tapOn`, `inputText`, `eraseText`, `back`, `hideKeyboard`,
`pressKey`, `scroll`, `scrollUntilVisible`, `swipe`, `assertVisible`,
`assertNotVisible`, `openLink`, `setLocation`, `setOrientation`,
`takeScreenshot`, `captureUI`, `inspect`. Step arguments mirror the
CLI flags as YAML keys.

---

## Running a flow

```bash
conductor run-flow path/to/flow.yaml
```

Targets the device saved in the current session. To override:

```bash
conductor run-flow path/to/flow.yaml --device "iPhone 15 Pro"
conductor run-flow path/to/flow.yaml --session backend
```

`--benchmark` prints elapsed time per step plus a total at the end —
useful for finding flow bottlenecks.

---

## Inline flows

For one-off invocations (especially from AI agents), pass the YAML
directly on the command line:

```bash
conductor run-flow-inline '
appId: com.example.myapp
---
- launchApp
- tapOn: "Sign In"
- assertVisible: "Welcome"
'
```

This is ideal for prompted, single-purpose checks that don't warrant
a file on disk.

---

## Environment variables

Flows can reference variables that are interpolated at run time:

```yaml
appId: com.example.myapp
env:
  USERNAME: "default-user"
---
- inputText: "${USERNAME}"
```

Override on the command line with `--env`:

```bash
conductor run-flow flow.yaml --env USERNAME=alice --env PASSWORD=test
```

Command-line `--env` overrides the flow's `env:` block. `--env` is
repeatable.

---

## Parallel flows

`run-parallel` shards a directory of flow files round-robin across
every booted device:

```bash
conductor run-parallel --flows-dir tests/
conductor run-parallel --flows-dir tests/ --devices auto   # iOS + Android
```

What happens:

1. Conductor enumerates booted iOS simulators and connected Android
   devices.
2. It distributes `.yaml` files in `--flows-dir` round-robin across
   those devices.
3. For each shard, it spawns a child `conductor` process bound to the
   device, with its own session name to avoid state collisions.
4. Output is collected per-shard and an aggregated pass/fail summary
   is printed at the end.

This is the fastest way to run a regression suite locally — boot four
simulators, run forty flows in roughly the time the slowest device
takes to chew through ten.

---

## Tips for AI agents

- Prefer `run-flow-inline` for short, prompted checks. The flow itself
  becomes part of the prompt and stays close to the agent's
  reasoning.
- Use `--benchmark` early when iterating — it surfaces slow steps the
  agent can rework.
- Combine with the [daemon](/conductor/docs/concepts) to skip the
  driver cold-start between flows.
- Use distinct `--session` names for each parallel agent so they
  don't trample each other's saved `appId` / `deviceId`.
