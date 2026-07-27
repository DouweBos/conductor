---
'@houwert/conductor': patch
---

Fix `focused`/hierarchy mis-reporting on canvas TV apps (Lightning/WPE/RDK). The
canvas scene-graph mirror was merged into the ARIA tree by **bounds overlap**, so
with an overlay open (e.g. a drawer) a real-DOM item overlapping a focused tile
could steal the tile's focus — and even its `data-testid` identity. `conductor
focused` then reported the wrong element.

Focus and identity now ride `data-testid`, read natively from each element, and
are joined to the tree by identity instead of geometry: a scene node enriches /
focuses the tree node that *is* it, and canvas-only nodes are surfaced on their
own. The focus path's deepest `data-focused` node wins. Plain DOM apps are
unaffected — when no canvas mirror is present, focus still comes from ARIA
`[active]` / `document.activeElement`.
