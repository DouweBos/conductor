---
"conductor-studio": minor
"@conductor/studio-ui": minor
---

Make the workbench layout draggable: the flow sidebar and device column resize
horizontally, the console resizes vertically, and both remember their sizes
between sessions. `SplitPane` gained a `flexIndex` so a middle panel can absorb
the slack (the editor, between two fixed columns), clamps a drag so no panel can
be squashed past its minimum, and takes a `storageKey` to persist sizes.
