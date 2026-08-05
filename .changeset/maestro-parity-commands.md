---
'@houwert/conductor': minor
---

Add Maestro-parity commands and coordinate tapping:

- `tap-on --at <x,y>` taps a raw coordinate (px, `%`, or `0-1` fraction), plus
  `--repeat <n>` / `--delay <ms>` on any tap.
- `copy-text-from <element>` prints an element's text (and copies it to the iOS clipboard).
- `assert-true <expr>` asserts a JavaScript expression in the flow sandbox (no device).
- `assert-screenshot <reference.png>` does visual-regression comparison against a
  baseline (`--threshold`, `--update`; writes a `.diff.png` on mismatch).
- `set-permissions <perm=value>...`, `add-media <path>...`, `set-airplane-mode`
  / `toggle-airplane-mode` (Android), and `travel <lat,lng>... [--speed]` surface
  existing driver capabilities as first-class CLI verbs.
- `record-video start|stop` records a screen video (iOS via simctl, Android via
  screenrecord) — distinct from `flow record`, which records a YAML flow.
