---
"conductor-studio": minor
---

Complete subflows where a step goes, since a POM suite is written by chaining
them: typing `details/open` offers `@pages/details/open.yaml`, and accepting it
writes the whole `runFlow` — the file in its config.yaml alias form, plus the
`env:` block of every parameter the subflow expects, with tab stops in the
values. Parameters are inferred from the subflow's own `${…}` usage, so they're
found whether or not it declares them. Path parameters (`file`, `files`, `path`,
`script`) complete from the flows directory too, in both alias and relative form.
