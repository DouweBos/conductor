---
name: conductor-device-interact
description: Drive a running iOS simulator, Android emulator, tvOS simulator, or Playwright web app with the conductor CLI. Use when launching apps, tapping UI elements, typing text, scrolling/swiping, performing gestures, pressing hardware/keyboard keys, opening URLs or deep links, navigating back, or verifying an app change in the real running app.
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
| `conductor tap-on <element>` | Tap by text, id, or `@eN`. `--long-press`, `--double-tap`, `--optional`, `--index <n>` |
| `conductor input-text <text>` | Type into the focused field |
| `conductor erase-text [n]` | Erase n characters (default 50) |
| `conductor press-key <key>` | Press a key (Enter, Backspace, Home, …) |
| `conductor hide-keyboard` | Dismiss the on-screen keyboard |
| `conductor back` | Press back |
| `conductor scroll [--direction down\|up\|left\|right]` | Scroll |
| `conductor scroll-until-visible <element> [--direction] [--timeout ms]` | Scroll until element appears |
| `conductor swipe --direction <dir>` / `--start <x,y> --end <x,y> [--duration ms]` | Swipe |
| `conductor open-link <url>` | Open a URL / deep link |
| `conductor pinch [--scale N] [--center x,y]` | Two-finger pinch (scale<1 out, >1 in) |
| `conductor rotate-gesture [--degrees N] [--center x,y]` | Two-finger rotate |
| `conductor gesture <json\|--file path>` | Play a multi-touch path |
| `conductor clipboard read` / `clipboard write <text>` / `paste` | Clipboard (iOS) |

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

- `--device <id>` / `--device-name <name>` targets a device; `--platform <ios|android|tvos|web>` scopes by platform.
- Add `--json` for machine-readable output; failed assertions exit non-zero.
- Run a per-session daemon for many commands (see `conductor-device-setup`).
- `conductor <command> --help` for exact flags.
