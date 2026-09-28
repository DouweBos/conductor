---
'@houwert/conductor': patch
---

macOS: `profile cpu [<appId>]` records a Time Profiler trace with `xctrace`,
attached to the app's pid. Without an appId it profiles the app from
`launch-app`, or else the frontmost app.
