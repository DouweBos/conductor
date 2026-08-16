---
"conductor-studio": patch
---

Show only matching elements when searching the inspector.

Filtering kept the ancestors leading to each hit, so the tree still nested and
you read past several wrapper rows to reach the element you were after — and the
match count included those ancestors, so it never matched what you could see.
A search now lists just the elements that match, and the count is the number of
them.

A hit that sits inside another hit keeps its nesting; only the non-matching
nodes between them are dropped. Clearing the filter brings the hierarchy back.
