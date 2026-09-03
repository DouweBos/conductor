---
name: conductor-device-interact
description: Drive a running iOS simulator, Android emulator, tvOS simulator, Vega (Amazon Fire TV) virtual device, Roku device, or Playwright web app with the conductor CLI. Use when launching apps, tapping UI elements (by selector or raw coordinate), typing text, scrolling/swiping, performing gestures, pressing hardware/keyboard/remote keys, opening URLs or deep links, navigating back, granting/denying app permissions, adding media to the gallery, setting GPS location or a travel route, toggling airplane mode, recording a screen video, or verifying an app change in the real running app.
---

# Conductor — device interaction

`conductor` drives a real running app the way a user would: launch it, tap,
type, scroll, and assert. It bundles its own native drivers — no second CLI to
install. Use it to verify a change in the actual app, not just in tests.

To **observe** the screen (inspect the hierarchy, screenshot, read element
state), use the `conductor-inspect` skill — it pairs with this one.

## The core loop: act → observe → act

Never tap blind, never assume the result. After every action, observe before
the next one.

1. **Observe** with `conductor capture-ui` (see `conductor-inspect`) to see the
   screen and get short element refs (`@e1`, `@e2`, …).
2. **Act** — `tap-on`, `input-text`, `scroll`, etc.
3. **Confirm** with `assert-visible` / another `capture-ui`.

```bash
conductor launch-app com.example.myapp
conductor capture-ui            # observe; get @eN refs
conductor tap-on "Sign In"      # or: conductor tap-on @e3
conductor input-text "user@example.com"
conductor assert-visible "Dashboard"
```

## Interaction commands

| Command | Purpose |
|---|---|
| `conductor launch-app <appId>` | Launch app (saved to session). `--no-stop-app` resumes; `--argument key=value` passes launch args |
| `conductor stop-app [<appId>]` | Stop the app |
| `conductor tap-on <element>` | Tap by text, id, or `@eN`. `--long-press`, `--double-tap`, `--optional`, `--index <n>`, `--repeat <n> --delay <ms>` |
| `conductor tap-on --at <x,y>` | Tap a raw coordinate (px `100,200`, percent `50%,50%`, or `0-1` fraction) — no element match |
| `conductor copy-text-from <element>` | Print an element's text (and copy to the iOS clipboard) |
| `conductor input-text <text>` | Type into the focused field |
| `conductor erase-text [n]` | Erase n characters (default 50) |
| `conductor press-key <key>` | Press a key (Enter, Backspace, Home, …) or a remote button (`Remote Dpad Up/Down/Left/Right/Center`, `Remote Menu`, `Remote Page Up/Down` on tvOS and Android TV, and `Remote Guide` on tvOS) for tvOS / Android TV / vega / roku. `--long-press` / `--duration <seconds>` holds it; `--measure` times the response (see `conductor-profiler`) |
| `conductor hide-keyboard` | Dismiss the on-screen keyboard |
| `conductor back` | Press back |
| `conductor scroll [--direction down\|up\|left\|right]` | Scroll |
| `conductor scroll-until-visible <element> [--direction] [--timeout ms]` | Scroll until element appears |
| `conductor swipe --direction <dir>` / `--start <x,y> --end <x,y> [--duration ms]` | Swipe |
| `conductor open-link <url>` | Open a URL / deep link |
| `conductor pinch [--scale N] [--center x,y]` | Two-finger pinch (scale<1 out, >1 in) |
| `conductor rotate-gesture [--degrees N] [--center x,y]` | Two-finger rotate |
| `conductor gesture <json\|--file path>` | Play a multi-touch path |
| `conductor set-permissions <perm=value>...` | Grant/deny app permissions (`camera=allow photos=deny`, `all=allow`) |
| `conductor add-media <path>...` | Push image/video files into the device gallery |
| `conductor set-airplane-mode <on\|off>` / `toggle-airplane-mode` | Airplane mode (Android only) |
| `conductor travel <lat,lng>... [--speed <m/s>]` | Move GPS through a route of coordinates |
| `conductor record-video start [--out <path>]` / `record-video stop` | Record a screen **video** (iOS/Android). Distinct from `flow record` (which records a YAML flow) |
| `conductor clipboard read` / `clipboard write <text>` / `paste` | Clipboard (iOS) |
| `conductor list-options [command]` | List valid values for enumerated params |
| `conductor input-server` | Start (if needed) and print the streaming-input WebSocket URL for the device |
| `conductor stream-server` | Start (if needed) and print the live video-stream WebSocket URL for the device |

## Streaming input (host IDEs)

For continuous, low-latency input (live drags, fast typing) a host IDE can open
one persistent WebSocket per device instead of spawning a command per event.
`conductor input-server` ensures the daemon + driver are up and prints the
loopback URL (`ws://127.0.0.1:<port>/input`; also in `daemon-status --json` as
`inputPort`). The server sends a `hello` with per-platform capabilities, then
accepts normalized (0..1) frames: `pointer{id,phase,x,y}`, `key{code,mods,down}`,
`text{value}`, `button{name}`, `scroll{x,y,dx,dy}`, `tvremote{button}`. Conductor
owns coord→device translation and keymaps. For scripted, one-off actions use the
discrete commands above — this is for interactive host UIs.

## Streaming video (host IDEs / device viewers)

For live device mirroring, `conductor stream-server` ensures the daemon + capture
backend are up and prints the loopback URL
(`ws://127.0.0.1:<port>/stream?device=<id>&platform=<ios|tvos|android|web>`; also
in `daemon-status --json` as `streamPort`). One capture fans out to N subscribers.
On connect the server sends a JSON `config` frame
(`{t:"config",codec:"h264",width,height,rotation,fps,sps,pps,avcC,codecString}`),
then **binary** frames — each one H.264 Annex B access unit, keyframe-led; a late
joiner gets the cached config + a keyframe immediately. iOS/tvOS only for now
(host-side SimulatorKit → VideoToolbox capture); Android/web are follow-ons.
This is capture only — input stays on `input-server`. For a still image use
`screenshot` / `capture-ui`; this socket is for continuous low-latency mirroring.

## Discovering valid values

Several commands only accept a fixed set of values (`press-key <key>`,
`--direction`, `set-orientation`, `set-viewport --preset`/`--color-scheme`,
`logs --level`/`--source`, `--platform`). Don't guess — list them:

- `conductor <command> --options` — valid values for that command, e.g.
  `conductor press-key --options`, `conductor swipe --options`.
- `conductor list-options [command|param]` — same data; with no argument it
  lists every enumerated parameter, or filter by name (`list-options direction`).
- Add `--json` for machine-readable output.

## Selecting elements

Positional `<element>` matches **accessibility id first, then visible text**.
Disambiguate when multiple match:

- `--id <id>` / `--text <text>` — id-only / text-only matching
- `--index <n>` — nth match (0-based)
- `--below` / `--above` / `--left-of` / `--right-of <text>` — relative position
- `--focused`, `--enabled`, `--checked`, `--selected` — state filters
- `--timeout <ms>` — wait for the element to appear
- `--optional` — missing element is a no-op, not an error
- `@eN` — exact element from the **last `capture-ui`** (cached coords, ephemeral
  ~60s; re-capture after navigating)

If you can't find an element, run `conductor inspect` or `capture-ui` to see the
real ids and texts rather than guessing.

## ⚠️ Don't reset state to "fix" navigation

Never use `launch-app --clear-state`, `clear-state`, or `--clear-keychain` to
clear focus or navigation — they **wipe user data and sign the user out**, and
can't be undone without their credentials. Navigate out with `back` / Menu, or
relaunch without the flag. (See `conductor-device-setup`.)

## Tips

- `--device <id>` / `--device-name <name>` targets a device; `--platform <ios|android|tvos|web|vega|roku>` scopes by platform.
- Vega (Amazon Fire TV) is D-pad driven: navigate with `press-key "Remote Dpad …"`; coordinate `tap-on` also works. `open-link`, `set-location`, gestures, and clipboard are unsupported. See `conductor-device-setup`.
- Apple TV (tvOS) is focus-driven and has **no touch surface automation**: XCTest
  refuses remote swipe gestures ("Swipe events are only implemented for iOS,
  visionOS, and watchOS"), so `swipe`/`scroll` are unavailable. Navigate with
  `press-key "Remote Dpad Up/Down/Left/Right"` and `"Remote Dpad Center"`; for
  long lists use `press-key "Remote Page Up"` / `"Remote Page Down"` (tvOS 14.3+;
  also mapped on Android TV), which move a screenful at a time when the app
  honours them. `"Remote Guide"` (14.3+) and
  `"Remote TV Provider"` / `"Remote One Two Three"` / `"Remote Four Colors"`
  (18.1+) are also available. `--duration <seconds>` holds a button for
  accelerated scrolling.
- Roku is D-pad only — there is no touch. `tap-on <selector>` resolves the element but presses `Select`, which activates whatever currently holds **focus**, so navigate focus onto the target with `press-key "Remote Dpad …"` first and use `tap-on` to confirm. `scroll`/`swipe` become repeated D-pad presses in the direction the content moves. `open-link` needs an app id (it becomes a channel launch parameter). Only sideloaded dev-mode channels are inspectable. See `conductor-device-setup`.
- Add `--json` for machine-readable output; failed assertions exit non-zero.
- Run a per-session daemon for many commands (see `conductor-device-setup`).
- `conductor <command> --help` for exact flags.
