---
'@houwert/conductor': patch
---

The in-process control server injected by `launch-app --inject` now listens on loopback only, so other machines on the network can no longer reach it.
