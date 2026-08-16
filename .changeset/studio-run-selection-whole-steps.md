---
"conductor-studio": patch
---

Run whole steps from a selection, not the raw selected text.

"Run selection" sent exactly the characters you had highlighted, so a selection
ending on a `- assertVisible:` line without the indented `id:` beneath it wrote
a command with no value — which Maestro rejects with
`Incorrect Command Format: assertVisible`, pointing at the end of the truncated
line rather than at anything you could see was wrong.

The selection is now rounded out to every step it touches, so partially covering
a step runs that step. Parking the cursor inside a step body and hitting Run
selection runs that step too. A selection that touches no steps does nothing
instead of failing.
