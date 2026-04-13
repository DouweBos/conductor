---
name: conductor
version: 0.2.0
description: "Token-efficient CLI for mobile UI testing (iOS simulator + Android emulator), designed for AI agents"
metadata.openclaw:
  category: service
  requires:
    bins: [conductor]
---

# conductor

A token-efficient CLI for Conductor mobile UI testing, designed for AI agents.

## Usage

```
conductor <command> [args] [options]
```

Global options:
- `--device <id>` — target device ID; also keys the session and daemon (auto-detected if omitted)
- `--device-name <name>` — target a booted device by its human-readable name (resolved to ID from booted devices); mutually exclusive with `--device`
- `--help` — show help
- `--json` — machine-readable JSON output (avoid unless you need structured parsing)
- `--verbose / -v` — log daemon calls, driver fallbacks, and raw output

---

## Commands

### `list-devices`

List connected Android emulators and iOS simulators. Shows both booted (running) devices and available (shutdown) simulators/emulators that can be started with `start-device`.

```bash
conductor list-devices
```

Output:
```
Booted devices:
  android  device     emulator-5554  Pixel_6_API_33
  ios      booted     ABC123-DEF456  iPhone 15

Available devices:
  ios      shutdown   DEF789-ABC012  iPhone 16 Pro
  android  available  Pixel_7_API_34  Pixel_7_API_34
```

Exits with code 0 if any booted or available devices exist, 1 only if both lists are empty.

---

### `foreground-app`

Print the bundle ID (iOS) or package name (Android) of the currently open app.

```bash
conductor foreground-app
conductor foreground-app --device C59D3241-FB6A-4E3B-AE7B-A82D3C933889
```

---

### `list-apps`

List all installed app IDs (bundle IDs on iOS, package names on Android), sorted alphabetically. Does not require the driver to be running.

```bash
conductor list-apps
conductor list-apps --device emulator-5554
```

---

### `copy-app <bundleId>`

Copy an installed app from one iOS simulator to another. Useful when you have a compiled `.app` bundle on one simulator and want to install it on others without recompiling.

```bash
conductor copy-app com.example.myapp --from C59D3241-FB6A-4E3B-AE7B-A82D3C933889 --to 86B1BC33-7D83-47FF-AAFE-1BD70FC53038
```

Flags:
- `--from <id>` — source device ID (must be an iOS simulator)
- `--to <id>` — target device ID (must be an iOS simulator)

Both flags are required. The command reads the `.app` bundle path from the source simulator and installs it on the target.

---

### `install-app <path>`

Install an app from a local `.app` bundle, `.ipa`, or `.apk` file onto the device.

```bash
conductor install-app ./build/MyApp.app
conductor install-app ./build/app-debug.apk --device emulator-5554
```

---

### `launch-app <appId>`

Launch an app by bundle ID and save it to the session.

```bash
conductor launch-app com.example.myapp
conductor launch-app com.example.myapp --device emulator-5554
conductor launch-app com.example.myapp --clear-state          # wipe app data first
conductor launch-app com.example.myapp --clear-keychain        # wipe keychain first
conductor launch-app com.example.myapp --no-stop-app           # resume instead of restart
conductor launch-app com.example.myapp --argument env=staging --argument debug=true
```

Flags:
- `--clear-state` — clear app data/state before launching
- `--clear-keychain` — clear keychain before launching (iOS: full keychain; Android: account credentials)
- `--no-stop-app` — do not stop the app before launching; brings it to the foreground instead of restarting it (default: app is stopped first)
- `--argument key=value` — set a launch argument; repeatable for multiple arguments

The `appId` and `deviceId` are persisted to `~/.conductor/sessions/<deviceId>.json` and reused by subsequent commands.

---

### `stop-app [<appId>]`

Stop the running app. Uses session `appId` if not specified.

```bash
conductor stop-app
conductor stop-app com.example.myapp
```

---

### `clear-state [<appId>]`

Clear app data/state without relaunching. Uses the session `appId` if not specified. On iOS this terminates the app, preserves the .app bundle, uninstalls, and reinstalls (clearing all user data). On Android this runs `pm clear`.

```bash
conductor clear-state
conductor clear-state com.example.myapp
```

---

### `uninstall-app <appId>`

Uninstall an app from the device. The app ID is required.

```bash
conductor uninstall-app com.example.myapp
conductor uninstall-app com.example.myapp --device emulator-5554
```

---

### `tap <element>`

Tap a UI element by its text label or accessibility ID. **Try the most obvious text label or ID first** — e.g. `"Sign In"`, `"Submit"`, `"btn_login"`. Only run `inspect` to look up the exact identifier if your first attempt fails. **For icon-only buttons (no visible text label), always run `inspect` first** to find the accessibility ID before tapping.

```bash
conductor tap "Sign In"
conductor tap --id "btn_login"             # match by accessibility ID instead of text
conductor tap --text "Edit"                # match by text only (not id)
conductor tap "Next" --index 1             # pick the 2nd match (0-based)
conductor tap "Add to cart" --long-press
conductor tap "Like" --double-tap
conductor tap "Delete" --optional          # do not fail if not found
conductor tap "Edit" --below "Username"    # tap "Edit" that is below the "Username" element
conductor tap "Submit" --above "Footer"
conductor tap ">" --right-of "Email"
```

Flags:
- `--id <id>` — match by accessibility ID / resourceId instead of text
- `--text <text>` — match by text only (not id); bare positional arg matches text OR id
- `--index <n>` — pick the nth match when multiple elements share the same text/id (0-based)
- `--long-press` — hold instead of tap
- `--double-tap` — double-tap the element
- `--optional` — do not fail if element is not found
- `--focused` — match only focused elements
- `--enabled` / `--no-enabled` — match by enabled state
- `--checked` / `--no-checked` — match by checked state
- `--selected` / `--no-selected` — match by selected state
- `--below <text>` — match element below the given reference element
- `--above <text>` — match element above the given reference element
- `--left-of <text>` — match element left of the given reference element
- `--right-of <text>` — match element right of the given reference element

---

### `type <text>`

Type text into the currently focused input field.

```bash
conductor type "hello@example.com"
conductor type "my password"
```

---

### `erase-text [n]`

Erase characters from the currently focused input field. Defaults to 50 characters.

```bash
conductor erase-text        # erase 50 characters
conductor erase-text 10     # erase 10 characters
```

---

### `back`

Press the Android back button. **Android only** — iOS has no back button. On iOS, always run `inspect` first to find the exact label or accessibility ID of the in-app back button, then use `tap` to press it.

```bash
conductor back
```

---

### `press-key <key>`

Press a hardware or keyboard key. Valid keys: `Enter`, `Backspace`, `Home`, `End`, `Tab`, `Delete`, `Escape`, `VolumeUp`, `VolumeDown`, `Power`, `Lock`, `Back`, `Camera`, `Search`, `Remote Dpad Up`, `Remote Dpad Down`, `Remote Dpad Left`, `Remote Dpad Right`, `Remote Dpad Center`.

Not all keys are supported on all platforms — unsupported keys are silently ignored (e.g. `Back` on iOS). The `Remote Dpad *` keys are Android TV only.

```bash
conductor press-key Enter
conductor press-key Backspace
conductor press-key VolumeUp
```

---

### `hide-keyboard`

Dismiss the on-screen keyboard. On iOS, sends the return key; on Android, sends KEYCODE_ESCAPE.

```bash
conductor hide-keyboard
```

---

### `scroll`

Scroll the screen. Default direction is `down`.

```bash
conductor scroll
conductor scroll --direction up
conductor scroll --direction left
conductor scroll --direction right
```

Directions: `down` | `up` | `left` | `right`

---

### `swipe`

Perform a swipe gesture.

```bash
conductor swipe --direction UP
conductor swipe --direction DOWN
conductor swipe --direction LEFT
conductor swipe --direction RIGHT
conductor swipe --start 0.5,0.8 --end 0.5,0.2          # normalised coords (0–1)
conductor swipe --start 540,1600 --end 540,400          # absolute px
conductor swipe --direction UP --duration 1000          # slower swipe
```

Flags:
- `--direction <UP|DOWN|LEFT|RIGHT>` — directional swipe (case-insensitive)
- `--start <x,y>` — start coordinate; values ≤1 are treated as normalised (0–1), larger as absolute px
- `--end <x,y>` — end coordinate (same normalisation rule)
- `--duration <ms>` — swipe duration in milliseconds (default: 500); use `--start`/`--end` or `--direction`

---

### `scroll-until-visible <element>`

Scroll in a direction until an element is visible. Useful for long lists.

```bash
conductor scroll-until-visible "Checkout"
conductor scroll-until-visible --id "btn_submit"
conductor scroll-until-visible "Terms" --direction up
conductor scroll-until-visible "Privacy" --timeout 60000
```

Flags:
- `--id <id>` — match by accessibility ID / resourceId instead of text
- `--text <text>` — match by text only (not id)
- `--direction <down|up|left|right>` — scroll direction (default: `down`)
- `--timeout <ms>` — max time in milliseconds (default: 30 000)

---

### `assert-visible <element>`

Assert that a UI element is visible on screen. Exits with code 1 if not found. Try the expected text or ID directly — only use `inspect` if it fails and you need to find the exact identifier.

```bash
conductor assert-visible "Welcome"
conductor assert-visible --id "dashboard_title"
conductor assert-visible --text "Submit"               # text-only match
conductor assert-visible "Loading..." --optional       # do not fail if absent
conductor assert-visible "Dashboard" --timeout 30000   # wait up to 30 s
conductor assert-visible "Edit" --below "Username"     # relative position
conductor assert-visible "Item" --index 2              # third match (0-based)
```

Flags:
- `--id <id>` — match by accessibility ID / resourceId instead of text
- `--text <text>` — match by text only (not id); bare positional arg matches text OR id
- `--index <n>` — pick the nth match (0-based)
- `--timeout <ms>` — max wait time in milliseconds (default: 17 000)
- `--optional` — succeed even if the element is not found (useful for conditional checks)
- `--focused` — match only focused elements
- `--enabled` / `--no-enabled` — match by enabled state
- `--checked` / `--no-checked` — match by checked state
- `--selected` / `--no-selected` — match by selected state
- `--below <text>` — match element below the given reference element
- `--above <text>` — match element above the given reference element
- `--left-of <text>` — match element left of the given reference element
- `--right-of <text>` — match element right of the given reference element

---

### `assert-not-visible <element>`

Assert that a UI element is **not** visible on screen. Fails (exit code 1) if the element is found. Use for verifying elements have been dismissed or hidden.

```bash
conductor assert-not-visible "Loading..."
conductor assert-not-visible --id "error_banner"
conductor assert-not-visible "Error" --timeout 5000    # wait up to 5 s for it to disappear
```

Flags:
- `--id <id>` — match by accessibility ID / resourceId instead of text
- `--text <text>` — match by text only (not id)
- `--index <n>` — pick the nth match (0-based)
- `--timeout <ms>` — max time to wait for element to disappear (default: 1 000)

---

### `open-link <url>`

Open a URL or deep link on the device. Works for both HTTP URLs and custom scheme deep links.

```bash
conductor open-link "https://example.com/reset-password"
conductor open-link "myapp://onboarding"
```

---

### `set-location --lat <n> --lng <n>`

Set the device's simulated GPS location.

```bash
conductor set-location --lat 52.3676 --lng 4.9041
conductor set-location --lat 37.7749 --lng -122.4194
```

---

### `set-orientation <portrait|landscape>`

Set the device orientation.

```bash
conductor set-orientation portrait
conductor set-orientation landscape
```

---

### `screenshot`

Take a screenshot of the current screen. **Prefer `inspect` over `screenshot`** when you need to understand what is on screen — the view hierarchy tells you element text, IDs, and structure without consuming a vision token. Use `screenshot` only for visual evidence, debugging rendering issues, or when a human needs to see the screen.

```bash
conductor screenshot
conductor screenshot --output /tmp/screen.png
conductor screenshot --output ./screenshots/login.png
```

Default output: `./screenshot-<timestamp>.png`

**Screenshot path guidance:** Always write to `/tmp/<agent-name>/` (e.g. `/tmp/tester-ios-iphone-16/screen.png`). This keeps files off the working directory, is unique per agent, and is the same folder used for YAML flows. Create it with `mkdir -p` before first use.

---

### `inspect`

Print the UI element hierarchy of the current screen. Use this when a `tap` or `assert-visible` fails and you need to discover the exact element text or accessibility ID.

The hierarchy shows each element's type, text, and accessibility ID (resourceId / accessibilityIdentifier). Use the `text` value or `id` value as the argument to `tap` / `assert-visible`.

```bash
conductor inspect
```

---

### `run-flow <file>`

Execute a Maestro YAML flow file.

```bash
conductor run-flow ./flows/login.yaml
conductor run-flow ./flows/checkout.yaml --device emulator-5554
```

---

### `run-flow-inline <yaml>`

Execute inline Maestro YAML commands directly.

```bash
conductor run-flow-inline "- tapOn: \"Submit\"\n- assertVisible: \"Success\""
```

---

### `session`

Show, clear, or list device sessions.

```bash
conductor session                              # show session for auto-detected device
conductor session --device <id>               # show session for a specific device
conductor session --clear --device <id>       # clear a device's session
conductor session --list                       # list all device sessions
```

Sessions are stored in `~/.conductor/sessions/<deviceId>.json`.

---

### `cheat-sheet`

Print this command reference inline.

```bash
conductor cheat-sheet
```

---

### `install-skills`

Copy the conductor skill files into the current project's `.claude/skills/conductor/` directory, so AI agents in that project can use the `cheat-sheet` command locally.

```bash
conductor install-skills
```

---

### `daemon-start`

Start the background daemon for the current device session. The daemon keeps the driver process alive between commands, reducing startup overhead. Commands auto-start the driver directly if no daemon is running — this is optional.

```bash
conductor daemon-start
conductor daemon-start --device emulator-5554
```

---

### `daemon-stop`

Stop the daemon for a device session.

```bash
conductor daemon-stop
conductor daemon-stop --device emulator-5554
conductor daemon-stop --all     # stop all running daemons
```

---

### `daemon-status`

Show whether the daemon is running for a device session.

```bash
conductor daemon-status
conductor daemon-status --device emulator-5554
```

---

### `device-pool`

Manage a shared pool of devices for concurrent multi-agent use. Pool state is stored in `~/.conductor/device-pool.json` with file-based locking so multiple agents can safely acquire/release devices without colliding.

```bash
conductor device-pool --list               # list all devices and their pool status
conductor device-pool --acquire            # claim a free device; prints its ID
conductor device-pool --release <id>       # release a device back to the pool
```

Typical multi-agent workflow:
```bash
# Each agent acquires its own device before starting
DEVICE=$(conductor device-pool --acquire)
conductor launch-app com.example.myapp --device "$DEVICE"
# ... run tests ...
conductor device-pool --release "$DEVICE"
```

Stale acquisitions (whose process is no longer running) are automatically pruned on the next `--acquire`.

---

### `run-parallel`

Distribute a directory of Maestro YAML flow files across all booted devices, running them in parallel. Flows are assigned round-robin; results are aggregated and printed at the end.

```bash
conductor run-parallel --flows-dir ./tests
```

Exits with code 0 if all flows pass, 1 if any fail.

---

## Typical Agent Workflow

**Prefer individual CLI commands over `run-flow` / `run-flow-inline`.** Use `tap`, `type`, `scroll`, `swipe`, `assert-visible`, etc. directly — they are faster, give immediate feedback per step, and make failures easier to diagnose. Only reach for `run-flow` or `run-flow-inline` when you need Maestro-specific YAML features (conditional logic, `runScript`, retryTapIfNoChange`, etc.) that have no CLI equivalent.

**Always `launch-app` before interacting.** Never attempt to `tap`, `type`, `scroll`, or navigate before the app is launched and the session is set. `launch-app` both opens the app and saves the `appId`/`deviceId` to the session so all subsequent commands know which device and app to target.

**To understand what is on screen, run `inspect` first** — it gives you element text, IDs, and structure. Only take a `screenshot` when you need visual evidence or are debugging a rendering issue.

**Try obvious text labels and IDs first. Only run `inspect` when a `tap` or `assert-visible` fails and you need to discover the exact identifier.**

Single-agent (default session, no flag needed):
```bash
# 1. Check what devices are available
conductor list-devices

# 2. Launch the app — ALWAYS do this first (sets session, opens app)
conductor launch-app com.example.myapp --device emulator-5554

# 3. Interact using the most likely text labels or IDs
conductor tap "Sign In"           # try the obvious label first
conductor tap "username_field"    # or a guessed test ID
conductor type "user@example.com"
conductor tap "password_field"
conductor type "secret123"
conductor tap "Login"

# → If a tap fails, run inspect to find the real identifier:
conductor inspect
# → hierarchy shows text="Log in", id="btn_login" — retry with correct value
conductor tap "Log in"

# 4. Assert — try expected text directly
conductor assert-visible "Dashboard"

# 5. Inspect to understand what is on screen (prefer over screenshot)
conductor inspect

# 6. Screenshot only for visual evidence or rendering checks
conductor screenshot --output /tmp/tester-ios-iphone-16/post-login.png

# 7. Run a full flow only when CLI commands aren't sufficient
#    Write the YAML to /tmp/<agent-name>/ first — never pass YAML inline, it doesn't work
mkdir -p /tmp/tester-ios-iphone-16
cat > /tmp/tester-ios-iphone-16/checkout.yaml << 'EOF'
appId: com.example.myapp
---
- tapOn: "Checkout"
- assertVisible: "Order confirmed"
EOF
conductor run-flow /tmp/tester-ios-iphone-16/checkout.yaml
```

---

## Session State

Each session is stored in `~/.conductor/sessions/<name>.json`:

```json
{
  "appId": "com.example.myapp",
  "deviceId": "emulator-5554"
}
```

- Set automatically by `launch-app`
- Cleared by `session --clear`
- Used by all interaction commands when `--device` is not specified

---

## Multi-Agent Parallel Testing

Pass `--device <id>` on every command. The device ID is the natural key — each device gets its own session file and its own daemon process (with a persistent direct driver connection). Two agents targeting different devices never share state or a daemon.

### Device assignment — do this first, before spawning agents

**CRITICAL: each device must be assigned to exactly one agent. Never give two agents the same device.**

Before spawning any agents, check how many devices are already booted with `list-devices`. If there are not enough for the number of agents you need, boot more with `start-device` — one call per additional device needed. Only then assign and spawn agents.

```bash
# 1. Check what's already booted
conductor list-devices
# ios   booted  C59D3241-...  iPhone 16
# (only 1 device, but we need 2)

# 2. Boot another if needed
conductor start-device --platform ios

# 3. Re-check to get the new device's ID
conductor list-devices
# ios   booted  C59D3241-...  iPhone 16
# ios   booted  86B1BC33-...  iPhone 15
```

Assign explicitly — one device per agent, no sharing.

```bash
conductor list-devices
# ios   booted  C59D3241-FB6A-4E3B-AE7B-A82D3C933889  iPhone 16
# ios   booted  86B1BC33-7D83-47FF-AAFE-1BD70FC53038  iPhone 15
# android  device  emulator-5554  Pixel_6_API_33
```

Assign explicitly — one device per agent, no sharing:
```
Agent tester-ios-iphone-16  → --device C59D3241-FB6A-4E3B-AE7B-A82D3C933889
Agent tester-ios-iphone-15  → --device 86B1BC33-7D83-47FF-AAFE-1BD70FC53038
Agent tester-android-pixel-6 → --device emulator-5554
```

### Agent naming

Name each agent after the platform under test and the device it controls: `tester-${platform}-${device_name}` (lowercased, spaces replaced with hyphens). The platform prefix reflects what is being tested — it is not always `ios`. Examples:
- `tester-ios-iphone-16` — testing an iOS app on an iPhone 16 simulator
- `tester-android-pixel-6` — testing an Android app on a Pixel 6 emulator
- `tester-web-iphone-15` — testing a mobile web app on an iPhone 15 simulator
- `tester-payments-pixel-7` — testing a payments flow on a Pixel 7 emulator

This makes it immediately obvious which agent controls which device and prevents accidental reassignment.

### Setup — one `launch-app` per device

```bash
# Agent tester-ios-iphone-16
conductor launch-app com.example.myapp --device C59D3241-FB6A-4E3B-AE7B-A82D3C933889

# Agent tester-android-pixel-6
conductor launch-app com.example.myapp --device emulator-5554
```

**Every subsequent command carries `--device`:**
```bash
# Agent tester-ios-iphone-16
conductor tap "Sign In"     --device C59D3241-FB6A-4E3B-AE7B-A82D3C933889
conductor type "user@a.com" --device C59D3241-FB6A-4E3B-AE7B-A82D3C933889
conductor inspect           --device C59D3241-FB6A-4E3B-AE7B-A82D3C933889

# Agent tester-android-pixel-6 (runs fully in parallel)
conductor tap "Sign In"     --device emulator-5554
conductor type "user@b.com" --device emulator-5554
conductor inspect           --device emulator-5554
```

**Inspect all device sessions:**
```bash
conductor session --list
# Sessions:
#   C59D3241-...   appId=com.example.myapp  deviceId=C59D3241-...
#   emulator-5554  appId=com.example.myapp  deviceId=emulator-5554
```

**Rules for multi-agent use:**
- Run `list-devices` first and assign devices before spawning agents — never let agents pick their own
- Each agent owns exactly one device; no two agents share a device
- Name agents `tester-ios-${device_name}` / `tester-android-${device_name}` so ownership is obvious
- Always pass `--device` on every command — this is how agents stay isolated
- Each device gets its own daemon (`~/.conductor/daemons/<deviceId>/`), keeping the driver process alive for the lifetime of the daemon
- Screenshot paths must be unique per device; use the device name in the path

---

## Output Modes

Output is human-readable by default:
```
✓ tap "Submit" — done
✗ assert-visible "Welcome" — element not found
```

Use `--json` only when you need structured output for parsing:
```json
{"status": "ok", "message": "tap \"Submit\" — done"}
{"status": "error", "message": "assert-visible \"Welcome\" — element not found"}
```

---

### `start-device`

Boot an iOS simulator or Android emulator. Creates the Simulator window and waits until the device is fully ready.

```bash
conductor start-device --platform ios
conductor start-device --platform android
conductor start-device --platform ios --os-version 18
conductor start-device --platform ios --device-type "iPhone 16 Pro"
conductor start-device --platform ios --name "Test Device"
conductor start-device --platform android --avd Pixel_6_API_33
```

Flags:
- `--platform <ios|android>` — required
- `--os-version <n>` — filter by OS version (iOS: e.g. `18`; Android: API level e.g. `33`)
- `--avd <name>` — Android AVD name to launch (default: first available AVD)
- `--name <name>` — set a custom name on the simulator after boot (iOS only)
- `--device-type <name>` — iOS device type to boot (e.g. `"iPhone 16 Pro"`); if no existing simulator matches, one is created automatically

iOS picks the first available iPhone simulator matching the OS version and device type filters (or any if unfiltered). Android launches the named AVD, or the first AVD found.

---

## Related Documentation

- [Conductor Flow Syntax](./references/flow-syntax.md)

