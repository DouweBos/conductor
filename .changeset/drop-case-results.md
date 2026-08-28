---
"conductor-studio": minor
---

Studio no longer records case results. Qase is the system of record and Studio
only reads from it, so the local execution log, the manual run wizard, the
pass/fail buttons on a case, the `record_case_result` MCP tool and the matrix's
verdict cells are gone. Existing `results.jsonl` files are simply left alone.
