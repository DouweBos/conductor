---
'@houwert/conductor': patch
---

Stop web/CDP commands from running on another device. Flags passed as one argument (zsh doesn't split an unquoted `$FLAGS`) dropped `--device`, so the command ran on the first booted device, often an Android emulator. That case is now an error. Several booted devices without `--device` in a non-interactive shell are an error too, as are `--cdp-url`/`--cdp-target` on a device that isn't a web device.
