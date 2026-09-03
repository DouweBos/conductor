---
'@houwert/conductor': patch
---

Fix physical device regressions found on real hardware

- Bonjour hostnames dropped apostrophes rather than dashing them, so a device
  named "Douwe's iPhone" was unreachable. Candidates now also reuse devicectl's
  own sanitized hostnames, re-pointed from `.coredevice.local` to `.local`.
- Any tap on a physical iPhone killed the driver: a device lying flat reports
  `.faceUp`, which simulators never do and the coordinate mapping had no case
  for, so it hit a `fatalError`. Flat orientations now map to portrait, and an
  unmapped orientation logs and passes the point through instead of crashing.
- Retry the driver build once. The first build for a team creates provisioning
  profiles as a side effect and Xcode often references one before it lands.
- Surface xcodebuild's actual errors instead of just an exit code.
