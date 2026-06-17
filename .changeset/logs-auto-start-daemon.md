---
"@houwert/conductor": patch
---

Auto-start the daemon when reading logs without one running. `conductor logs` (both `--recent` and streaming) previously relied on `getDriver()` to bring the daemon up, but `getDriver()` only spawns the daemon when the driver *port* is closed. After the daemon idle-times-out while leaving the driver alive (e.g. tvOS deliberately keeps its runner up across daemon restarts), the port stays open but the daemon socket — which hosts the log collector — is gone, so log reads failed with "Daemon … is not responding". The command now explicitly ensures the daemon socket is up via the idempotent `startDaemon()` before connecting.
