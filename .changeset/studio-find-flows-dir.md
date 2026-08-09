---
"conductor-studio": patch
---

Find the flows directory anywhere in the repo, not just at its root. Studio now
searches four levels deep for a `.maestro`/`maestro` folder that actually holds
flows, so a monorepo keeping them per-app (`apps/plex/.maestro`) no longer reads
as "No flows yet". The sidebar names the directory it's showing, and offers a
picker when the repo has more than one.
