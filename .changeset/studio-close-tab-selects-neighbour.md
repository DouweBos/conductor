---
"conductor-studio": patch
---

Select the neighbouring tab when you close the active one.

Closing a tab only dropped it from the open list. The open file lives in the
URL, which still pointed at the file that just closed, so the editor stayed
mounted with no buffer behind it — a tab bar over an empty pane.

Closing the active tab now moves to the tab on its left, or the one on its right
when it was the first, and falls back to the "no flow open" state when it was
the last. Closing a background tab leaves your current file alone.
