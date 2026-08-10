---
name: conductor-device-setup
description: Boot, list, and manage devices and app installs for the conductor CLI — iOS simulators, Android emulators, tvOS simulators, Vega (Amazon Fire TV) virtual devices, and Playwright web browsers — plus sessions, the warm-driver daemon, and the parallel device pool. Use when starting or stopping a simulator/emulator/browser, attaching to a Vega VVD, installing or launching an app, setting up the web driver, attaching to an already-running browser over CDP (e.g. an Electron app / its webviews), keeping the driver warm, or coordinating multiple devices for parallel agents.
---

# Conductor — device & app setup

Get a device running and an app installed before you drive it. Start here when
nothing is booted yet.

## Orient first

```bash
conductor workspace info     # detected project type, bundle IDs, devices, Metro port — best first call
conductor list-devices       # booted + available devices
conductor foreground-app     # bundle id of the app currently in front
conductor list-apps          # installed app ids / package names (--json adds appNames on iOS/tvOS)
```

## Devices

| Command                                                               | Purpose                                                                    |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `conductor start-device --platform <ios\|android\|tvos\|web\|vega>`   | Boot a simulator/emulator, start the web driver, or attach to a Vega VVD    |
| `conductor start-device --os-version <n> --device-type <name>`        | Pick OS version + device type (creates if needed)                          |
| `conductor start-device --platform android --avd <name> --device-type <profile> --memory <mb>` | Create an Android AVD with a RAM floor (default 4096MB; only raises, creation-time only) |
| `conductor stop-device [<name-or-id>] [--all]`                        | Shut down device(s)                                                        |
| `conductor delete-device <name-or-id> [--all]`                        | Delete simulator(s)/AVD(s)/web session(s)                                  |
| `conductor set-location --lat <n> --lng <n>`                          | Set GPS coordinates                                                        |
| `conductor set-orientation <portrait\|landscape>`                     | Set orientation                                                            |
| `conductor set-viewport [<w> <h>] [--preset mobile\|tablet\|desktop]` | Resize web viewport (web only)                                             |
| `conductor install-web [--check] [browser]`                           | Install a Playwright browser (chromium/firefox/webkit); `--check` = status |

### Attach to an existing browser (CDP)

Instead of launching its own browser, the web driver can attach to one that's
already running and exposes CDP over a remote-debugging port — e.g. an Electron
app started with `--remote-debugging-port`, where each window / webview is a
separate page target you can drive independently.

| Command                                                                            | Purpose                                                                                                          |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `conductor web-targets --cdp-url <url>`                                            | List the controllable page targets the browser exposes (id, url, title) + a paste-ready bind command for each    |
| `conductor --device web:<browser>:<label> --cdp-url <url> --cdp-target <id> <cmd>` | Bind a session to one target; the attachment persists so later commands for that `--device` don't need the flags |

Use a distinct fully-qualified `--device web:chromium:<label>` per target (a bare
`web` gets an auto-generated sub-id instead). Each target is its own session, so
several webviews can be driven concurrently. Only `type=page` targets are
controllable. See [Web testing → Attaching to an existing browser](../../../docs/web.md).

**Discovery:** endpoints on the conventional debugging ports (9222–9229 on
localhost) are found automatically — `list-devices` shows each webview as a
booted `web:cdp:<port>:<targetId>` device. That id is self-describing, so you can
drive it directly (`conductor --device web:cdp:9222:<targetId> <cmd>`) without
`--cdp-url`/`--cdp-target`. Use `web-targets --cdp-url <url>` for endpoints on a
non-default port, or to list targets before binding.

### Vega (Amazon Fire TV)

Vega is a React Native OS driven through Amazon's own `vega`/`kepler` CLI (not
adb/simctl) — install the Vega SDK and put the CLI on `PATH` (or set
`CONDUCTOR_VEGA_CLI`). `conductor start-device --platform vega` boots a Vega
Virtual Device (VVD) via `vega virtual-device start` (or attaches if one is
already running); pass `--name <vvd>` to pick a specific one. Devices show up in
`list-devices` as `vega:<serial>`. The VVD's
**developer mode** must be on for input, and the automation toolkit attaches at
app launch — so launch the app under test via conductor. Navigate with the D-pad
(`press-key "Remote Dpad …"` / `"Remote Dpad Center"`); coordinate `tap-on` also
works. Unsupported on Vega: deep links (`open-link`), `set-location`, gestures,
screen recording, clipboard, `clear-state`/`uninstall-app`.

## App lifecycle

| Command                                               | Purpose                                                                |
| ----------------------------------------------------- | ---------------------------------------------------------------------- |
| `conductor install-app <path>`                        | Install .app / .ipa / .apk                                             |
| `conductor launch-app <appId>`                        | Launch app (saved to session); `--no-stop-app`, `--argument key=value`, `--inject` (enables the `native-*` in-process instrument — see `conductor-native`) |
| `conductor stop-app [<appId>]`                        | Stop app                                                               |
| `conductor uninstall-app <appId>`                     | Uninstall app                                                          |
| `conductor copy-app <bundleId> --from <id> --to <id>` | Copy an installed app between iOS simulators                           |
| `conductor download-app <appId> --output <path>`      | Download installed app binary                                          |

### ⚠️ Destructive flags — ask the user first

`conductor clear-state [<appId>]`, `launch-app --clear-state`, and
`launch-app --clear-keychain` **wipe app data and sign the user out**, and can't
be undone without their credentials. Never use them to "reset focus" or clear
navigation — relaunch without the flag, or navigate out with `back` / Menu. If
you genuinely need one, ask the human first.

## Sessions, daemon & device pool

A **session** remembers the last device + app so you don't re-specify them.
Parallel agents each get their own `--session <name>` so they don't collide.

| Command                                | Purpose                                                                                              |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `conductor session [--clear] [--list]` | Show, clear, or list sessions                                                                        |
| `conductor daemon-start`               | Start the per-session background daemon (keeps the driver warm — do this for any multi-step session) |
| `conductor daemon-status`              | Show daemon status                                                                                   |
| `conductor daemon-stop [--all]`        | Stop this session's daemon (`--all` = every session)                                                 |
| `conductor device-pool --list`         | List devices + pool status                                                                           |
| `conductor device-pool --acquire`      | Claim a free device (prints id); `--device <id>` claims that one, `--owner <pid>` holds the claim     |
| `conductor device-pool --release <id>` | Release a device back to the pool                                                                    |

Don't leave a daemon running when you're done — `daemon-stop` it.

### Reserving a device

Claim a device before driving it when other agents share the machine, so nobody
taps through your test half-way. A claim belongs to a **process**: conductor
frees any claim whose owner has exited, and the CLI exits immediately, so
`--acquire` on its own reserves nothing. Pass the PID that should hold it:

```bash
conductor device-pool --acquire --device <id> --owner $$ --json   # claim it
conductor device-pool --list --json                               # who holds what
conductor device-pool --release <id>                              # give it back
```

Acquiring a device someone else holds fails rather than stealing it. Always
release when you're done — a crash releases it for you, an abandoned shell
doesn't.

## Tips

- `--device <id>` / `--device-name <name>` targets a device; `--platform` scopes by platform.
- Add `--json` for machine-readable output.
- `conductor <command> --help` for exact flags.
