---
'@houwert/conductor': patch
---

Fix `start-device --platform android` OOM-killing heavy React Native debug
builds on auto-created AVDs. Stock TV device profiles (`tv_1080p`, `tv_4k`,
`tv_720p`) default to 1024MB RAM, so Android's `lowmemorykiller` SIGKILLs the app
during JS bundle load. After creating an AVD, conductor now raises its
`config.ini` `hw.ramSize`/`vm.heapSize` to a 4096/512MB floor (written as plain
integers — an `M` suffix makes the emulator silently fall back to 1024MB). Only
ever raises, so higher existing values are kept, and only at creation time —
never an AVD the user already had. A new `--memory <mb>` flag overrides the
floor.
