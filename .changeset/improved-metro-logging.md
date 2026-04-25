---
'@houwert/conductor': minor
---

Improve Metro log discovery and simplify the `logs` command. Metro targets are now resolved deterministically per device — no more `--metro`, `--metro-port`, or `--target` flags. The `--source` flag is now a filter (`metro` | `device`); when omitted, both sources stream together. `--list` prints only the Metro targets bound to the current device.
