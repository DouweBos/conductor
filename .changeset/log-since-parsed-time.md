---
'@houwert/conductor': patch
---

Fix device log streaming never returning entries. The daemon's `since` filter
compared timestamps as strings, so an ISO-UTC `since` never matched simctl's
`2026-10-04 20:58:54.12+0200` entries. It now compares parsed times, falling
back to string order only when a timestamp can't be parsed.
