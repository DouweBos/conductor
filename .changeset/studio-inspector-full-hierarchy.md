---
"conductor-studio": minor
---

Show the whole view hierarchy in the inspector, not just the a11y snapshot.

Elements that a CLI `assert-visible` found were missing from Studio's tree. The
inspector was built from `capture-ui`'s flat `a11ySnapshot`, which only holds
nodes a screen reader stops on — a container carrying an accessibility
identifier, exactly the thing selectors target, was never in it. The tree now
comes from the platform hierarchy, which also carries identifiers directly
instead of the old trick of matching them back on by rounded frame. That trick
only read `hierarchy.axElement`, so on Android and web identifiers never
resolved at all.

Rows lead with the identifier too — one showing only its role read as an
anonymous "Element" even when it had one.

`@eN` refs still come from the snapshot, joined on the `nodeId` path. Nodes
without one are marked non-a11y, which keeps the device overlay to the same
handful of boxes as before and leaves scene-graph signatures unchanged.
Right-click on the device still reaches the containers around them.
