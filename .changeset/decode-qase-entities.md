---
"conductor-studio": patch
---

Decode the HTML entities Qase stores case prose with, so a title reads
`a show's details page` rather than `a show&#039;s details page`. Applies to
titles, descriptions, steps, tags, suites and custom field values. Sync to
re-decode cases already cached.
