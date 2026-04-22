---
"@houwert/conductor": minor
---

Add `memory` command for debugging memory pressure across all platforms: reports system memory totals, per-app PSS/RSS/heap/code/stack/graphics breakdown, and object counts. Uses `dumpsys meminfo` on Android (Views, Activities, Binders, Parcels), `vm_stat` + `vmmap` on iOS simulators (region breakdown), and Playwright CDP `Performance.getMetrics` + `performance.memory` on web (Nodes, Documents, Frames, JSEventListeners, JS heap).
