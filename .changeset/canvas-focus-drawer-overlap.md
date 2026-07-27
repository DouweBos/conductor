---
'@houwert/conductor': patch
---

Fix `focused` mis-reporting on canvas TV apps when an overlay is open. For
Lightning/WPE/RDK apps the focused scene node is matched to the ARIA tree by
bounds overlap. With a drawer/menu open, a real-DOM item could overlap a focused
canvas tile; the tile's center landing inside that item let a weak-overlap
(low-IoU) node win the match, so `conductor focused` reported the drawer item
instead of the tile. The center-inside bonus is now gated on a minimum IoU, so a
dissimilar overlapping node no longer hijacks the tile's focus — the tile is
surfaced as its own focused node instead.
