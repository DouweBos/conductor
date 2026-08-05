---
name: conductor-inspect
description: Read the live UI state of a running app with the conductor CLI — view hierarchy, accessibility snapshot, screenshots, focused element, and element refs. Use when you need to see what's on screen, find an element's id/text/coordinates, take a screenshot, check focus, assert that something is (or isn't) visible, assert a JavaScript expression, or do visual-regression screenshot comparison before or after acting.
---

# Conductor — inspection & assertions

These commands let you **observe** a running app's screen so you know what to do
next. Pair them with `conductor-device-interact`, which acts on what you find
here. Always observe before you act, and confirm after.

## Observe the screen

| Command | Purpose |
|---|---|
| `conductor capture-ui [--output <path.json>]` | Screenshot + hierarchy + a11y snapshot in one JSON bundle; assigns short `@eN` refs. **Preferred way to observe.** |
| `conductor inspect [--dump]` | Print the UI hierarchy (`--dump` = raw driver output) |
| `conductor inspect --at <x,y> [--tappable]` | Topmost view at a screen point |
| `conductor focused [--poll [ms]]` | Metadata of the focused element. `--poll` watches changes — only with a bounded use, then stop it |
| `conductor take-screenshot [<element>] [--output <path>] [--full-page]` | Screenshot; crop to a matched element; `--full-page` (web) |

`capture-ui` is the workhorse: it returns the screen as structured data **and**
gives each element a ref like `@e3` that `conductor tap-on @e3` taps by cached
coordinates. Refs are ephemeral (~60s) — re-capture after navigating or waiting.

```bash
conductor capture-ui --output /tmp/screen.json
# read it: element texts, ids, frames, and @eN refs
conductor tap-on @e5
```

## Native internals (colors, fonts, layers, live-edit)

The commands above observe the app **externally** (accessibility snapshots), so
they can't see real component colors, fonts, or the view-controller stack. For
that native detail — or to live-edit a running app's view properties, force
appearance/RTL, or run Swift in-process — use the **`conductor-native`** skill
(`launch-app --inject` + the `native-*` commands; iOS/tvOS simulator, dev builds).

## Assertions

| Command | Purpose |
|---|---|
| `conductor assert-visible <element> [--timeout ms]` | Assert element is visible (non-zero exit on failure) |
| `conductor assert-not-visible <element> [--timeout ms]` | Assert element is absent |
| `conductor assert-true <expr> [--env K=V]` | Assert a JavaScript expression is truthy (no device needed) |
| `conductor assert-screenshot <reference.png> [--threshold <0-1>] [--update]` | Visual regression vs a baseline image; `--update` (re)writes the baseline. Writes `<ref>.diff.png` on mismatch |

Both take the same selectors as `tap-on`: `--id`, `--text`, `--index`,
`--below` / `--above` / `--left-of` / `--right-of`, `--focused`, `--enabled`,
`--checked`, `--selected`, `--optional`.

## Tips

- Add `--json` to parse output programmatically (pipe through `jq`).
- When an interaction can't find an element, `inspect` / `capture-ui` shows the
  real ids and texts on screen — don't guess selectors.
- `conductor <command> --help` for exact flags.
