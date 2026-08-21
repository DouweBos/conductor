---
"conductor-studio": minor
"@conductor/studio-ui": minor
---

Run one step of a flow without running the whole thing. Hovering the editor
reveals a play button in the gutter beside every step; clicking it runs just that
step, and the chevron next to it offers "Run all until here", which runs every
step up to and including that one. Both keep the flow's header so `appId` and its
`env` defaults still apply, and both honour the toolbar's run options.
