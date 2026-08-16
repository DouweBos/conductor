---
"conductor-studio": patch
---

Record an assertion on the focused element, on TV only.

The Assert button appended an `assertVisible` for the largest labelled element
on screen — a proxy for "which screen am I on" that got worse once the capture
started carrying the full view hierarchy, since the largest labelled node is
then the app window itself.

On a TV focus *is* the state of the screen, so it now records
`assertVisible … focused: true` against whatever holds focus: the deepest
focused element that has an id or a label, matching how the resolver picks
between a focused container and the focused element inside it. The button only
shows for tvOS devices, since elsewhere there's usually nothing focused to
assert on.

The step goes through the YAML writer rather than string interpolation, so a
title containing a colon or a quote comes out escaped instead of producing a
step that won't parse.
