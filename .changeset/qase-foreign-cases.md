---
"conductor-studio": patch
---

Keep mirrored and hand-written cases in separate stores, and put the repo first on disk. A sub-project's cases now live under `~/.conductor/studio/<repo>/<store>/<sub-project>/<local|qase>/`, so everything Studio keeps about a checkout sits in one directory, and switching a sub-project between local and Qase no longer buries what it was authoring. Reports moved to the same layout; existing directories are moved on first read.

This also settles a destructive sync: pointing a datasource at a different Qase project used to make the next sync mark every case already in the store as "no longer in Qase" — they were never missing, they belonged to the project you switched away from. Cases another Qase project put in the store are now skipped by both the matrix and the sync, and reported as left alone rather than deprecated.
