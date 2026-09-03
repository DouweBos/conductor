---
"conductor-studio": patch
---

Status pills grow with their text instead of letting a long message spill out of
the background, and the dot stays on the first line. Unlinking a case from a
flow whose file is already gone is a quiet no-op — a missing flow declares
nothing — while linking one reports that the flow is missing rather than
surfacing a raw ENOENT.
