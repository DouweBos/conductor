---
'@houwert/conductor': minor
---

Add `conductor parity` — prove a rebuilt screen still matches the original.

Walk one journey through two builds of an app, capture named checkpoints in
each, and diff them. The comparison is semantic, over the accessibility
snapshot: which elements exist, what they say, where they sit and in what
reading order. Two builds in different stacks never agree pixel-for-pixel while
being, to a user, identical, so the pixel ratio is reported as corroborating
evidence rather than as the verdict.

- `parity record <flow> --out <dir>` captures a reference run.
- `parity compare <flow> --reference <dir>` walks the candidate build, diffs it,
  and exits non-zero on a blocking difference — so it gates a migration.
- `parity diff <ref> <cand>` re-diffs two recorded runs with no device attached.
- `checkpoint <name>` captures one checkpoint ad hoc.
- A new `- checkpoint: <name>` flow step marks the comparison points. It is a
  no-op outside a parity run, so flows carrying checkpoints still run normally.

Reports are written as JSON (always, next to the candidate run) and optionally
as a self-contained side-by-side HTML page via `--html`. `--blocking`,
`--ignore`, `--strict`, `--frame-tolerance` and `--pixel-threshold` tune which
differences fail a checkpoint.

Ships a `conductor-parity` agent skill documenting the record → rebuild →
compare loop.
