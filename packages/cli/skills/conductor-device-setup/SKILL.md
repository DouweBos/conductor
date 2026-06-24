---
name: conductor-device-setup
description: Boot, list, and manage devices and app installs for the conductor CLI — iOS simulators, Android emulators, tvOS simulators, and Playwright web browsers — plus sessions, the warm-driver daemon, and the parallel device pool. Use when starting or stopping a simulator/emulator/browser, installing or launching an app, setting up the web driver, keeping the driver warm, or coordinating multiple devices for parallel agents.
---

# Conductor — device & app setup

Get a device running and an app installed before you drive it. Start here when
nothing is booted yet.

## Orient first

```bash
conductor workspace info     # detected project type, bundle IDs, devices, Metro port — best first call
conductor list-devices       # booted + available devices
conductor foreground-app     # bundle id of the app currently in front
conductor list-apps          # installed app ids / package names
```

## Devices

| Command | Purpose |
|---|---|
| `conductor start-device --platform <ios\|android\|tvos\|web>` | Boot a simulator/emulator or start the web driver |
| `conductor start-device --os-version <n> --device-type <name>` | Pick OS version + device type (creates if needed) |
| `conductor stop-device [<name-or-id>] [--all]` | Shut down device(s) |
| `conductor delete-device <name-or-id> [--all]` | Delete simulator(s)/AVD(s)/web session(s) |
| `conductor set-location --lat <n> --lng <n>` | Set GPS coordinates |
| `conductor set-orientation <portrait\|landscape>` | Set orientation |
| `conductor set-viewport [<w> <h>] [--preset mobile\|tablet\|desktop]` | Resize web viewport (web only) |
| `conductor install-web [--check] [browser]` | Install a Playwright browser (chromium/firefox/webkit); `--check` = status |

## App lifecycle

| Command | Purpose |
|---|---|
| `conductor install-app <path>` | Install .app / .ipa / .apk |
| `conductor launch-app <appId>` | Launch app (saved to session); `--no-stop-app`, `--argument key=value` |
| `conductor stop-app [<appId>]` | Stop app |
| `conductor uninstall-app <appId>` | Uninstall app |
| `conductor copy-app <bundleId> --from <id> --to <id>` | Copy an installed app between iOS simulators |
| `conductor download-app <appId> --output <path>` | Download installed app binary |

### ⚠️ Destructive flags — ask the user first

`conductor clear-state [<appId>]`, `launch-app --clear-state`, and
`launch-app --clear-keychain` **wipe app data and sign the user out**, and can't
be undone without their credentials. Never use them to "reset focus" or clear
navigation — relaunch without the flag, or navigate out with `back` / Menu. If
you genuinely need one, ask the human first.

## Sessions, daemon & device pool

A **session** remembers the last device + app so you don't re-specify them.
Parallel agents each get their own `--session <name>` so they don't collide.

| Command | Purpose |
|---|---|
| `conductor session [--clear] [--list]` | Show, clear, or list sessions |
| `conductor daemon-start` | Start the per-session background daemon (keeps the driver warm — do this for any multi-step session) |
| `conductor daemon-status` | Show daemon status |
| `conductor daemon-stop [--all]` | Stop this session's daemon (`--all` = every session) |
| `conductor device-pool --list` | List devices + pool status |
| `conductor device-pool --acquire` | Claim a free device (prints id) |
| `conductor device-pool --release <id>` | Release a device back to the pool |

Don't leave a daemon running when you're done — `daemon-stop` it.

## Tips

- `--device <id>` / `--device-name <name>` targets a device; `--platform` scopes by platform.
- Add `--json` for machine-readable output.
- `conductor <command> --help` for exact flags.
