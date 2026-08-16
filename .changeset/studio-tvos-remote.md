---
"conductor-studio": minor
---

Drive tvOS from the device stream, and record the remote into the flow.

A TV is focus-driven, so the two gestures Studio could record — tap and swipe —
were exactly the two that mean nothing on one, and nothing in Studio called
`press-key` at all. For a tvOS device the stream now becomes a remote instead of
a touch surface: it takes keyboard focus, arrow keys drive the D-pad,
Enter/Space selects, Esc/Backspace is Menu, and in Record mode each press is
appended to the open flow as a `pressKey` step.

Auto-repeat is ignored, so holding a key is one press and one step — the
recorded flow always matches what actually happened on the device. Long presses
aren't recorded: a flow's `pressKey` takes a bare key and Maestro's is
scalar-only, so a held press could be performed but never replayed faithfully.
