---
"@houwert/conductor": minor
---

Add in-process native inspection for iOS and tvOS simulators. `launch-app --inject`
injects a dylib into the target app via `DYLD_INSERT_LIBRARIES`, then `native-inspect`
returns the real UIView/CALayer tree (resolved component colors, fonts, text, corner
radii, borders, shadows, gradients) and `native-nav` returns the view-controller
hierarchy (navigation stacks, tab selection, presented controllers). `native-screenshot`
renders the key window to PNG and `native-image <x,y,w,h>` extracts any component as a
PNG by its window-absolute frame (`absFrame`, included on every inspect node) — works for
UIKit, React Native Fabric, and custom renderers. `native-ping` checks the injected server
is alive.

Reveal-style runtime inspection is also included: every inspect node has a stable `id`, and
`native-view <id>` returns full property detail, `native-set <id> <key> <value>` live-edits a
view (alpha, colors, cornerRadius, frame, text, …) on the running app, `native-constraints`
dumps Auto Layout + ambiguity, `native-hittest <x,y>` selects the view at a point, `native-find`
searches by class/text, and `native-highlight` flashes an overlay on the device.
`native-snapshot <id>` renders a single view's own content in isolation (subviews hidden,
transparent elsewhere) — the per-layer texture for a 3D exploded-view inspector — and each
inspect node carries `depth`/`z`/`transform3D`/`maskedCorners`/`rn` for stacking planes.

Also adds runtime + diagnostics inspection: arbitrary KVC get/set, class metadata
(properties/ivars/methods), responder chain, gesture and target-action dumps, appearance
toggles (dark/light, RTL, Dynamic Type, animation freeze), SwiftUI tree, UserDefaults /
Keychain / cookies / sandbox files, a live-object heap browser (malloc-zone scan), and
stdout/stderr + HTTP capture. Exposed via `native-raw <path>` plus wrappers
`native-console`, `native-network`, `native-heap`, `native-appearance`, and a batch
`/snapshots` endpoint that returns every layer texture in one call. `native-eval` is the
escape hatch — it compiles arbitrary Swift to a dylib and runs it inside the app (full
UIKit / ObjC-runtime access) for anything no fixed endpoint covers.

This reaches native detail the external XCUITest driver can't see. New native package
`packages/ios-inproc`.
