# Command catalogue

Every Conductor command grouped by purpose. For exhaustive flag
reference, run `conductor <command> --help` — this page is the
overview. Where a command takes an _element_, see
[Concepts → Element resolution](/conductor/docs/concepts) for how
matching works.

All commands accept `--session <name>` to scope to a named session and
`--device <id>` to override the session's device.

---

## App lifecycle

| Command          | What it does                                                              |
| ---------------- | ------------------------------------------------------------------------- |
| `launch-app`     | Launch the given bundle id / package name. Saves it to the session.       |
| `stop-app`       | Stop the running app.                                                     |
| `clear-state`    | Wipe app data (uninstall + reinstall on Android; reset container on iOS). |
| `uninstall-app`  | Remove the app from the device.                                           |
| `install-app`    | Install a `.app`, `.ipa`, or `.apk` from a path.                          |
| `download-app`   | Download an installed app's binary back to disk.                          |
| `foreground-app` | Print the bundle id / package name of the currently foregrounded app.     |
| `copy-app`       | Copy an app between iOS simulators (handy for repro setups).              |

---

## Interaction

| Command                | What it does                                                             |
| ---------------------- | ------------------------------------------------------------------------ |
| `tap-on`               | Tap the matched element (positional or `--id` / `--text` / coordinates). |
| `input-text`           | Type into the focused field.                                             |
| `erase-text`           | Backspace `n` characters (default 50).                                   |
| `back`                 | Press the back / Esc key.                                                |
| `hide-keyboard`        | Dismiss the on-screen keyboard.                                          |
| `press-key`            | Press a hardware or system key (`home`, `enter`, `volume_up`, …).        |
| `scroll`               | Scroll a direction or onto an element.                                   |
| `scroll-until-visible` | Repeatedly scroll until the target element appears.                      |
| `swipe`                | Swipe between two points (or in a cardinal direction).                   |
| `pinch`                | Two-finger pinch. `--scale <n>` (zoom out <1, zoom in >1), `--center x,y`, `--angle <deg>`, `--duration <ms>`. |
| `rotate-gesture`       | Two-finger rotate. `--degrees <n>`, `--center x,y`, `--duration <ms>`.   |
| `gesture <json>`       | Play an arbitrary multi-touch path. JSON shape: `[{"steps":[{"x":,"y":,"dt":}]}, ...]`. One path per finger; `dt` is delay since previous step (seconds). Pass `--file path.json` instead of inline JSON. |
| `clipboard read`       | Print the iOS simulator clipboard. iOS only — Android has no portable userspace clipboard API. |
| `clipboard write <t>`  | Set the iOS simulator clipboard.                                         |
| `paste`                | Type the clipboard contents into the focused field (iOS only).           |

---

## Inspection

| Command           | What it does                                                                          |
| ----------------- | ------------------------------------------------------------------------------------- |
| `inspect`         | Dump the live UI hierarchy as JSON. `--dump` prints the raw driver output unmodified. |
| `inspect --at x,y`| Print the topmost view at a screen point. Add `--tappable` to filter to interactive elements. |
| `focused`         | Print metadata of the focused element. `--poll` keeps printing on change.             |
| `take-screenshot` | Save a PNG to `--output <path>` (or stdout if omitted).                               |
| `capture-ui`      | Combined screenshot + hierarchy + a11y snapshot — designed to feed into Argus.        |
| `list-apps`       | List installed apps on the current device.                                            |
| `logs`            | Stream platform logs scoped to the current app.                                       |
| `memory`          | Print memory usage / capture a heap profile (Android `hprof`).                        |

---

## Assertions

| Command              | What it does                                                              |
| -------------------- | ------------------------------------------------------------------------- |
| `assert-visible`     | Fail if the element isn't visible. `--timeout` waits; `--optional` skips. |
| `assert-not-visible` | Fail if the element _is_ visible.                                         |

Both accept the same disambiguators as `tap-on`: `--id`, `--text`,
`--index`, `--below`, `--above`, `--left-of`, `--right-of`,
`--enabled`, `--checked`, `--focused`, `--selected`.

---

## Navigation

| Command     | What it does                                   |
| ----------- | ---------------------------------------------- |
| `open-link` | Open a deep link / URL on the device.          |
| `back`      | (Listed in Interaction — also navigates back.) |

---

## Devices

| Command           | What it does                                                               |
| ----------------- | -------------------------------------------------------------------------- |
| `start-device`    | Boot a simulator or emulator by name or id.                                |
| `stop-device`     | Shut it down.                                                              |
| `delete-device`   | Delete a simulator / AVD.                                                  |
| `list-devices`    | List bootable devices and which are currently booted.                      |
| `set-location`    | Set the device's GPS coordinates (`--lat <n> --lng <n>`).                  |
| `set-orientation` | Rotate to `portrait`, `landscape`, `landscape-left`, or `landscape-right`. |
| `device-pool`     | Manage the device pool: list, lock, unlock — used by `run-parallel`.       |

---

## Flows

| Command           | What it does                                                                       |
| ----------------- | ---------------------------------------------------------------------------------- |
| `run-flow`        | Run a YAML flow file against the current session's device.                         |
| `run-flow-inline` | Run a YAML flow string passed on the command line (great for one-off agent calls). |
| `run-parallel`    | Shard a directory of flow files round-robin across every booted device.            |
| `run-sequence`    | Run a batch of commands serially against one session, stopping on first failure. Reads `{"steps":[{"cmd":"tap-on","args":["Login"]}, ...]}` from `--file path.json` or stdin. |
| `flow record start` | Begin recording subsequent device-action commands into a YAML flow at `--out <path>` (or `~/.conductor/recordings/`). Any action you run while recording is appended automatically. |
| `flow record echo <text>` | Insert a `runScript` comment step into the active recording.                |
| `flow record status` | Show the active recording path (if any).                                       |
| `flow record finish` | Close the active recording and print the file path.                            |

See [Flows](/conductor/docs/flows) for the YAML format, env var
injection, and parallel execution semantics.

---

## Web

| Command       | What it does                                                                             |
| ------------- | ---------------------------------------------------------------------------------------- |
| `install-web` | Install a Playwright browser (`chromium`, `firefox`, `webkit`). `--check` prints status. |

Once installed, the same commands above work on `web` "devices" — see
[Web testing](/conductor/docs/web).

---

## Workspace

| Command           | What it does                                                                       |
| ----------------- | ---------------------------------------------------------------------------------- |
| `workspace info`  | One-shot report of project type (RN / Expo / iOS / Android / Web / mixed), bundle ids, detected `ios/` and `android/` dirs, Metro port, and booted devices. Avoids the agent re-deriving these from `package.json` and `list-devices`. |

---

## Metro

For React Native projects.

| Command         | What it does                                                                             |
| --------------- | ---------------------------------------------------------------------------------------- |
| `metro stop`    | Stop the Metro bundler process listening on `--port <n>` (default 8081). Uses `lsof` + `SIGTERM`, escalates to `SIGKILL` after 2s. |
| `metro reload`  | Reload the JS bundle without restarting the native process. `Page.reload` over CDP, falls back to `POST /reload`. |

---

## Crashes

| Command            | What it does                                                                             |
| ------------------ | ---------------------------------------------------------------------------------------- |
| `crashes list`     | List recent crash reports. iOS host-side `.ips`/`.crash` files from `~/Library/Logs/DiagnosticReports/`, plus Android `logcat -b crash` for the current device. `--app <bundleId>`, `--since <duration>` (e.g. `2h`, `30m`). |
| `crashes show <id>`| Print a specific iOS crash report by file name.                                          |
| `crashes tail`     | Stream new crash reports as they appear. iOS via `fs.watch` on the diagnostic reports directory; Android via `adb logcat -b crash`. |

Output schema (JSON): `{ id, timestamp, app, type, signal, threadName, topFrames[], sourceFile, platform }`.
The text parser is heuristic — most fields are best-effort across iOS versions; symbolicated frames may not appear without a matching `.dSYM`.

---

## Daemon

| Command         | What it does                                                                 |
| --------------- | ---------------------------------------------------------------------------- |
| `daemon-start`  | Start a long-running daemon for the current session (keeps the driver warm). |
| `daemon-stop`   | Stop this session's daemon. `--all` stops every session's daemon.            |
| `daemon-status` | Show whether a daemon is running for the current (or all) session(s).        |

Optional. Speeds up agents that issue many commands in a row.

---

## Session

| Command   | What it does                                                       |
| --------- | ------------------------------------------------------------------ |
| `session` | Inspect or clear the current session's saved `appId` / `deviceId`. |
