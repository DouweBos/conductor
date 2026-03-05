# Conductor

[![CI](https://github.com/DouweBos/conductor/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/DouweBos/conductor/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@houwert/conductor)](https://www.npmjs.com/package/@houwert/conductor)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A token-efficient CLI for mobile UI interactions, designed for AI agents.

Conductor is a TypeScript reimplementation and partial fork of Maestro that talks directly to bundled native drivers. It was built as part of an experiment to integrate Maestro-like testing frameworks as skills for Claude to validate features during implementation. And as a way to have an agent team navigate the UI of their apps automatically and write up test plans + maestro flows for their apps with minimal supervision.

## Claude Skills

Conductor's primary purpose is to give Claude the ability to interact with mobile apps. It ships with a skill that teaches Claude every available command, how to use them, and how to run multi-agent parallel tests across devices.

### Install into a project

From the root of any project that uses Claude Code, run:

```bash
conductor install --skills
```

This copies the skill files into `.claude/skills/conductor/` in the current directory. Claude Code picks them up automatically and gains the ability to launch apps, tap elements, inspect the UI hierarchy, take screenshots, and run flows — all without leaving the coding session.

### What gets installed

```
.claude/skills/conductor/
├── SKILL.md               # Full command reference and agent workflow guide
└── references/
    └── flow-syntax.md     # Maestro YAML flow syntax reference
```

### What Claude can do with this skill

- Launch and stop apps on iOS simulators and Android emulators
- Tap, type, scroll, swipe, and press keys
- Inspect the live UI hierarchy to find element text and accessibility IDs
- Assert that elements are visible or absent
- Take screenshots and open deep links
- Run Maestro YAML flows
- Manage multiple devices in parallel across concurrent agents

See [`packages/cli/skills/conductor/SKILL.md`](./packages/cli/skills/conductor/SKILL.md) for the full reference.

## Repository Structure

```
conductor/
├── packages/
│   ├── cli/              # TypeScript CLI tool (@conductor/cli)
│   ├── android-driver/   # Android driver (Kotlin/Gradle)
│   └── ios-driver/       # iOS driver (Xcode/Swift)
├── Makefile              # Top-level build orchestration
└── pnpm-workspace.yaml
```

## Building Locally

### Prerequisites

- **Node.js** and **pnpm** (v9)
- **Android:** Android SDK with `adb` on `PATH`
- **iOS:** Xcode with command-line tools installed

### Full build (CLI + drivers)

```bash
make build
```

This runs the following steps in order:

1. Builds the iOS driver with `xcodebuild`
2. Builds the Android driver with Gradle
3. Packages both drivers into `packages/cli/drivers/`
4. Compiles the CLI TypeScript
5. (Optional) Links the CLI globally

```bash
cd packages/cli
pnpm link --global
```

This makes the `conductor` command available in your shell.

### Build individual components

```bash
# CLI only (requires drivers already built and packaged)
make build-cli

# iOS driver only
make build-ios-driver

# Android driver only
make build-android-driver

# Package drivers into the CLI (after building both drivers)
make package-cli
```

### CLI only (no driver rebuild)

If the native drivers are already built and packaged, you can work on the CLI alone:

```bash
cd packages/cli
pnpm install
pnpm build
```

## Installing the CLI

After building, link the CLI globally:

```bash
cd packages/cli
pnpm link --global
```

This makes the `conductor` command available in your shell.

## Usage

### Start a device

```bash
conductor start-device --platform ios
conductor start-device --platform android
```

### List connected devices

```bash
conductor list-devices
```

### Launch an app and interact

```bash
conductor launch-app com.example.myapp
conductor tap "Sign In"
conductor type "user@example.com"
conductor assert-visible "Dashboard"
conductor screenshot --output /tmp/screen.png
```

### Inspect the UI hierarchy

```bash
conductor inspect
```

### Run a Maestro YAML flow

```bash
conductor run-flow ./flows/login.yaml
```

## Development

### Run the TypeScript compiler in watch mode

```bash
cd packages/cli
pnpm dev
```

### Lint and format

```bash
cd packages/cli
pnpm lint
pnpm format
```

### Run tests

```bash
cd packages/cli
pnpm test
```

## Requirements

- **Android:** `adb` on `PATH` with a running emulator or connected device
- **iOS:** Xcode with a running simulator
