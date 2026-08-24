---
"conductor-studio": patch
---

Stop reporting every synced case as updated. A pull counted a case as "updated" whenever a file for it already existed, so syncing twice in a row claimed it had rewritten everything. It now compares what Qase returned against what is on disk, writes only what actually differs, and reports the rest as unchanged — which also stops an identical sync churning every file's mtime.
