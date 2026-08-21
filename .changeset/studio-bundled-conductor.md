---
"conductor-studio": minor
---

Ship the conductor CLI with Studio instead of hunting for one on `PATH`.

Studio previously resolved `CONDUCTOR_BIN`, then `conductor` on `PATH`, then the
workspace build — which meant a packaged app was only usable by someone who
already had the CLI installed globally, at whatever version happened to be
there. It now bundles a self-contained tree, following the same approach Argus
uses: `scripts/prepare-conductor.ts` installs a pinned published version into
`native/conductor/` at postinstall, and an `afterPack` hook copies it into the
packaged app's `Resources/`. PATH lookup is gone.

The driver binaries stay lazy — the npm package carries no `drivers/`, so the
CLI still downloads them on first use and the bundled tree remains pure
JavaScript, which is what keeps `Resources/` notarizable.

Settings gains a **Conductor version** picker: pin any published version at or
above the bundled one and Studio installs it into `<userData>/conductor/<version>/`
on demand, no app update required. The pin is stored separately from
`settings.json` so a corrupt settings blob can't strand the app, and a failed
install falls back to the bundled tree.

For development against unpublished CLI changes, `CONDUCTOR_LOCAL` points the
prepare script at a local checkout and links its built drivers in — replacing
the old `CONDUCTOR_BIN` escape hatch.
