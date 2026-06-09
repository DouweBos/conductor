---
"@houwert/conductor": patch
---

Make the blast radius of `launch-app --clear-state` and `--clear-keychain` explicit: clarified `--help` text, updated `docs/commands.md`, and added a one-line stderr warning when either flag is used. These flags drop the app's keychain items (signing the user out) and are easy to reach for as a debugging shortcut — the new messaging spells that out. No behavior change.
