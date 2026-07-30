# ios-inproc — injected in-process control library

A dynamic library that conductor injects into a running **iOS or tvOS Simulator**
app via `DYLD_INSERT_LIBRARIES`, giving a second inspection plane that runs
*inside* the target app process. This reaches native detail the external XCUITest
driver (`packages/ios-driver`) cannot: resolved component colors/fonts, the real
navigation stack, and the full UIView/CALayer tree.

Built for both platforms (`--all` → `ios-inproc/` + `tvos-inproc/`); the same
Swift source compiles against each simulator SDK.

## How injection works

1. `tools/build-inproc-dylib.sh` compiles `Conductor/` into
   `packages/cli/drivers/ios-inproc/Conductor.framework/Conductor` (arm64 sim,
   ad-hoc signed — **required**: iOS 26.3+ simulators silently refuse a
   `DYLD_INSERT` dylib carrying only a linker signature).
2. `conductor launch-app <appId> --inject` launches the app with
   `SIMCTL_CHILD_DYLD_INSERT_LIBRARIES` pointing at the framework and
   `SIMCTL_CHILD_CONDUCTOR_INPROC_PORT` set to a per-device loopback port.
   (`launchctl setenv` can't be used — dyld strips restricted `DYLD_*` vars set
   that way; `simctl` forwards `SIMCTL_CHILD_*` into the app's real env at exec.)
3. `bootstrap.c`'s constructor fires before `main()` → `ConductorBootstrap()` →
   the control server starts on `didFinishLaunching` and binds the given port.
4. The CLI reaches `127.0.0.1:<port>` (simulator apps share the host loopback,
   same as the XCUITest driver on :1075). `conductor native-ping` checks it.

## Endpoints (HTTP/JSON)

| Route | CLI command | Returns |
|---|---|---|
| `GET /ping` | `native-ping` | pid, bundle id, process name |
| `GET /inspect` | `native-inspect` | full UIView/CALayer tree: class, frame, resolved colors (`#RRGGBBAA`), fonts, text, corner radius, borders, shadows, gradients. Text/color/font are read from UIKit controls **and** from `attributedText` on custom renderers, so React Native (Fabric `RCTParagraphComponentView`) text comes through. |
| `GET /nav` | `native-nav` | view-controller hierarchy: nav stacks, tab selection, presented, titles |
| `GET /screenshot` | `native-screenshot` | PNG render of the key window |
| `GET /image?frame=x,y,w,h` | `native-image` | PNG crop of a window-absolute rect (a node's `absFrame`); composites any renderer — UIImageView, RN Fabric, Chroma image views |
| `GET /snapshot?id=&subviews=false` | `native-snapshot` | isolated PNG of one view's **own content** (subviews hidden) — the per-layer texture for a 3D exploded view; `subviews=true` composites the whole subtree |
| `GET /view?id=` | `native-view` | full property detail for one view: class chain, frame/bounds/center, transform, layer, gestures, superview, text/font |
| `GET /set?id=&key=&value=` | `native-set` | **live-edit** a whitelisted property (alpha, hidden, backgroundColor, tintColor, cornerRadius, borderWidth, borderColor, frame, text) |
| `GET /constraints?id=` | `native-constraints` | Auto Layout constraints affecting a view + `hasAmbiguousLayout` |
| `GET /hittest?x=&y=` | `native-hittest` | topmost view at a point + ancestor chain (select-by-point) |
| `GET /highlight?id=` | `native-highlight` | flash a highlight overlay over the view on the device |
| `GET /find?class=&text=` | `native-find` | search views by class-name and/or text substring |

Every node from `/inspect` carries a stable `id` (this launch) — pass it to `/view`,
`/set`, `/constraints`, `/highlight`. This is the Reveal-style loop: inspect → select →
read detail → live-edit → see it on device. (IDs are pointer-based and reset each launch.)

### Runtime, appearance, diagnostics, state, heap

All exposed via `native-raw <path>` (and ergonomic wrappers where noted). `/inspect`
also gains `depth`, `z`, `transform3D`, `anchorPoint`, `maskedCorners`, `hasMask`, and
`rn` (React Native reactTag/nativeID/testID); pass `?hidden=true` to include hidden views.

| Endpoint | CLI | What |
|---|---|---|
| `/snapshots?scale=&max=` | `native-raw` | all layer textures (base64) + `order` in one call — the whole 3D scene |
| `/get?id=&keyPath=` | `native-raw` | read any KVC key path (ObjC exceptions caught) |
| `/class?id=` | `native-raw` | declared properties / ivars / methods of the view's class |
| `/responders?id=` | `native-raw` | responder chain + first responder |
| `/gestures?id=` | `native-raw` | gesture recognizers (state/enabled/config) |
| `/targetactions?id=` | `native-raw` | UIControl target→action wiring |
| `/appearance?style=` `/direction?direction=` `/contentsize?category=` `/animspeed?speed=` | `native-appearance` | force dark/light, RTL, Dynamic Type; freeze/scrub animations |
| `/swiftui` | `native-raw` | SwiftUI view tree (Mirror over `UIHostingController.rootView`) |
| `/defaults` (`?key=&value=` to set) · `/keychain` · `/cookies` · `/files?path=` | `native-raw` | app persisted state |
| `/heap/classes?pattern=` · `/heap/instances?class=` · `/heap/read?address=&keyPath=` | `native-heap` | live-object browser (malloc-zone scan) |
| `/console?since=` · `/network?since=` | `native-console` / `native-network` | stdout/stderr + captured HTTP; poll with the returned `cursor` |
| `/activate?id=` | `native-raw` | fire a control via accessibility activation |
| `/focus` | `native-raw` | tvOS/iOS focus-engine focused item per window |
| `/diff/save?name=` · `/diff/compare?name=` | `native-raw` | before/after screen diff (added/removed/changed ids) |
| `/eval?dylib=<path>` | `native-eval` | run arbitrary Swift: the CLI compiles your code to a dylib (`conductor_eval` entry), drops it in the app container, and this dlopen's + calls it on the main thread. Full UIKit / ObjC-runtime / framework access. |

Every `/inspect` node carries an `absFrame` (window-absolute rect) — feed it to
`native-image` to extract that exact component (e.g. a profile avatar) as a PNG.

## Building a 3D exploded-layer viewer

Everything a Reveal-style 3D explosion needs is here:

1. `native-inspect --json` → the tree. Each node carries `id`, `absFrame`
   (window x/y/w/h = the plane's position + size), `depth` (tree nesting = the
   primary Z axis), optional `z` (layer `zPosition` for sibling ordering), and
   `class`.
2. For each node, `native-snapshot <id>` → an isolated PNG of just that view's
   own content (transparent elsewhere) = the plane's texture. Because subviews
   are excluded, stacking the planes back-to-front along Z reconstructs the UI,
   and pulling them apart along Z gives the explosion.

So the render model per node is: a quad at `absFrame`, offset on Z by
`depth * spacing`, textured with its `snapshot`. Tap/pick a plane → you have its
`id` → `native-view` for the inspector panel and `native-set` to edit it live.
(`native-image --frame` differs: it composites *everything* drawn in a rect, so
it's for "grab what this looks like on screen", not per-layer textures.)

## Layout

```
Conductor/
  loader/bootstrap.c                     dyld constructor entry
  loader/ConductorLoader.swift           @_cdecl Swift entry; arms lifecycle hook
  server/ConductorControlServer.swift    NWListener HTTP/JSON control server
  bridge/IntrospectionBridge.swift       UIView/VC introspection (colors, fonts, nav)
  bridge/RuntimeBridge.swift             KVC get, class metadata, responders, gestures
  bridge/AppearanceBridge.swift          dark/light, RTL, Dynamic Type, animation freeze
  bridge/SwiftUIBridge.swift             SwiftUI tree via Mirror
  bridge/StorageBridge.swift             defaults / keychain / cookies / files
  bridge/HeapBridge.swift                live-object browser (over runtime/HeapScan.c)
  bridge/InteractionBridge.swift         activate, focus, screen diff
  bridge/EvalBridge.swift                dlopen + run compiled Swift (native-eval)
  diagnostics/ConsoleCapture.swift       stdout/stderr ring buffer (dup2)
  diagnostics/NetworkCapture.swift       URLProtocol HTTP capture
  runtime/ConductorObjC.[hm]             ObjC exception catcher (safe KVC/heap)
  runtime/HeapScan.[hc]                  malloc-zone instance scan + class enum
tools/build-inproc-dylib.sh              build + ad-hoc sign (iOS + tvOS; compiles Swift + C + ObjC)
```

## Extending

Add a route in `ConductorControlServer.route(_:)` and a reader in the relevant
bridge extension (marshal UIKit access to the main thread via `onMain`). Anything
not covered by a fixed endpoint is reachable via `native-eval` (compile + run
arbitrary Swift in-process). HID is intentionally omitted — the XCUITest driver
already synthesizes touches via `_XCT_synthesizeEvent:`.
