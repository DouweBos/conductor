---
'@houwert/conductor': minor
---

Read and change React app state over Metro, with nothing added to the app. `debug navigation` prints the focused React Navigation / expo-router route, its params and nested path (`--full` for the whole state), and `debug navigate` navigates through the app's container. `debug query-cache` lists the TanStack Query cache (status, observers, age), with `--key`, `--grep` to find a value, and `--path`/`--summary` to read the data. `debug store` reads Redux automatically, Zustand stores registered in `globalThis.__CONDUCTOR_STORES__`, and stores an app bridge exposes, and writes them with `--set`/`--dispatch`. `debug bridge list|call` calls methods on an app-provided bridge global (`--bridge`, default `__conductorBridge`). `debug watch` polls any of these, or a JS expression, and prints each change as a diff.

`network logs --follow` prints requests as they complete. `profile launch` measures cold or deep-link launches over `--runs`: on Android it reports `am start -W` times, `Displayed` and fully-drawn times from logcat, and on Android and iOS/tvOS simulators it turns app log marks (`--mark-regex`, `--until-mark`) into a phase table. Physical iPhones and Apple TVs now stream device logs through `idevicesyslog` when libimobiledevice is installed.
