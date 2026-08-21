---
"@houwert/conductor": patch
"conductor-studio": minor
---

Flow runs now reserve their device too, not just agent sessions — a run sharing a
device with another agent tests whatever that agent left on screen. Claims are
counted, so an agent and a run on the same device share one claim and the device
is only released when the last of them finishes. `device-pool --acquire` is also
re-entrant: re-claiming a device you already hold succeeds instead of reporting a
conflict with yourself.
