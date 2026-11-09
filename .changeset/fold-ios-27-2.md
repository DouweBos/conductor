---
'@houwert/conductor': patch
---

Fix `set-fold` and `get-fold` on the iOS 27.2 iPhone Duo runtime. locationd renamed the hinge relay's start method, so the fold controller never captured it, and Xcode 27.2's `devicectl` no longer has `device motion hinge-angle`, so nothing could read the angle. The controller now hooks both method names and publishes the relay's live angle for `get-fold` to read. `set-fold` waits until the hinge reaches the requested angle and fails if it doesn't.
