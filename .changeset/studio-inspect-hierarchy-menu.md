---
"conductor-studio": minor
---

Right-click an element in inspect mode to pick from the hierarchy under it.

The smallest box under the cursor wins the pointer, which is right for picking a
label but leaves the row, cell or container that holds it unreachable — you had
to hunt for it in the inspector tree. Right-clicking now lists every element
whose bounds cover that point, innermost first and indented by depth, and
hovering an entry highlights it on the device before you commit.
