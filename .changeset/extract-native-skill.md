---
'@houwert/conductor': patch
---

Split the native in-process instrument out of the `conductor-inspect` skill into
a new `conductor-native` skill. `conductor-inspect` now covers only external
observation (accessibility snapshots, screenshots, `@eN` refs) and assertions;
`conductor-native` owns the `--inject` + `native-*` commands for native
inspection **and** live editing (set view properties, force appearance/RTL, run
Swift). Cross-references in `conductor-device-setup` and `conductor-metro-debugger`
updated. Consumers get the new skill (and pruning of the moved content) on the
next `conductor init --force`.
