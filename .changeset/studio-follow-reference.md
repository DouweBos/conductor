---
"conductor-studio": patch
---

Make Cmd-clicking a flow reference actually open it, and show it as a link.

Go-to-definition was already wired up but silently dead: `flowRefs` imported
`node:path`, which Vite externalizes for the renderer, so `resolveReference`
threw on every Cmd-click and you were left hunting for the POM by hand. The
path handling is now hand-rolled posix, shared unchanged with the main process.

Holding Cmd/Ctrl also underlines the reference under the pointer and only
follows a click on the token itself, so a suite's subflows read as links instead
of being an invisible affordance you have to already know about.
