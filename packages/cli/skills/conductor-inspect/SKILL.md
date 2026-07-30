---
name: conductor-inspect
description: Read the live UI state of a running app with the conductor CLI — view hierarchy, accessibility snapshot, screenshots, focused element, and element refs. Use when you need to see what's on screen, find an element's id/text/coordinates, take a screenshot, check focus, or assert that something is (or isn't) visible before or after acting.
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

## Native in-process inspection (iOS/tvOS simulator)

The commands above observe the app **externally** (accessibility snapshots), so
they can't see real component colors, fonts, or the view-controller stack. When
you need that native detail, launch the app with an injected in-process library
and use the `native-*` commands. Requires `launch-app <appId> --inject` first
(iOS/tvOS simulator only).

| Command | Purpose |
|---|---|
| `conductor native-ping` | Verify the injected in-process control library is alive |
| `conductor native-inspect` | Real UIView/CALayer tree: resolved colors (`#RRGGBBAA`), fonts, text (incl. React Native Fabric), corner radius, borders, shadows, gradients, and each node's `absFrame` |
| `conductor native-nav` | Navigation state: `UINavigationController` stacks, tab selection, presented controllers, titles |
| `conductor native-screenshot --output <p.png>` | In-process PNG of the key window |
| `conductor native-image <x,y,w,h> --output <p.png>` | Extract a component as a PNG — pass a node's `absFrame` from `native-inspect` |
| `conductor native-snapshot <id> --output <p.png>` | Isolated PNG of one view's own content (transparent) — per-layer texture for a 3D explosion; `--with-subviews` composites the subtree |
| `conductor native-console [--since <n>]` / `native-network [--since <n>]` | App stdout/stderr + captured HTTP; poll with the returned `cursor` |
| `conductor native-heap --pattern <s> \| --class <name> \| --read <addr> [--key <keyPath>]` | Live-object browser (find classes/instances, read a property off an address) |
| `conductor native-appearance <light\|dark\|system> \| --direction <ltr\|rtl> \| --anim-speed <n>` | Force appearance / RTL / freeze animations app-wide |
| `conductor native-eval '<swift>'` | Compile & run arbitrary Swift inside the app (full UIKit / ObjC-runtime access); `--mode full` for a whole function body. e.g. `native-eval 'UIScreen.main.bounds'` |
| `conductor native-raw <path>` | Escape hatch — GET any in-process endpoint (e.g. `'/get?id=..&keyPath=layer.cornerRadius'`, `'/class?id=..'`, `'/responders?id=..'`, `'/swiftui'`, `'/defaults'`, `'/focus'`, `'/snapshots?scale=0.5'`). Full list in `packages/ios-inproc/README.md`. |
| `conductor native-view <id>` | Full property detail for one view (class chain, transform, layer, gestures, text/font) |
| `conductor native-set <id> <key> <value>` | **Live-edit** a property: alpha, hidden, backgroundColor, tintColor, cornerRadius, borderWidth, borderColor, frame, text |
| `conductor native-constraints <id>` | Auto Layout constraints affecting a view + ambiguity |
| `conductor native-hittest <x,y>` | Topmost view at a point + ancestor chain (select-by-point) |
| `conductor native-highlight <id>` | Flash a highlight over the view on the device |
| `conductor native-find [--class <name>] [--text <s>]` | Search views by class and/or text |

Every `native-inspect` node has a stable `id` (for this launch). The Reveal-style loop:
inspect → pick an `id` → `native-view` for detail → `native-set` to edit live → see it
on the device. IDs are pointer-based and reset each launch, so re-inspect after relaunch.

```bash
conductor launch-app com.example.app --inject
conductor native-inspect                              # tree with ids, colors, fonts, absFrame
conductor native-view 0x10280d0c0                     # full detail for a view
conductor native-set 0x10280d0c0 backgroundColor '#FF3B30FF'   # live-edit, visible on device
conductor native-image 816,286,288,288 --output /tmp/avatar.png
```

## Assertions

| Command | Purpose |
|---|---|
| `conductor assert-visible <element> [--timeout ms]` | Assert element is visible (non-zero exit on failure) |
| `conductor assert-not-visible <element> [--timeout ms]` | Assert element is absent |

Both take the same selectors as `tap-on`: `--id`, `--text`, `--index`,
`--below` / `--above` / `--left-of` / `--right-of`, `--focused`, `--enabled`,
`--checked`, `--selected`, `--optional`.

## Tips

- Add `--json` to parse output programmatically (pipe through `jq`).
- When an interaction can't find an element, `inspect` / `capture-ui` shows the
  real ids and texts on screen — don't guess selectors.
- `conductor <command> --help` for exact flags.
