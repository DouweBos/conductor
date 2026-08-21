---
"conductor-studio": minor
---

Close the loop between a failing run, CI, and the agent. Test cases now take
their status from the **JUnit report** a CI run uploads — a per-flow result with
the failure message — instead of matching job names, and a workflow can be
triggered from Studio. A failed run gets an **Ask the agent to fix it** button
that opens the agent with the failing step, the paths to maestro's screenshot
and screen hierarchy for that moment, and the output tail already composed.
Record mode can now capture an `assertVisible` for the current screen, so a
recording asserts something rather than only tapping.
