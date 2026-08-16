---
"conductor-studio": minor
---

Tab the inspect-mode command suggestions instead of stacking them.

Picking an element produced one flat scroll of every command × every selector —
on tvOS that's six remote keys before you reach the first assertion. They're now
grouped into Press/Tap, Assert, Scroll and Other, and the panel shows one group
at a time. The chosen tab sticks as you pick different elements, and groups with
nothing in them don't get a tab.

Adds two commands the list was missing: `assertNotVisible`, and
`scrollUntilVisible` in each of the four directions. Scroll is a swipe, so it's
offered on touch platforms only — a TV moves focus instead.
