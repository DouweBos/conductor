---
"conductor-studio": minor
---

Sync test-case CI status from GitHub Actions via the `gh` CLI, and correct
Conductor Studio's CLI contracts against the live conductor: bootable devices now
appear in the picker, capture-ui frames read the `w`/`h` fields (element bounds
were zero-sized), the inspector rebuilds the real hierarchy from `nodeId`, taps
pass 0–1 fractions so they land on the right point, folder runs on the conductor
engine run each flow in sequence, and the step checklist tracks maestro's
`… COMPLETED/FAILED` and conductor's `→ … ok/FAILED` lines instead of guessing.
