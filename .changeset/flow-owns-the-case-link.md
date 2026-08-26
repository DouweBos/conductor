---
"conductor-studio": minor
---

Flows own the link to their test case, and Studio stops managing cases.

A flow declares the case it verifies in its own Maestro header:

```yaml
properties:
  testCaseId: "MC-12"
```

That is now the only place the link is recorded. Maestro carries the property into its JUnit and HTML reports, so the case is named wherever a flow runs — CI included — and coverage is answered by reading the repo rather than a store Studio has to keep in step. A case covered on several platforms is several flows declaring the same id, each with its own tag; the matrix reads the tags for its columns.

Cases are no longer mirrored, authored or stored. Qase owns them; Studio fetches them into a disposable cache under `~/.conductor/studio/<repo>/qase-cache/` and writes nothing back. Which Qase project a case belongs to is read off its id (`MC-12` is MC's), so configuration is a token per project code — the sub-project registry, its switcher and its per-project stores are gone.

Removed with it: case authoring (create, edit, renumber, delete), the local (non-Qase) datasource, CSV import and export, and the sync machinery they needed — deprecation tracking, page-object re-attachment across pulls, and the id-clash and foreign-case guards. Test plans, the manual run wizard, per-step page objects and the execution log all stay; step assignments moved to `automation/step-poms.json` and the log to `results/results.jsonl`, both under the repo's Studio directory.

Existing case YAML, plans and results are not migrated. Cases come back on the first fetch; plans and the execution log from before this release stay on disk under their old paths and are not read.
