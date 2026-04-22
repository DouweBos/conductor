---
"@houwert/conductor": minor
---

Add `memory` command for debugging memory pressure: reports system memory totals, per-app PSS/RSS/heap/code/stack/graphics breakdown, and object counts (Views, Activities, Binders, etc.). Uses `dumpsys meminfo` on Android and `vm_stat` + `vmmap` on iOS simulators.
