---
'@houwert/conductor': minor
---

`launch-app` now fails when the app is already running instead of silently killing and relaunching it. Pass `--restart` to relaunch deliberately (`--clear-state`, `--clear-keychain` and `--no-stop-app` also skip the check).
