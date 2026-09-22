---
'@houwert/conductor': minor
---

Let `start-device` pick a device by name. `--device-name` was only ever a
selector for already-booted devices, so `conductor start-device --platform
android --device-name plex_tv_local` silently dropped the flag and booted the
first AVD in the list instead. It now selects on every platform: the AVD on
Android (`--avd` stays as an alias), the simulator name on iOS/tvOS, the serial
on Vega and the host on Roku. Paired with `--device-type` it names the device it
creates.

Android start-up is more honest too: booting an AVD that is already running
reports it instead of timing out behind a second emulator that immediately
exits, the boot wait matches on the requested AVD rather than "whichever device
attached next", and emulator output goes to
`~/.conductor/logs/emulator-<avd>.log` so a failed boot reports its cause
instead of a bare 120s timeout.
