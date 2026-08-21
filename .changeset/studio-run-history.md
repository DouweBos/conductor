---
"conductor-studio": minor
---

Keep run history, and show maestro's debug output for a failed run. Runs are
recorded per project with their status, timing and output tail; opening one
reads `~/.maestro/tests/<run>/` and lists every executed command with its
status, duration, the screenshot taken at that step and the screen hierarchy
captured with it — which is what actually explains a failure. Adds a repeat run
that runs a flow N times and reports the pass rate, for checking flakiness.
