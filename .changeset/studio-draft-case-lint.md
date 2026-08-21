---
"conductor-studio": patch
---

Stop reporting a draft case's unwritten flow as an error.

A matrix is imported ahead of the flows, so most cases name a flow nobody has
written yet — which the project check reported as an error per reference, one
or two per case. That buried the problems worth acting on under a list of
planned work.

A case tagged `status: draft` now reports its missing flow as info, worded as
what it is: not written yet. A case that doesn't claim to be a draft still
errors, since that one really is pointing at nothing.
