---
"conductor-studio": patch
---

Give Studio its own release tag and update feed, separate from the CLI's.

Studio's releases share the conductor repo with the CLI, which publishes
`v<version>` tags. electron-builder defaults to that same tag shape, so
publishing Studio would have uploaded its dmg into an existing CLI release the
moment the versions overlapped. Studio now tags `studio-v<version>`.

That prefix also rules out electron-updater's github provider, which resolves
the stable channel through a repo-wide `/releases/latest` — in this repo, a CLI
release carrying no channel manifest. Studio moves to the `generic` provider
behind `https://houwert.dev/conductor/studio/updates`, a Cloudflare Pages
Function that filters to `studio-v` tags and resolves each channel to the
newest release in its tier. Requires the companion function in the houwert.dev
repo.

The release channel now comes from the version itself — `0.2.0-beta.1`
publishes to beta as a GitHub prerelease, `0.2.0` to stable — so the workflow's
channel input is gone; bump the version and run it. Artifacts are also renamed
to `conductor-studio-<version>-<arch>.<ext>`, since GitHub rewrites the space in
`Conductor Studio` and broke the URLs recorded in the channel manifest.
