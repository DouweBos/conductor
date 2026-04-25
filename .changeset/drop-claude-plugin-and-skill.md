---
'@houwert/conductor': minor
---

Drop the bundled Claude Code plugin and skill. Conductor is now a pure CLI — no postinstall plugin registration, no `SKILL.md`, and no `install-plugin` / `install-skills` / `cheat-sheet` commands. Wire Conductor into your agent however you like (a custom `CLAUDE.md`, a project skill, a slash command); use `conductor --help` for the full command reference.
