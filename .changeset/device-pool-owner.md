---
"@houwert/conductor": minor
"conductor-studio": minor
---

Let a long-running client hold a device reservation. `device-pool --acquire`
stamped the claim with the CLI's own PID, and conductor frees claims whose owner
has exited — so the reservation was gone the instant the command returned, and
nothing could actually reserve a device. It now takes `--owner <pid>` to hold the
claim for a process that sticks around, and `--device <id>` to claim a specific
device instead of any free one, failing if someone else holds it.

Conductor Studio uses this: an agent reserves its device for the length of the
session and releases it however the session ends, refuses to start on a device
another agent holds, and marks reserved devices in the picker.
