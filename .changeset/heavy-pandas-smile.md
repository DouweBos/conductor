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

Parity spans two *platforms*, not just two builds of one — tvOS against a
Lightning/canvas TV app, or a native app against its web build:

- `A11ySnapshotEntry` gains `identifier` (`accessibilityIdentifier` on iOS/tvOS,
  `resource-id` on Android, `data-testid` on web), and elements pair on it first.
  Identity is the only signal that survives a port between stacks.
- Canvas TV apps (Lightning/WPE/RDK) mirror their scene graph into off-screen
  divs that carry `data-testid` but no ARIA role. Those nodes were dropped from
  the a11y snapshot entirely, so `inspect`, `capture-ui` and parity all under-
  reported them; a node with a testid or reported focus is now included.
- Roles are relaxed automatically when the two runs are on different platforms,
  whose role vocabularies don't line up. `--ignore-role` forces it within one.
- `focus` is its own finding kind and blocks by default: on a remote-driven TV
  app focus is the interaction model, not a state detail. It reports nothing when
  neither build has focus.
- The app/window root and untagged layout containers are no longer compared.

Parity compares one reference against **many** targets, not just one:

- `parity compare --target "<label>=<device>"` (repeatable) walks every named
  build in parallel — one child process each, so the `checkpoint` step's
  process-wide active run stays isolated — and reports a checkpoint × target
  grid instead of N separate verdicts.
- `parity matrix <ref-dir> <dir...>` does the same over runs already on disk,
  with no devices attached.
- Findings are rolled up across targets. A finding every target reports is
  marked **universal** and surfaced separately: four independent rebuilds rarely
  drop the same control, so that is usually a statement about the reference run
  (stale, behind a flag, a different experiment bucket) rather than about the
  targets. A finding on one target is that target's bug.

Parity no longer needs a flow. `parity snap <name> --out <dir>` captures what
the reference and every target are showing **right now**, diffs them, and
appends to one session — so calling it as you move through the app builds the
grid a screen at a time. A repeated name is numbered for every device at once,
so the screens still pair. Getting the targets onto the matching screen is the
caller's to arrange (by hand, with an agent, or with mirrored input); `snap`
compares what it is given.

Parity no longer needs a reference *app* either. `parity spec <name> --out <dir>
--spec <elements.json>` writes a reference run from a hand-authored or
design-exported element list — label, role, identifier, frame, value, focus, the
vocabulary the diff already reads — so a design can be the thing the rebuilt
apps are held to before anything ships it. A spec is an element list, not a
picture: keeping it structural keeps the comparison semantic. Its platform is
`design`, so roles relax against any real target; pair it with `--ignore pixel`
unless a `--screenshot` worth comparing against was supplied.
