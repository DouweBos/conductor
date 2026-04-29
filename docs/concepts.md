# Concepts

A short tour of the moving parts. Each concept maps to something
concrete on disk or in your shell — Conductor is deliberately a thin
CLI on top of well-understood platform tooling.

---

## Driver

A **driver** is the piece of code that runs _inside_ the simulator,
emulator, or browser and translates Conductor commands into native
actions.

Conductor bundles three of them:

- **iOS driver** — installed onto the simulator the first time you
  run a command.
- **Android driver** — installed via `adb` the first time you target
  an Android device.
- **Web driver** — uses [Playwright](https://playwright.dev). Run
  `conductor install-web` once to fetch the browser binary.

You don't manage drivers explicitly — Conductor does that. They live
under `~/.conductor/` after first run.

---

## Session

A **session** is a tiny piece of state on disk that remembers two
things: the device you last targeted (`--device`) and the last app you
launched (`launch-app`). It lets every subsequent command run without
re-specifying them.

```
~/.conductor/
  sessions/
    default.json     ← { "deviceId": "…", "appId": "…" }
    backend.json
    flow-runner.json
```

Pass `--session <name>` to any command to use a session other than
`default`. This is how concurrent agents work in parallel without
trampling each other's state — give each agent its own session name.

---

## Device

A **device** is anything Conductor can drive. Today that's:

- An iOS Simulator (any installed runtime).
- An Android emulator (AVD) or a wired-up Android device.
- A Playwright-managed browser instance (`web`, `web:firefox`,
  `web:webkit`).

`conductor list-devices` enumerates booted ones. `conductor
start-device <name>` boots a specific simulator or emulator;
`conductor stop-device` shuts it down.

---

## Daemon

The driver takes a moment to start. For interactive use that's fine;
for an AI agent issuing dozens of commands the cold-start adds up.

The **daemon** is an optional long-running process per session that
keeps the driver warm:

```bash
conductor daemon-start --session default
conductor daemon-status
conductor daemon-stop --session default
```

Subsequent commands skip the cold-start hit. Stop the daemon when
you're done. `conductor daemon-stop --all` shuts down every session's
daemon at once.

---

## Flow

A **flow** is a YAML file describing a sequence of Conductor commands.
Conductor's flow format is a subset of
[Maestro](https://maestro.mobile.dev)'s — most existing Maestro flows
run unchanged.

```yaml
appId: com.example.myapp
---
- launchApp
- tapOn: "Sign In"
- inputText: "user@example.com"
- assertVisible: "Dashboard"
```

`conductor run-flow path/to/flow.yaml` runs it.
`conductor run-flow-inline '<yaml>'` accepts the YAML on the command
line. `conductor run-parallel --flows-dir tests/` shards a directory
of flows across every booted device round-robin. See
[Flows](/conductor/docs/flows) for the full reference.

---

## Element resolution

Most commands take an **element** — what to tap, what to assert, what
to scroll to. Conductor resolves it like Maestro does, in priority
order:

1. The positional argument is matched against accessibility identifier
   first, then visible text.
2. Disambiguators narrow further: `--id`, `--text`, `--index`,
   `--below`, `--above`, `--left-of`, `--right-of`, `--enabled`,
   `--checked`, `--focused`, `--selected`.
3. `--timeout <ms>` lets the resolver wait for the element to appear.
4. `--optional` (on `tap-on` and friends) makes a missing element a
   no-op instead of an error.

`conductor inspect` prints the live UI hierarchy so you can see
exactly what identifiers and texts are available right now.

---

## Output modes

Every command prints a one-line success or error message to stdout.
Some commands also produce structured data:

- `conductor inspect` and `conductor capture-ui` print JSON.
- `--dump` on `inspect` prints the raw driver output.
- `--output <path>` on screenshot-y commands writes the artefact to
  disk.
- `--quiet` and `--json` flags are honoured where they make sense.

This means agents can pipe Conductor through `jq`, parse exit codes,
or feed structured snapshots into a model — whichever suits the
workflow.
