<div align="center">

<img src="assets/banner.png" alt="Conductor" width="800" />

# 🎼 Conductor

**Give Claude hands. Let it drive your app.**

[![CI](https://github.com/DouweBos/conductor/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/DouweBos/conductor/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@houwert/conductor)](https://www.npmjs.com/package/@houwert/conductor)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

</div>

---

Conductor is a token-efficient CLI for mobile UI interactions, built for AI agents. It's a TypeScript reimplementation and partial fork of [Maestro](https://maestro.mobile.dev) that bundles its own native drivers — no external CLI, no setup friction, no nonsense.

It started as an experiment: what if Claude could tap through your app while it's writing the code? Turns out that's extremely useful. Now it's a proper tool.

## ✨ What it does

Conductor gives Claude Code the ability to interact with iOS simulators and Android emulators directly from a coding session. It can navigate UI, inspect the live hierarchy, take screenshots, run flows, and manage multiple devices in parallel across concurrent agents.

```bash
conductor launch-app com.example.myapp
conductor tap-on "Sign In"
conductor input-text "user@example.com"
conductor assert-visible "Dashboard"
conductor take-screenshot --output /tmp/screen.png
```

One agent writes the feature. Another taps through the app. They talk. It works. 🤝

## 🚀 Quick start

```bash
npm install -g @houwert/conductor
```

That's it. Conductor is a pure CLI — no Claude Code plugin or skill is registered. Wire it into your agent however you like (a custom `CLAUDE.md`, a project skill, a slash command — it's up to you). Run `conductor --help` for the full command reference, or `conductor <command> --help` for per-command flags.

### 📱 What the CLI can do

| Capability | Commands |
|---|---|
| App lifecycle | `launch-app`, `stop-app`, `clear-state`, `uninstall-app`, `install-app`, `foreground-app`, `copy-app` |
| Interaction | `tap-on`, `input-text`, `scroll`, `scroll-until-visible`, `swipe`, `press-key`, `erase-text`, `hide-keyboard` |
| Inspection | `inspect`, `focused`, `take-screenshot`, `capture-ui`, `list-apps` |
| Assertions | `assert-visible`, `assert-not-visible` |
| Navigation | `open-link`, `back` |
| Flows | `run-flow`, `run-flow-inline`, `run-parallel` |
| Devices | `start-device`, `list-devices`, `set-location`, `set-orientation` |
| Web setup | `install-web [browser]` (installs a Playwright browser; `--check` prints status) |

## 🔨 Building locally

### Prerequisites

- Node.js + pnpm v9
- **iOS:** Xcode with command-line tools
- **Android:** Android SDK with `adb` on `PATH`

### Full build

```bash
make build
```

Builds the iOS driver (xcodebuild), the Android driver (Gradle), packages both into the CLI, and compiles TypeScript. Then link it globally:

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
make build-cli          # CLI TypeScript only
make build-ios-driver   # iOS XCTest driver
make build-android-driver # Android instrumentation driver
make package-cli        # Bundle drivers into CLI package
```

## 🗂️ Repository structure

```
conductor/
├── packages/
│   ├── cli/              # TypeScript CLI (@houwert/conductor)
│   ├── android-driver/   # Kotlin/Gradle instrumentation driver
│   └── ios-driver/       # Swift/Xcode XCTest driver
└── Makefile
```

## 🛠️ Development

```bash
pnpm dev     # TypeScript watch mode
pnpm lint    # ESLint + Prettier check
pnpm lint:fix  # Auto-fix formatting
pnpm test    # Run test suite
```

## 📋 Requirements

- **iOS:** Xcode with a booted simulator
- **Android:** `adb` on `PATH` with a running emulator or connected device
