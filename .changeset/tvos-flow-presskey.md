---
"@houwert/conductor": patch
---

Fix `pressKey` in flows on tvOS. `conductor press-key "Remote Dpad Up"` routed
remote keys to `pressButton`, but the flow runner didn't — a `pressKey` step
fell through to the software-keyboard path, which tvOS doesn't have, so the step
silently did nothing. Remote keys now reach `pressButton` on tvOS, `Enter` maps
to Select, `Escape`/`Back` to Menu, and a key tvOS has no button for now fails
loudly instead of no-opping.
