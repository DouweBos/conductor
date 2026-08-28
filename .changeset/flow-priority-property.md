---
"conductor-studio": patch
---

Carry a case's priority into the flows that verify it. Linking and scaffolding
now write Maestro's `priority` property beside `testCaseId`, in Qase's own
ranking (`High`, `Medium`, `Low`), so a report can rank a failure the way Qase
does. Unlinking leaves it — a priority set by hand is not Studio's to delete.
