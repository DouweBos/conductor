---
name: conductor-native
description: Inspect and live-edit a running app's native internals with the conductor CLI's in-process instrument (iOS/tvOS simulator, requires launch-app --inject). Use when you need real native view details the accessibility tree can't show — resolved colors/fonts/layers, the UIViewController/navigation stack, Auto Layout constraints, live-object heap — or to tweak the running app in place: set a view's properties (color, text, frame), force dark/RTL/animation state, or run arbitrary Swift inside the process.
---

# Conductor — native in-process inspection & live editing

The external commands in `conductor-inspect` observe the app through the
**accessibility tree**, so they can't see real component colors, fonts, layers,
or the view-controller stack. When you need that native detail — or want to
tweak the running app in place — launch with an injected in-process library and
use the `native-*` commands.

Requires `launch-app <appId> --inject` first. **iOS/tvOS simulator, dev builds
only.** IDs are pointer-based and reset each launch, so re-inspect after relaunch.

## Inspect the native plane

| Command | Purpose |
|---|---|
| `conductor native-ping` | Verify the injected in-process control library is alive |
| `conductor native-inspect` | Real UIView/CALayer tree: resolved colors (`#RRGGBBAA`), fonts, text (incl. React Native Fabric), corner radius, borders, shadows, gradients, and each node's `absFrame` |
| `conductor native-nav` | Navigation state: `UINavigationController` stacks, tab selection, presented controllers, titles |
| `conductor native-view <id>` | Full property detail for one view (class chain, transform, layer, gestures, text/font) |
| `conductor native-props <id>` | React Native Fabric props: typed `ViewProps` + the raw JS prop bag (Fabric host views only) |
| `conductor native-constraints <id>` | Auto Layout constraints affecting a view + ambiguity |
| `conductor native-hittest <x,y>` | Topmost view at a point + ancestor chain (select-by-point) |
| `conductor native-find [--class <name>] [--text <s>]` | Search views by class and/or text |
| `conductor native-heap --pattern <s> \| --class <name> \| --read <addr> [--key <keyPath>]` | Live-object browser (find classes/instances, read a property off an address) |
| `conductor native-console [--since <n>]` / `native-network [--since <n>]` | App stdout/stderr + captured HTTP; poll with the returned `cursor` |
| `conductor native-screenshot --output <p.png>` | In-process PNG of the key window |
| `conductor native-image <x,y,w,h> --output <p.png>` | Extract a component as a PNG — pass a node's `absFrame` from `native-inspect` |
| `conductor native-snapshot <id> --output <p.png>` | Isolated PNG of one view's own content (transparent); `--with-subviews` composites the subtree |
| `conductor native-raw <path>` | Escape hatch — GET any in-process endpoint (e.g. `'/get?id=..&keyPath=layer.cornerRadius'`, `'/class?id=..'`, `'/responders?id=..'`, `'/swiftui'`, `'/defaults'`, `'/focus'`, `'/snapshots?scale=0.5'`). Full list in `packages/ios-inproc/README.md`. |

## Live-edit the running app

| Command | Purpose |
|---|---|
| `conductor native-set <id> <key> <value>` | **Live-edit** a property: alpha, hidden, backgroundColor, tintColor, cornerRadius, borderWidth, borderColor, frame, text, textColor. `text`/`textColor` work on RN Fabric text views too |
| `conductor native-highlight <id>` | Flash a highlight over the view on the device |
| `conductor native-appearance <light\|dark\|system> \| --direction <ltr\|rtl> \| --anim-speed <n>` | Force appearance / RTL / freeze animations app-wide |
| `conductor native-eval '<swift>'` | Compile & run arbitrary Swift inside the app (full UIKit / ObjC-runtime access); `--mode full` for a whole function body. e.g. `native-eval 'UIScreen.main.bounds'` |

> **Editing RN Fabric text/props:** the native plane can't set text on `RCTParagraphComponentView` (no native setter) and `native-props` returns `rawProps: null` on Fabric. Edit through React instead with `conductor native-rn-set --react-tag <n> --path children --value '"…"'` (and read raw JSX props with `native-rn-props --react-tag <n>`). `reactTag` comes from this tree's `rn.reactTag`. See the `conductor-metro-debugger` skill. Dev builds only.

## The Reveal-style loop

Every `native-inspect` node has a stable `id` (for this launch): inspect →
pick an `id` → `native-view` for detail → `native-set` to edit live → see it on
the device. Re-inspect after relaunch (IDs reset).

```bash
conductor launch-app com.example.app --inject
conductor native-inspect                              # tree with ids, colors, fonts, absFrame
conductor native-view 0x10280d0c0                     # full detail for a view
conductor native-set 0x10280d0c0 backgroundColor '#FF3B30FF'   # live-edit, visible on device
conductor native-image 816,286,288,288 --output /tmp/avatar.png
```

## Related

- `conductor-inspect` — external observation (a11y snapshots, screenshots, `@eN` refs) + assertions.
- `conductor-metro-debugger` — the React/JS plane: `native-rn-set` / `native-rn-props`, `debug evaluate`, component tree, logs, network.
