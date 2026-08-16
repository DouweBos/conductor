---
"conductor-studio": patch
---

Tag the inspector's elements that are actually on screen.

A capture holds the whole hierarchy, so a scroller's offscreen rows and
collapsed views sit in the tree looking exactly like the ones you can see —
and an assertion written against one of those is a flaky test. Rows whose box
intersects the screen now carry an "in view" badge beside their `@eN` ref.
Partially visible counts; zero-sized and boundless elements don't.
