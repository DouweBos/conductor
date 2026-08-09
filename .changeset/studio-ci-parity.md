---
"conductor-studio": minor
---

Close the gap between running a flow in Studio and running the suite in CI.
Run options gain saved **profiles**, so the env a suite always needs (`APP_ID`,
platform) is picked rather than retyped; a **tag picker** built from the tags the
flows actually declare; and a **flakiness check** that runs one flow N times and
reports the pass rate. Adds **Run changed**, which runs the flows you touched
against `main`, sharded runs (`--shard-split` on maestro, `run-parallel` on
conductor), and Boot / Install-a-build controls on the device panel.
