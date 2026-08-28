---
"conductor-studio": patch
---

Leaving the Cases screen and coming back reopens the case you had open. The
open case now lives in the URL (`#/cases/<id>`) rather than in component state,
and the nav rail returns each view to the route you last had there — so the
Flows tab you were editing comes back too.
