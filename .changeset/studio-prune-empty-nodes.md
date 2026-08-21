---
"conductor-studio": patch
---

Collapse hierarchy nodes that carry no identity.

Building the inspector from the full view hierarchy brought the layout wrappers
with it — no identifier, no text, no a11y, nothing to select on. A native
hierarchy is mostly single-child wrappers, so the tree and the right-click stack
filled with hundreds of rows named after their own node path.

A node with no identifier, no text and no a11y ref is now spliced out and its
children take its place. A wrapper that branches is kept, since it's the only
thing grouping its children, and it reads as "Group" rather than `#0.0.0.0.…`.
