---
"conductor-studio": patch
---

Let deep tree rows scroll horizontally instead of collapsing to dots.

Rows were capped at the container width, and the label was the only part
allowed to shrink — so past a few levels of nesting the indentation ate all of
it and a row rendered as a twisty, a dot and its `@eN` badge, with nothing to
say which element it was. The tree now sizes to its widest row, so the panel
scrolls far enough to read them.

Labels no longer ellipsise, which also applies to the flow sidebar's file tree:
a long filename now scrolls into view rather than being cut short. Both trees
already sat in scrollable panels, so nothing is clipped out of reach.
