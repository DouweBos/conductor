---
'@houwert/conductor': minor
---

Add a way to discover the valid values for commands and parameters that only
accept a fixed set of choices (e.g. `press-key <key>`, `--direction`,
`set-orientation`, `set-viewport --preset`/`--color-scheme`, `logs
--level`/`--source`, `--platform`). Previously an agent driving the CLI had no
way to know these enumerated values short of triggering a validation error.

- `conductor <command> --options` prints the valid values for that command's
  enumerated parameters and exits (e.g. `conductor press-key --options`).
- `conductor list-options [command|param]` lists every enumerated parameter, or
  filters by command/parameter/value (e.g. `list-options direction`).
- Both support `--json`.

The values are sourced from a central registry that imports the canonical lists
the commands already validate against, so the discovery output can't drift from
the real behavior.
