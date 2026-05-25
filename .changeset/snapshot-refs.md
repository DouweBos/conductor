---
"@houwert/conductor": minor
---

Add ephemeral `@eN` element refs. `capture-ui` now assigns each accessible element a short ref (`@e1`, `@e2`, …) and persists its screen coordinates per session, so `tap-on @e3` can act on the captured point directly without re-querying or fuzzy text/id matching. Stale snapshots (different device or older than 60s) emit an advisory warning rather than hard-failing.
