---
"conductor-studio": patch
---

Scaffolding a flow from a case no longer writes broken YAML when a step's
action, data or expected result runs to several lines — every line is commented
now, not just the first. The "Wrote …" confirmation also stops rendering as an
error.
