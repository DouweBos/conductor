---
"conductor-studio": minor
"@conductor/studio-ui": minor
---

Add Maestro-Studio-style element picking to the device panel. An Inspect mode
outlines every captured element over the live stream — hover highlights the
smallest one under the cursor, clicking it lists the commands that fit it
(tapOn, longPressOn, inputText, assertVisible, copyTextFrom, runFlow-when-visible)
as ready-to-paste YAML you insert into the open flow. Selectors are offered
accessibility id first, then text (indexed when it isn't unique), then a
percentage coordinate — and coordinates only for tap-like commands, since an
assertion can't match a point. tvOS gets remote keys instead of taps.
