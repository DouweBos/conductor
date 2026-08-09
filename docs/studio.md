# Conductor Studio

Conductor Studio is a desktop app (Electron + React) that sits on top of the
conductor CLI. It lives in this monorepo at `apps/studio`, with a shared design
system at `packages/studio-ui` (`@conductor/studio-ui`).

It has light and dark modes, is notarized, and auto-updates.

## Three jobs

### 1. Writing & managing Maestro tests

A Maestro-Studio-style workbench:

- **Left** — a file tree of the project's flows, with a right-click menu to
  **rename / duplicate / delete / add folders**. Studio finds the flows directory
  by searching the repo four levels deep for a `.maestro`/`maestro` folder that
  actually holds flows (an `appId:` header or a `---` separator — so a
  `.github/actions/maestro` full of workflow YAML doesn't count). A monorepo
  keeping them per-app, like `apps/plex/.maestro`, is found; when there's more
  than one the sidebar offers a picker.
- **Center** — a YAML/JS editor (CodeMirror) with tabs, a run toolbar, and a
  console.
- **Right** — a live device stream and an element inspector.

The device mirror and inspector always use conductor: the daemon's H.264 video
WebSocket (`conductor stream-server`) is decoded in the renderer via WebCodecs,
taps/swipes go through conductor's input commands, and the inspector reads
`conductor capture-ui`.

The panel has two modes:

- **Interact** — your taps and swipes drive the device.
- **Inspect** — Maestro-Studio-style element picking. Every captured element is
  outlined over the stream; hovering highlights the smallest one under the
  cursor, and clicking it lists the commands that fit it — **tapOn / longPressOn
  / inputText / assertVisible / copyTextFrom / runFlow-when-visible** — each
  rendered as ready-to-paste YAML with an Insert button. Selectors are offered
  best-first: accessibility id, then text (indexed when the text isn't unique),
  then a percentage coordinate. Coordinates are offered only for tap-like
  commands, since an assertion can't match a point. On tvOS you get the remote
  keys instead of taps, because focus navigation is the only thing that works
  there. Picking in the inspector tree and picking on the stream are the same
  selection.

**Running flows** prefers the **system-installed `maestro`** binary
(`maestro test`) and falls back to **`conductor run-flow`** when maestro is not on
`PATH`. The console labels which engine ran. (Conductor's flow YAML is a subset of
Maestro's.) The toolbar covers what a test engineer expects:

- **Run**, **Run selection** (runs the highlighted steps inline), and **Run all**
  (the whole flows folder).
- **Run options**: environment variables (`--env`) and include/exclude tags.
- A **step checklist** that ticks off each step live, plus a **screenshot captured
  automatically on failure**.
- A **REPL** with two modes: `conductor` (run a raw CLI command) and `maestro`
  (run a YAML step inline against the device).
- **Record mode**: toggle it and your taps/swipes on the device are appended to
  the open flow as Maestro steps (taps resolve to text/id selectors via
  `capture-ui`).
- A **Logs** tab that streams `conductor logs` for the connected device.

### 2. Agentic test writing

A Claude Code wrapper (ported from Argus) that drives the app through conductor,
reuses the repo's Maestro **subflow POMs**, and is seeded with a **scene graph**
of discovered screens (`.conductor-studio/scenegraph.json`) so later runs skip
re-orientation.

The agent spawns the `claude` CLI with `--output-format stream-json
--input-format stream-json --permission-prompt-tool stdio`; the main process
parses the stream and forwards events to the renderer, which renders the
conversation (messages + tool calls) and handles tool-permission prompts. Its
system prompt describes the connected device, the conductor command surface, the
POM catalog, and the known screens, so it drives the app with `conductor` via the
Bash tool. Requires the [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)
on `PATH`.

The **scene graph** builds itself: every `capture-ui` (from the inspector, a tap,
or a swipe) upserts a screen node keyed by a signature of the hierarchy, and the
preceding action becomes a transition edge. It's persisted to
`.conductor-studio/scenegraph.json` and fed into the agent's system prompt, so
repeated runs skip re-orientation. The inspector header shows how many screens
are mapped.

### 3. Test case management

Qase-inspired. Test cases are **git-tracked YAML files** under `test-cases/`,
each mapping a user story to the Maestro flow that implements it and tagged by
vertical / platform / product. The Cases screen renders them as a matrix.

**Sync CI** pulls the latest GitHub Actions run through the `gh` CLI (so it uses
your existing `gh auth login`) and fills in each case's status. A case binds to
the job that exercises it — the job name has to mention the case id (`TC-001`) or
the flow file it points at. The header shows how many cases matched; when a run
reports no job detail at all, every case falls back to the run's own result and
the UI says so.

Example case:

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

## Development

```bash
pnpm install
pnpm dev:studio          # Vite + Electron
pnpm --filter @conductor/studio-ui storybook   # design system at :6006
pnpm build:studio        # type-check + build renderer + bundle electron
```

The app opens the enclosing git repository as its project (override with
`STUDIO_PROJECT_ROOT`). Set `CONDUCTOR_BIN` to point at a specific conductor CLI;
otherwise Studio uses `conductor` on `PATH` or the workspace build at
`packages/cli/dist/index.js`.

## Packaging

- `apps/studio/electron-builder.yml` — unsigned local `dir` build.
- `apps/studio/electron-builder.release.cjs` — signed + notarized dmg/zip,
  published to GitHub Releases for the electron-updater feed.
- Notarization is electron-builder-native (App Store Connect API key env vars);
  signing certs come from the keychain (e.g. Fastlane match).
- `.github/workflows/studio-release.yml` runs the release on demand.
