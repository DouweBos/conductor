---
'@houwert/conductor': minor
---

Add `conductor init`, the one-time manual setup command that installs conductor's bundled Claude Code skills into a repo's `.claude/skills/`. It's interactive when run in a terminal (choose scope and which skills) and non-interactive otherwise (`--yes`, piped, or headless installs all skills); `--global` targets `~/.claude/skills/` and `--force` re-syncs already-installed ones. The skills are capability-scoped — `conductor-device-interact`, `conductor-inspect`, `conductor-create-flow`, `conductor-metro-debugger`, `conductor-profiler`, and `conductor-device-setup` — and document every command and the act → observe → act workflow for AI agents.

`init` records what it installed and the conductor version in a `.conductor-skills.json` manifest, so on a later run it detects skills left over from an older conductor (prompting to re-sync in the wizard, or printing an update hint when non-interactive) and prunes skills it previously installed that are no longer shipped. Pruning is bounded to the manifest and the `conductor-` prefix, so it never touches user-authored or third-party skills.
