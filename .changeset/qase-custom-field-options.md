---
"conductor-studio": patch
---

Show the titles of select-type Qase custom fields instead of their option ids.
A case carries `Media Source: 2`, and the option table lives on the field, so
Studio now fetches it with the field and resolves each value; anything without a
matching option is still shown as-is. Sync to pick it up — cached cases keep the
ids until then.
