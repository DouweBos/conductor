# Conductor Studio

A desktop app (Electron + React) that sits on top of the conductor CLI. It does
three jobs: writing and managing Maestro tests, writing them with an agent, and
tracking them as test cases. Light and dark, notarized, auto-updating.

It lives in this monorepo at `apps/studio`, on a shared design system at
`packages/studio-ui` (`@conductor/studio-ui`).

---

## Opening a project

Studio opens the enclosing git repository (override with `STUDIO_PROJECT_ROOT`,
or pick one from the title bar). It then finds the flows directory by searching
**four levels deep** for a `.maestro`/`maestro` folder that actually holds flows
— judged by a flow's shape, an `appId:` header or a `---` separator, so a
`.github/actions/maestro` full of workflow YAML doesn't count. Monorepos that
keep flows per-app (`apps/plex/.maestro`) are found. The sidebar names the
directory it settled on, and offers a picker when a repo has more than one.

Set `CONDUCTOR_BIN` to point at a specific conductor CLI; otherwise Studio uses
`conductor` on `PATH`, then the workspace build at `packages/cli/dist/index.js`.

## 1. The Maestro workbench

A three-column workbench: flow tree, editor, device.

### Flow tree

The project's flows, with a right-click menu to **rename / duplicate / delete /
add folders / find usages**, **New flow** from a template, and a search box that
greps the whole flows directory.

**Renaming repoints every caller.** A POM suite refers to a subflow from a dozen
places (`commands/launch/launch.yaml` has 36 callers in the Plex suite), so a
rename rewrites each reference in the style that call site used — a config.yaml
alias stays an alias, a relative path stays relative. **Find usages** answers
"what breaks if I change this", and Cmd/Ctrl-clicking a `runFlow`/`runScript`/
`file` line in the editor opens what it names.

### Editor

CodeMirror, YAML and JS, with tabs and ⌘S to save.

**Autocomplete** covers the whole vocabulary, driven off indentation:

| Where | What it offers |
| --- | --- |
| `- ta⎸` | 45 commands, each with a one-line doc |
| `- tapOn:` → `  i⎸` | the 27 element-selector keys — `id`, `index`, `point`, `below`, `childOf`, … |
| `- launchApp:` → `  clear⎸` | that command's own parameters |
| above the `---` | `appId`, `name`, `tags`, `env`, `onFlowStart`, `onFlowComplete` |
| `"${US⎸"` | env variables, including inside quoted strings |
| `details/open⎸` | **subflows** — see below |
| `file:`, `files:`, `path:`, `script:` | paths from the flows directory, alias and relative form |

The command and parameter names are transcribed from Maestro's own YAML models
(`YamlFluentCommand` and the `Yaml*` classes), so they match what the parser
accepts rather than what the docs describe. Env names are collected from the
whole flows directory: every `env:` block, every `${VAR}` already referenced,
and `config.yaml`.

**Subflow completion** is the one that matters for a POM suite, where flows are
written by chaining subflows. Typing a path fragment where a step goes offers
the matching flow, and accepting it writes the whole call:

```yaml
- runFlow:
    file: "@pages/details/open.yaml"
    env:
      path: ⎸
      expectScreen: ⎸
```

The file uses its `@alias/…` form when `config.yaml` declares one (resolved the
way conductor's `resolvePath` does — longest alias wins), else a path relative to
the flow you're editing. The `env:` block lists every parameter the subflow
expects, with tab stops in the values. Parameters are **inferred from the
subflow's own `${…}` usage** — lower-camelCase names, since SCREAMING_SNAKE ones
are suite-wide globals passed on the command line and dotted ones are script
output — so they're found whether or not the flow declares them. Scripts get
`runScript:` instead.

### Problems

A linter checks the suite without running it, against the same command schema
and flow catalog that drive autocomplete: unknown commands and parameters,
unknown header keys, `runFlow`/`runScript` paths and aliases that don't resolve,
calls that omit parameters the subflow reads, `${…}` names nothing supplies, and
test cases pointing at flows that no longer exist. Problems underline in the
editor as you type and collect in the **Problems** tab.

It knows two things about how Maestro actually behaves, which keep it quiet on a
healthy suite: an `env:` block is a sibling of `file:`, not a child, and env is
inherited into subflows — so a subflow forwarding to another doesn't have to
restate anything.

### Running flows

Studio prefers the system-installed **`maestro`** binary (`maestro test`) and
falls back to **`conductor run-flow`** when maestro isn't on `PATH`. The console
labels which engine ran. (Conductor's flow YAML is a subset of Maestro's.)

- **Run** the open flow, **Run selection** (the highlighted steps, inline), and
  **Run all** (the flows folder — expanded to one run per flow on the conductor
  engine, which takes a single file at a time).
- **Run options**: environment variables (`--env`) and include/exclude tags.
  These apply to inline runs too.
- **Per-step runs**: hover the editor and a play button appears in the gutter
  beside every step. Click it to run just that step; the chevron next to it
  offers **Run all until here**, running every step up to and including that
  one. A step owns the lines indented under it, so multi-line commands run
  whole, and the slice keeps the flow's header so `appId` and its `env` defaults
  still apply.
- A **step checklist** ticks off each step live, parsed from what the engines
  actually print (`… COMPLETED`/`FAILED` for maestro, `→ … ok`/`FAILED` for
  conductor), plus a **screenshot captured automatically on failure**.
- A **REPL** with two modes: `conductor` runs a raw CLI command and prints the
  output in the console; `maestro` runs a YAML step inline against the device and
  shows it in the step list.
- A **Logs** tab streaming `conductor logs` for the connected device.
- **Run changed** runs only the flows you touched against `main` (committed and
  working-tree alike).
- **Run options** carry saved **profiles**, so the env a suite always needs
  (`APP_ID`, platform) is picked rather than retyped; a **tag picker** built from
  the tags the flows declare; a **shard count** (`--shard-split` on maestro,
  `run-parallel` on conductor); and a **flakiness check** that runs one flow N
  times and reports the pass rate.

### Runs

Every run is recorded per project — status, timing, output tail — so "it passed
ten minutes ago" is answerable. Opening a maestro run reads the debug output it
writes to `~/.maestro/tests/<run>/`: every executed command with its status and
duration, the **screenshot** taken at that step, and the **screen hierarchy**
captured with it. That's what explains a failure; a console scroll doesn't.

A failed run has **Ask the agent to fix it**, which opens the agent with the
failing step, the paths to that step's screenshot and hierarchy, and the output
tail already composed — loaded into the composer rather than sent, so you read
and edit it before the agent starts touching the app.

### Device panel

The mirror and inspector always go through conductor: the daemon's H.264 video
WebSocket (`conductor stream-server`) is decoded in the renderer with WebCodecs,
input goes through conductor's commands, and the inspector reads
`conductor capture-ui`.

Two modes:

- **Interact** — your taps and swipes drive the device. **Record** mode appends
  them to the open flow as Maestro steps, resolving taps to text/id selectors
  via `capture-ui`, and can capture an `assertVisible` for the current screen —
  a recording of nothing but taps passes against a completely broken app.
  **Boot** and **Install a build** run conductor's `start-device` and
  `install-app`, so getting a device ready doesn't mean leaving Studio.
- **Inspect** — Maestro-Studio-style element picking. Every captured element is
  outlined over the stream; hovering highlights the smallest one under the
  cursor, clicking it lists the commands that fit it — **tapOn / longPressOn /
  inputText / assertVisible / copyTextFrom / runFlow-when-visible** — as
  ready-to-paste YAML with an Insert button. Selectors are offered best-first:
  accessibility id, then text (indexed when the text isn't unique on screen),
  then a percentage coordinate. Coordinates only appear for tap-like commands,
  since an assertion can't match a point. On tvOS you get the remote keys
  instead, because `tap-on` isn't supported there at all. Picking in the
  inspector tree and picking on the stream are the same selection.

## 2. Agentic test writing

A Claude Code wrapper that drives the app through conductor, reuses the repo's
Maestro **subflow POMs**, and is seeded with a **scene graph** of discovered
screens so later runs skip re-orientation. The device panel sits beside the
conversation, so you can watch the agent work.

The agent spawns the `claude` CLI with `--output-format stream-json
--input-format stream-json --permission-prompt-tool stdio`; the main process
parses the stream and forwards events to the renderer, which renders the
conversation (messages + tool calls) and handles tool-permission prompts. Its
system prompt describes the connected device, the conductor command surface, the
POM catalog and the known screens. Requires the
[Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) on `PATH`.

The **scene graph** builds itself: every `capture-ui` — from the inspector, a tap
or a swipe — upserts a screen node keyed by a signature of the hierarchy, and the
preceding action becomes a transition edge. It's persisted to
`.conductor-studio/scenegraph.json` and fed into the agent's system prompt.

## 3. Test case management

Qase-inspired. Test cases are **git-tracked YAML files** under `test-cases/`,
each mapping a user story to the Maestro flow that implements it and tagged by
vertical / platform / product. The Cases screen renders them as a matrix, with a
switchable tag dimension for the columns.

```yaml
id: TC-001
title: User can log in with valid credentials
userStory: As a returning user, I can sign in…
tags:
  platform: [ios, android]
  vertical: [fintech]
  product: [wallet]
flow: login.yaml
```

**Sync CI** pulls the latest GitHub Actions run through the `gh` CLI (so it uses
your existing `gh auth login`) and fills in each case's status. It prefers the
**JUnit report** the run uploads, which names every flow and carries the failure
message; where there's no report it falls back to matching job names against the
case id (`TC-001`) or its flow file, and where a run has no job detail at all
every case shows the run's own result and the UI says so. Workflows can also be
**triggered** from here.

---

## Development

```bash
pnpm install
pnpm dev:studio          # Vite + Electron          (from the repo root)
pnpm build:studio        # type-check + build renderer + bundle electron
pnpm storybook           # the design system at :6006
```

| Command (in `apps/studio`) | What it does |
| --- | --- |
| `pnpm dev` | Vite dev server + Electron |
| `pnpm build` | Type-check (renderer + electron) + Vite build + esbuild bundle |
| `pnpm typecheck:app` / `typecheck:electron` | The two tsconfigs on their own |
| `pnpm dist` | Unsigned local `.app` (electron-builder.yml) |
| `pnpm dist:release` | Signed + notarized, published to GitHub Releases |

Environment: `STUDIO_PROJECT_ROOT` (which repo to open), `CONDUCTOR_BIN`
(which conductor binary), `STUDIO_PORT` (dev server port).

### Layout

```
apps/studio/
  electron/            main process, preload, IPC, services
    services/          file, conductor, device, flow, maestro, cases, pom,
                       scenegraph, agent, updater, settings
  app/                 React renderer
    lib/               ipc, events, types, router, completion, flow slicing
    hooks/             useIpcEvent, useDeviceStream (WebCodecs)
    stores/            data-only Zustand stores
    components/        layout, flows (workbench), agent, cases
  build-electron.mjs   esbuild bundle for main/preload
  vite.config.ts       renderer (COOP/COEP for WebCodecs)
```

### Architecture

- **IPC is four layers**: a service in `electron/services/<domain>/`, registered
  in `electron/ipc.ts` via `handle('snake_case', …)`, called through a typed
  wrapper in `app/lib/ipc.ts` (the only caller of `window.conductorStudio`), with
  shared types in `app/lib/types.ts` — which `tsconfig.main.json` includes, so
  the backend imports the same file.
- **Push events** go the other way: `broadcastToRenderers(channel, payload)` →
  `listen()` / `useIpcEvent()`. Channels are suffixed per entity, e.g.
  `device_video_frame:{deviceId}`, `flow_run_steps:{runId}`, `agent:event:{id}`.
- **State** is data-only Zustand stores in `app/stores/` with module-level
  mutators, so services can drive them imperatively. `electron/state.ts` is the
  backend's single in-memory state.
- **Routing** is hash-based URL-as-state in `app/lib/router.tsx` (`#/flows`,
  `#/flows/<path>`, `#/agent`, `#/cases`). No store mirrors "which screen".
- **Build**: esbuild bundles `electron/{main,preload}.ts` to CJS in
  `dist-electron/`; Vite builds the renderer. Three tsconfigs (renderer, main,
  node).
- **Design system**: token-only styling (`packages/studio-ui/src/styles/tokens.css`,
  light `:root` plus dark `:root[data-theme="dark"]`), one component per folder
  with `.tsx` + `.module.css` + `.stories.tsx`, a single `Icon` component (no
  inline SVG in the app), and a story for every component.

### Video decoding

The daemon sends **bare IDR access units** — the SPS/PPS live only in the config
frame — so the renderer configures its `VideoDecoder` with the `avcC`
`description` and the main process rewrites each Annex B access unit to AVCC
(4-byte length-prefixed NALs) before forwarding it. This mirrors Argus's device
streams. Frames that arrive as a plain object from structured clone are rebuilt,
deltas are dropped while the decoder is behind or awaiting a keyframe, and a
decode error resyncs on the next keyframe rather than surfacing.

## Packaging

- `electron-builder.yml` — unsigned local `dir` build.
- `electron-builder.release.cjs` — signed + notarized dmg/zip, published to
  GitHub Releases for the electron-updater feed. Notarization is
  electron-builder-native (App Store Connect API key env vars); signing certs
  come from the keychain (e.g. Fastlane match).
- `.github/workflows/studio-release.yml` runs the release on demand.
