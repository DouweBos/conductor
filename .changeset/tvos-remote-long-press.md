---
'@houwert/conductor': minor
---

Support long-pressing tvOS remote buttons via `press-key`. Add `--long-press`
(holds ~1.5s, matching `tap-on`) and `--duration <seconds>` for a custom hold
time — e.g. `conductor press-key "Remote Dpad Center" --long-press` to trigger
held-Select behaviors like icon-jiggle/edit mode on the Apple TV home screen.

Implemented by threading an optional duration through `pressButton` to the
tvOS driver's `XCUIRemote.shared.press(_:forDuration:)` overload. Only applies
to tvOS remote buttons; ignored elsewhere. (Requires a rebuilt tvOS driver to
take effect on-device.)
