---
"conductor-studio": patch
---

Give inspector rows enough context to tell duplicates apart.

Two rows reading `Element "Continue Watching"` — a container and the text inside
it — were indistinguishable. Rows now carry their size, which is the thing that
separates a row-wide container from the label it wraps.

Roles were also missing on iOS and tvOS, which is why everything read as
"Element": the hierarchy node carries `traits`, and only the flat snapshot entry
has a `role` derived from the first one. The mapper reads the traits directly
now, so rows say `staticText`, `button`, `window` again.
