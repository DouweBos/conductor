---
"@houwert/conductor": minor
"conductor-studio": minor
---

Turn Studio's test cases from a read-only matrix into test case management:
authoring, structured steps that name the page object automating them (so a flow
can be scaffolded from a case and checked against it), an execution log fed by
flow runs, manual verdicts, the agent and CI, test plans that run a selection on
a device, and CSV import/export. Cases and results live under
`~/.conductor/studio`, not in the repo under test, and results are local only —
there is no CI sync. Adds `conductor cases
list | report | result` so CI can file JUnit results without Studio running.
