---
"@houwert/conductor": minor
---

Support canvas-rendered webtv apps (Lightning/WPE/RDK) in the web driver.

Such apps draw their whole UI into a single `<canvas>` and expose the scene graph through a DOM-inspector mirror of off-screen `<div>`s — the real identity lives in `data-testid` and the focused node is flagged `data-focused="true"` (the canvas owns `document.activeElement`, so normal focus detection can't see it). conductor's web hierarchy is built from Playwright's ARIA snapshot, which captures none of this.

- The web `/viewHierarchy` now harvests the `data-testid`/`data-focused` mirror via a single `page.evaluate` and merges it into the hierarchy: each mirror node enriches the overlapping ARIA node (adding `testId` and focus), or is appended when the ARIA snapshot lacks it.
- `id:`/`query:` selectors match the harvested `data-testid` in preference to the ARIA `ref`, so `tap-on --id sign-in-button`, `assert-visible --id …`, etc. target the conventional test hook.
- `focused:` and `conductor focused` now reflect `data-focused`, making D-pad focus navigation observable.
- `press-key` maps `Remote Dpad Up/Down/Left/Right/Center` onto `ArrowUp/Down/Left/Right/Enter` on web, so the TV remote drives focus on canvas apps.

Drive TV apps at the app's native resolution (e.g. `set-viewport 1920 1080`); mirror bounds are reported in viewport CSS pixels, so off-screen nodes need the matching viewport. Normal accessible web is unaffected — the mirror pass is a no-op when no `data-testid`/`data-focused` is present.
