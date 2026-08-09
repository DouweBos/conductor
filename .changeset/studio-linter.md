---
"conductor-studio": minor
"@conductor/studio-ui": minor
---

Catch broken flows before running them. A linter checks the flows directory
against the command schema and the flow catalog — unknown commands and
parameters, unknown header keys, `runFlow`/`runScript` paths and aliases that
don't resolve, calls that omit parameters the subflow reads, `${…}` names
nothing supplies, and test cases pointing at flows that no longer exist.
Problems appear underlined in the editor as you type and in a Problems tab in
the console.
