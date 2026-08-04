---
"@houwert/conductor": minor
---

Add a streaming device-input server so conductor owns interaction injection. A
persistent per-device WebSocket (loopback, one per daemon) accepts normalized
pointer/key/text/button/scroll/tvremote frames and injects them via the existing
iOS XCUITest and Android gRPC drivers — conductor owns coord→device translation
and keymaps. `conductor input-server` starts it (if needed) and prints the
WebSocket URL; the daemon `/status` reports `inputPort`.

Live open-ended drags are buffered `down → move… → up` and replayed as one
gesture on `up` (XCUITest's `_XCT_synthesizeEvent` is atomic and can't hold a
touch across frames); consecutive moves coalesce so a fast drag never backs up
the injector, and phase transitions are never dropped. Multitouch, hardware
buttons, keyboard, and the tvOS remote route straight to the driver, and iOS
input reaches SpringBoard with no app attached.

New optional package `packages/ios-hid` ports the CoreSimulator/IndigoHID
touch-continuity path (host-side) as a held-touch backend for live drags with
mid-gesture animation; enabled with `CONDUCTOR_IOS_HID=1` when built, otherwise
the buffered path is used.
