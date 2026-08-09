---
"conductor-studio": minor
"@conductor/studio-ui": minor
---

Renaming a flow now repoints every flow that calls it, in the style each call
site used — a config.yaml alias stays an alias, a relative path stays relative.
Previously a rename left all callers dangling, which in a POM suite silently
breaks dozens of flows. Adds "Find usages" to the flow menu, Cmd/Ctrl-click on a
`runFlow`/`runScript`/`file` line to open what it names, and project-wide search
across the flows directory.
