---
"conductor-studio": minor
---

A case step can name several page objects, not one. Steps regularly bundle
actions ("open the details page and press play"), so the step panel now takes a
list — each with its own `env` — and a scaffold emits a `runFlow` per entry, in
order. A step counts as automated only when the flow reaches all of them.
Existing single assignments in `automation/step-poms.json` are read as a
one-entry list, so nothing needs migrating by hand.
