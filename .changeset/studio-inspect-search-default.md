---
"conductor-studio": patch
---

Show the element search in inspect mode until you've picked something.

Inspect mode with nothing selected was a "Pick an element" placeholder, so the
searchable tree — the fastest way to find an element that's offscreen or buried
— was only reachable by switching back to interact mode. The panel now falls
back to the inspector, and swaps to the command list once you pick an element on
the device or in the tree. Clearing the selection returns you to the search.
