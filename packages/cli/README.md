# Conductor

A token-efficient CLI for mobile UI testing, designed for AI agents.

Inspired by [`@playwright/cli`](https://github.com/microsoft/playwright-cli), this is a TypeScript reimplementation and partial fork of [Maestro](https://github.com/mobile-dev-inc/maestro) that talks directly to the bundled native drivers — no external CLI installation required.

## Installation

```bash
pnpm install
pnpm build
pnpm link --global
```

## Quick Start

```bash
conductor list-devices
conductor launch-app com.example.myapp
conductor tap "Sign In"
conductor type "user@example.com"
conductor screenshot --output /tmp/screen.png
```

## Documentation

See [`skills/conductor/SKILL.md`](./skills/conductor/SKILL.md) for full command reference.

## Requirements

- Android: `adb` on `PATH` with a running emulator/device
- iOS: Xcode with a running simulator

## Architecture

- `src/session.ts` — persists `appId` + `deviceId` in `~/.conductor/session.json`
- `src/runner.ts` — resolves devices, manages driver lifecycle, executes flows natively
- `src/commands/` — one file per command
- `src/index.ts` — argument parsing with `minimist`, command dispatch
