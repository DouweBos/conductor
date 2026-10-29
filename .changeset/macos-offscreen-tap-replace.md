---
'@houwert/conductor': patch
---

macOS background driver: `tap-on` now works on an element scrolled out of view in a scroll view. It scrolls the element into view and presses it, instead of failing on whatever sits under the off-window point. New `input-text --replace` replaces the focused field's whole contents, because select-all shortcuts don't reach an app in the background. A daemon left running older conductor code is now restarted on the next command, and a ConductorAX helper from an older or rebuilt binary is replaced automatically. Before, an upgrade or rebuild kept talking to the old processes until they were killed by hand. `daemon-stop` now also stops a helper started from another path or version.
