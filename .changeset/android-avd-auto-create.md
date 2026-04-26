---
"@houwert/conductor": minor
---

`conductor start-device --platform android` can now auto-create an AVD when one
doesn't exist, mirroring the iOS `--device-type` flow. Pass `--avd <name>
--device-type <profile>` (e.g. `--device-type pixel_7`) and conductor will pick
an installed system image for the host arch (`arm64-v8a` on Apple Silicon, else
`x86_64`), filtered by `--os-version` if provided, then run `avdmanager create
avd` and boot it. `--system-image <id>` lets you override the auto-pick. If no
matching system image is installed, conductor exits with the exact `sdkmanager`
command needed to install one — no automatic multi-gigabyte downloads.
