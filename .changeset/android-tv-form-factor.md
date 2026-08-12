---
"@houwert/conductor": minor
"conductor-studio": minor
---

`list-devices` now reports a `formFactor` for Android devices (`tv` or
`handset`), read from `ro.build.characteristics` for booted devices and from the
AVD name for available ones. Android reports TVs, phones and tablets alike as
`android`, so nothing downstream could tell them apart — a TV test could be sent
to a phone emulator. Studio uses it to pick the right device for a flow and to
offer tvOS and Android TV as separate choices.
