---
"@houwert/conductor": patch
---

Fix `device-pool --acquire` handing back a device the caller already holds when
asked for any free device. Re-claiming stays idempotent when the device is named
with `--device`, which is how Studio's reservations work, but an unqualified
acquire now only returns a genuinely free device — otherwise two parallel runs
by the same owner land on one screen.
