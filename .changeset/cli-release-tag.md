---
"@houwert/conductor": patch
---

Tag CLI releases `cli-v<version>` instead of `v<version>`, so the conductor
repo's release list stays legible now that Conductor Studio publishes
`studio-v<version>` releases alongside them.

The driver bootstrap downloads `drivers.tar.gz` from its own release tag, so it
moves in lockstep — a release builds that file and cuts its tag from the same
commit. Already-published versions are unaffected: they keep fetching the
unprefixed tags, which stay where they are.
