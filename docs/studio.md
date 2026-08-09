# Conductor Studio

Conductor Studio is a desktop app (Electron + React) that sits on top of the
conductor CLI. It lives in this monorepo at `apps/studio`, with a shared design
system at `packages/studio-ui` (`@conductor/studio-ui`).

It has light and dark modes, is notarized, and auto-updates.

## Three jobs

### 1. Writing & managing Maestro tests

A Maestro-Studio-style workbench:

- **Left** — a file tree of the project's flows (`.maestro/` by default).
- **Center** — a YAML/JS editor (CodeMirror) with tabs, plus a run console and a
  REPL for running conductor commands live.
- **Right** — a live device stream and an element inspector.

The device mirror and inspector always use conductor: the daemon's H.264 video
WebSocket (`conductor stream-server`) is decoded in the renderer via WebCodecs,
taps/swipes go through conductor's input commands, and the inspector reads
`conductor capture-ui`. Clicking an element generates a Maestro command you can
insert into the editor.

**Running flows** prefers the **system-installed `maestro`** binary
(`maestro test <file>`) and falls back to **`conductor run-flow`** when maestro is
not on `PATH`. The console labels which engine ran. (Conductor's flow YAML is a
subset of Maestro's, so most flows run under either.)

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

### 3. Test case management

Qase-inspired. Test cases are **git-tracked YAML files** under `test-cases/`,
each mapping a user story to the Maestro flow that implements it and tagged by
vertical / platform / product. The Cases screen renders them as a matrix; CI
status will sync from GitHub Actions.

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
