---
'@houwert/conductor': patch
---

Support `config.yaml` path aliases in Maestro flows. A `file:` reference of the
form `@alias/rest` (in `runFlow`, `runScript`, or `addMedia`) now resolves via a
`paths:` map in the nearest `config.yaml` walking up from the flow file, matching
the plexinc/maestro fork. Non-alias paths are unchanged (relative to the flow
file, or absolute).
