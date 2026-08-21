---
"@houwert/conductor": minor
"conductor-studio": minor
---

Adopt Qase's model for test cases, and remove test cases from the CLI.

**This minor release removes commands.** Released as a minor rather than a
major by choice; if you automate against `conductor cases`, read the
breaking notes below before upgrading.

A case is now a Qase case entity — `id`, `title`, `description`,
`preconditions`, steps as `action`/`data`/`expected_result`, `suite_id`,
`severity`/`priority`/`type`/`behavior`/`status`, `custom_fields` and a flat
`tags` list — written to YAML with Qase's own field names and its enums spelled
out rather than left as the integers the API sends. Conductor's homegrown fields
(`userStory`, `altIds`, dimension-map `tags`, `owner`, `state`, `links`) are
gone. The one non-Qase addition is a `conductor:` block holding what Qase has no
concept of: the flow that implements the case, and each step's page object.

Studio can now mirror cases from **Qase**. Set the datasource per project from
the Cases toolbar, paste an API token (stored encrypted via Electron's
`safeStorage`; `QASE_API_TOKEN` overrides it) and sync. Qase owns case content
and wins on every sync, but the `conductor:` block is re-attached, a page object
that could not be re-attached is reported rather than dropped, and a case Qase no
longer returns is marked `deprecated` rather than deleted — deleting it would
take its flow link with it. Qase-owned fields become read-only in the editor.
Matrix columns come from a Qase custom field of your choosing, falling back to
the suite. Projects left on `local` keep authoring cases in Studio as before.
Results now carry Qase's shape (`case_id`, `status` including `invalid`,
`time_ms`, `comment`, per-step statuses) plus `app_version`, so pushing them to a
Qase test run later is a small addition rather than a remap.

**Breaking:** `conductor cases` (`list`, `report --junit`, `result`) is removed,
along with the `conductor-test-cases` skill — `conductor init --force` prunes it
from repos that have it. The CLI is for device control and app debugging; test
cases are Studio's, and Studio's MCP server is how an agent reaches them, now via
`list_test_cases`, `describe_test_case`, `get_cases_datasource`,
`sync_test_cases`, `scaffold_case_flow`, `link_case_flow` and
`record_case_result`. `cases report --junit` has no replacement: it existed only
to ingest a CI run, and Studio is a local test-engineering tool.

**Breaking:** there is no migration. Existing case files and `results.jsonl`
records are not read by this version.
