---
"conductor-studio": minor
---

Add ⇧⌘F for search across every flow, and jump to the matching line.

The sidebar could already search all flows, but only if you found the field, and
clicking a hit opened the file at the top — you were told `login.yaml:47` and
then had to scroll to 47 yourself. ⇧⌘F now focuses the field from anywhere in
the workbench, Escape clears it, and picking a hit opens the file and selects
that line.

The result list also says how many matched, and says so explicitly when it
stopped at the 200-hit cap rather than looking like that was all of them.
