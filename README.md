<div align="center">

<img src="assets/banner.png" alt="Conductor" width="800" />

# Conductor

**Mobile and web UI automation for AI agents.**

[![CI](https://github.com/DouweBos/conductor/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/DouweBos/conductor/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@houwert/conductor)](https://www.npmjs.com/package/@houwert/conductor)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

</div>

---

Conductor is a token-efficient CLI for driving and inspecting running apps, built for AI agents. It is a TypeScript reimplementation and partial fork of [Maestro](https://maestro.mobile.dev) that ships its own native drivers, so there is no external CLI to install and no JVM to configure.

It gives a coding agent the ability to operate an app while writing the code for it: navigate the UI, read the live view hierarchy, take screenshots, run flows, and drive several devices in parallel across concurrent agents.

```bash
conductor launch-app com.example.myapp
conductor tap-on "Sign In"
conductor input-text "user@example.com"
conductor assert-visible "Dashboard"
conductor take-screenshot --output /tmp/screen.png
```

Targets iOS and tvOS simulators, physical iOS/tvOS devices, Android emulators and devices, Amazon Fire TV, and web via Playwright.

## Quick start

```bash
npm install -g @houwert/conductor
```

Conductor is a pure CLI. To teach an AI agent how to use it, install the bundled skills into your repository:

```bash
conductor init            # interactive: pick scope + skills, writes to .claude/skills/
conductor init --yes      # non-interactive: install all skills into ./.claude/skills/
conductor init --global   # install into ~/.claude/skills/ for all repos
conductor init --force    # re-sync skills you have already installed
```

`init` is the one manual setup step — run it once per repository. In a terminal it prompts for which skills and where; piped or headless (CI, agent) it installs everything non-interactively. It writes a set of capability-scoped Claude Code skills — `conductor-device-interact`, `conductor-inspect`, `conductor-create-flow`, `conductor-native`, `conductor-test-cases`, `conductor-metro-debugger`, `conductor-profiler` and `conductor-device-setup` — documenting every command and the act → observe → act workflow.

After upgrading conductor, re-run `conductor init --force` to re-sync the installed skills. `init` stamps the version it installed, so it can tell you when they are stale and prune skills no longer shipped. Integrating another way (a custom `CLAUDE.md`, a slash command) works equally well.

Run `conductor --help` for the full command reference, or `conductor <command> --help` for per-command flags.

### What the CLI can do

| Capability | Commands |
|---|---|
| App lifecycle | `launch-app`, `stop-app`, `clear-state`, `install-app`, `uninstall-app`, `foreground-app`, `copy-app`, `download-app` |
| Interaction | `tap-on`, `input-text`, `scroll`, `scroll-until-visible`, `swipe`, `gesture`, `pinch`, `press-key`, `erase-text`, `hide-keyboard` |
| Inspection | `inspect`, `focused`, `capture-ui`, `take-screenshot`, `list-apps` |
| Assertions | `assert-visible`, `assert-not-visible`, `assert-true`, `assert-screenshot` |
| Navigation | `open-link`, `back` |
| Flows | `run-flow`, `run-flow-inline`, `run-parallel`, `run-sequence`, `flow` |
| Devices | `start-device`, `stop-device`, `list-devices`, `device-pool`, `set-location`, `set-orientation`, `set-permissions` |
| Debugging | `logs`, `crashes`, `network`, `memory`, `profile`, `metro`, `record-video`, `stream-server` |
| In-process (iOS/tvOS) | `native-inspect`, `native-find`, `native-set`, `native-eval`, `native-heap`, and more |
| Test cases | `cases` |
| Web setup | `install-web [browser]` (installs a Playwright browser; `--check` prints status) |
| Discovery | `list-options [command]` / `<command> --options`, `workspace` |

## Conductor Studio

**[Conductor Studio](apps/studio)** is a desktop app (Electron + React) built on this CLI. It does three jobs: writing and managing Maestro tests, writing them with an agent, and tracking them as test cases.

It provides a flow editor with autocomplete and linting, a live device stream with element picking and a record mode that turns your interactions into flow steps, an agentic test writer that verifies described behaviour on a device and files a visual report, and local test case management. Light and dark, signed and notarized, auto-updating.

Studio bundles its own copy of the conductor CLI, so it needs nothing installed globally. The version it uses can be pinned from Settings.

**Download:** [Releases](https://github.com/DouweBos/conductor/releases) — macOS (Apple silicon). Studio releases are tagged `studio-v*`; the CLI's are tagged `cli-v*`.

See the [Studio README](apps/studio/README.md) for the full feature tour, architecture and release process.

```bash
pnpm dev:studio    # run it from source
```

## Repository structure

```
conductor/
├── packages/
│   ├── cli/              # TypeScript CLI (@houwert/conductor)
│   ├── android-driver/   # Kotlin/Gradle instrumentation driver
│   ├── ios-driver/       # Swift/Xcode XCTest driver
│   ├── ios-inproc/       # Library injected into the app for a second inspection plane
│   ├── ios-hid/          # Host binary injecting HID below the XCTest layer
│   ├── ios-capture/      # Host binary capturing the Simulator framebuffer
│   └── studio-ui/        # Design system for Conductor Studio
├── apps/
│   └── studio/           # Conductor Studio — the desktop app
└── Makefile
```

## Building locally

### Prerequisites

- Node.js and pnpm 10
- **iOS/tvOS:** Xcode with command-line tools
- **Android:** Android SDK with `adb` on `PATH`

### Full build

```bash
make build
```

Builds the iOS and tvOS XCTest drivers, the in-process library and capture binary (xcodebuild), and the Android driver (Gradle); packages them all into the CLI and compiles TypeScript. Then link it globally:

```bash
cd packages/cli && pnpm link --global
```

### CLI only

If the drivers are already built and packaged:

```bash
cd packages/cli
pnpm install && pnpm build
```

### Individual targets

```bash
make build-cli            # CLI TypeScript only
make build-ios-driver     # iOS XCTest driver
make build-android-driver # Android instrumentation driver
make package-cli          # Bundle drivers into CLI package
```

## Development

```bash
pnpm dev       # TypeScript watch mode
pnpm lint      # ESLint + Prettier check
pnpm lint:fix  # Auto-fix formatting
pnpm test      # Run test suite
```

## Requirements

- **iOS/tvOS:** Xcode with a booted simulator, or a paired physical device
- **Android:** `adb` on `PATH` with a running emulator or connected device
- **Web:** a Playwright browser (`conductor install-web`)
