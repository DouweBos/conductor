---
'@houwert/conductor': patch
---

Stop the iOS, tvOS and macOS XCTest drivers from recording the screen. The driver session never ends, so XCTest's automatic screen recording grew without limit inside the simulator's data folder (72 GB after about 31 hours on tvOS). Starting an iOS or tvOS simulator driver now also deletes recordings that earlier driver sessions left behind, skipping any file a process still has open.
