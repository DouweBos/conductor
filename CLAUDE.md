# Conductor — contributor guidance

## Commit messages & PRs

- **Never add LLM / AI branding to commit messages or PR descriptions.** No
  `Co-Authored-By: Claude ...` (or any AI) trailers, no "Generated with Claude
  Code" lines, no AI attribution of any kind. Commits are authored by the
  human committer only.

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
