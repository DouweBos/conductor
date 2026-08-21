---
name: conductor-test-cases
description: Read a repo's test cases and file execution results from the command line, including turning a JUnit report from a CI run into per-case results. Use when reporting automated test outcomes back to the test-case matrix, checking which cases have no flow behind them, or recording a case verdict from a script.
---

# Conductor — test cases

A **test case** is the human-readable spec — id, title, business rule, steps,
tags — kept as a YAML file under `~/.conductor/studio/cases/<project>/`, keyed
by the project's path. Executions are appended to `results.jsonl` beside them.
Neither is written into the repo under test: the Maestro flow a case names is
the implementation, and that is what belongs in git.

Both are plain files — read them, diff them, sync them however you like. Set
`__CONDUCTOR_STUDIO_DIR` to relocate the store (CI sandboxes, tests). Cases an
older version wrote to `test-cases/` in the repo are still read.

| Command | Purpose |
|---|---|
| `conductor cases list [--project <dir>]` | List every case and the flow behind it |
| `conductor cases report --junit <file.xml>` | File a JUnit report as per-case results |
| `conductor cases result <case-id> --verdict <v>` | Record one result by hand |

`--project <dir>` points at the repo root; it defaults to the working directory.
These commands touch files only — no device, no session.

## Report a CI run

```bash
conductor cases report --junit maestro-report.xml \
  --build 2026.17.0 --environment staging
```

Each `<testcase>` binds to a case by the **flow** it names (`vod-playback.tv.yaml`
→ the case whose `flows.tv` is that file, recording against the `tv` column) or,
failing that, by a **case id** appearing in the test name as a whole word
(`DT-97 search returns results` → case `DT-97`, recorded case-wide). Entries that
match nothing are reported as unmatched rather than silently dropped.

Add it as the last step of an e2e job, after the report is written:

```yaml
- run: conductor cases report --junit report.xml --build ${{ github.sha }}
```

## Record a single result

```bash
conductor cases result DT-1 --verdict failed --column tv \
  --note "Subtitles never appear after seek" --build 2026.17.0
```

`--verdict` is `passed`, `failed`, `blocked` or `skipped`. `--column` scopes the
result to one platform of a case that has a flow per platform; omit it for a
case-wide verdict.

## Find work

```bash
conductor cases list --json | jq '.cases[] | select(.flows | length == 0) | .id'
```

Cases with no flow are the unautomated ones — the backlog. Write the flow with
`conductor-create-flow`, then add its path to the case's `flow:` (or `flows:`,
keyed by platform) so the matrix picks it up.
