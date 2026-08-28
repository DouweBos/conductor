---
"conductor-studio": patch
"@houwert/conductor": patch
---

Recognise Maestro's `properties` header key: it now shows up in the editor's
top-level autocomplete, and a single-document flow that uses it (or `name:`) is
parsed as a header instead of being mistaken for a command.
