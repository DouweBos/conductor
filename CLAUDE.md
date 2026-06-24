# Conductor — contributor guidance

## Commit messages & PRs

- **Never add LLM / AI branding to commit messages or PR descriptions.** No
  `Co-Authored-By: Claude ...` (or any AI) trailers, no "Generated with Claude
  Code" lines, no AI attribution of any kind. Commits are authored by the
  human committer only.

## Keep the bundled agent skills in sync

`conductor init` ships the agent skills that document the CLI for AI
agents. The templates live in `packages/cli/skills/`, one directory per
capability-scoped `conductor-<capability>` skill (each with a `SKILL.md`), and
are published with the package (see the `files` field in
`packages/cli/package.json`). The command copies every bundled skill into a
consumer repo's `.claude/skills/`. The installer auto-discovers any directory
containing a `SKILL.md`, so adding a new skill is just adding a new folder.
It records what it installed (and the conductor version) in a
`.conductor-skills.json` manifest at the skills root, which it uses to detect
stale installs and to prune skills it previously installed that have since been
removed or renamed — so renaming a skill folder cleans up the old name on the
next `init --force`.

When you add, rename, or change a command or flag, update the relevant skill's
`SKILL.md` in the same change so it doesn't drift from the actual CLI. Match the
existing frontmatter style: a one-sentence "what" followed by a "Use when …"
trigger clause.

## Footguns — destructive flags

These flags wipe user data and cannot be undone without the user's credentials.
AI agents driving conductor should **not** reach for them as a debugging shortcut:

- `launch-app --clear-state` / `conductor clear-state` — uninstall+reinstalls the
  app, which also drops the app's keychain items. The signed-in user is logged
  out. Do **not** use to "reset focus state" or clear navigation; relaunch
  without the flag, or press Menu/back to navigate out, instead.
- `launch-app --clear-keychain` — resets the simulator's entire keychain. Signs
  the user out of every app on the device.

If you're an AI agent and you genuinely need either of these, ask the human
first — they may have credentials they don't want to re-enter.
