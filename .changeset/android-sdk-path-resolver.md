---
"@houwert/conductor": patch
---

Fix `list-devices` and `start-device` missing Android AVDs when the SDK isn't on PATH. Conductor now resolves `emulator`, `adb`, `avdmanager`, and `sdkmanager` from `ANDROID_HOME`/`ANDROID_SDK_ROOT` and the OS-default install locations (e.g. `~/Library/Android/sdk`), and surfaces a warning when `emulator -list-avds` fails so the failure isn't silent.
