# Getting started

Conductor is a token-efficient CLI that lets AI agents (or you) drive iOS
simulators, Android emulators, and Playwright-managed web browsers. It's
a TypeScript reimplementation and partial fork of
[Maestro](https://maestro.mobile.dev) — but it bundles its own native
drivers, so there's no second CLI to install, no Java to manage, and no
external service to talk to.

This page walks through install, prerequisites, and your first command.

---

## Install

```bash
npm install -g @houwert/conductor
```

That's it. Conductor is published to npm as
[`@houwert/conductor`](https://www.npmjs.com/package/@houwert/conductor)
and ships with the iOS XCTest driver, Android instrumentation driver,
and a thin Playwright wrapper for web — all bundled.

To verify the install:

```bash
conductor --help
conductor --version
```

---

## Prerequisites

Conductor doesn't reimplement Xcode or the Android SDK — it drives them.
What you need depends on which platforms you want to target.

| Platform    | Required                                                                                |
| ----------- | --------------------------------------------------------------------------------------- |
| **iOS**     | Xcode (full install, not just CLT) with the iOS Simulator runtimes you want to drive.   |
| **Android** | Android SDK with `adb` on `PATH`. Either an emulator from `avdmanager` or a wired-up device. |
| **Web**     | Run `conductor install-web` once after install — fetches the Playwright browser binary. |

For Node.js itself, any modern LTS works; the package targets the active
Node LTS line.

You don't need to authenticate Conductor or sign up for anything. There
is no account.

---

## Your first command

Boot a simulator (any iOS Simulator or Android emulator works) and try:

```bash
# iOS
conductor launch-app com.apple.Preferences
conductor tap-on "General"
conductor assert-visible "About"

# Android
conductor launch-app com.android.settings
conductor tap-on "Network"
```

Conductor talks to the running simulator via its bundled driver. The
first command on a new device takes a moment while the driver is
installed; subsequent commands are fast.

---

## What the CLI is for

Conductor is designed to be called from inside an AI coding session.
The most common pattern looks like this:

1. An agent edits the app source code.
2. The agent runs `conductor launch-app …` and `conductor tap-on …`
   to drive the simulator and verify the change.
3. `conductor inspect` and `conductor capture-ui` give the agent a
   structured snapshot of the screen so it knows what to do next.

It can also be scripted by humans, used in CI, or driven from any tool
that can spawn a subprocess. There's no Claude-specific glue baked in
— you wire it into your agent however you like (a custom `CLAUDE.md`,
a project skill, a slash command — whatever you prefer).

---

## Where to go next

- [Concepts](/conductor/docs/concepts) — sessions, drivers, devices,
  and the daemon.
- [Command catalogue](/conductor/docs/commands) — every command grouped
  by purpose.
- [Flows](/conductor/docs/flows) — run YAML scripts and shard them
  across booted devices.
- [Web testing](/conductor/docs/web) — drive Playwright the same way
  you drive a phone.
- [Privacy](/conductor/docs/privacy) — what Conductor does and doesn't
  send anywhere (spoiler: nothing).
