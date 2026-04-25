# @houwert/conductor

## 0.13.0

### Minor Changes

- 51fd7a4: Drop the bundled Claude Code plugin and skill. Conductor is now a pure CLI — no postinstall plugin registration, no `SKILL.md`, and no `install-plugin` / `install-skills` / `cheat-sheet` commands. Wire Conductor into your agent however you like (a custom `CLAUDE.md`, a project skill, a slash command); use `conductor --help` for the full command reference.
- ffbd62f: Improve Metro log discovery and simplify the `logs` command. Metro targets are now resolved deterministically per device — no more `--metro`, `--metro-port`, or `--target` flags. The `--source` flag is now a filter (`metro` | `device`); when omitted, both sources stream together. `--list` prints only the Metro targets bound to the current device.

## 0.12.3

### Patch Changes

- 7c4ea4d: Fix element frames returned from `inspect` / `capture-ui` being in window-local coordinates when the iOS app runs windowed (iPadOS Stage Manager, Slide Over). The 0.12.2 fix assumed XCUIElement snapshot frames were already in screen space and removed all offset math, but snapshots are window-local in windowed mode — both `snapshot().frame` and `XCUIApplication.frame` report `(0, 0)` as the window origin. Resolving via `attributesForElement:` also fails because the AX daemon's per-PID attribute map isn't populated on-demand. The working source is SpringBoard's own snapshot (SpringBoard is always fullscreen, so every descendant's frame is screen-space): we snapshot it once per inspect, find the descendant whose dimensions match the foreground app's window, and translate every frame by that origin. Translated frames are also clipped to the window bounds, so views the window compositor hides — scrolled-off cells, sibling containers the app keeps measured but not visible — no longer leak into `tap-on` hit-testing or out-of-window outline overlays. Outlines and tap coordinates now line up with the underlying controls regardless of window position.

## 0.12.2

### Patch Changes

- e9cbf49: Fix element frames in `inspect` / `capture-ui` being shifted when the app runs windowed (iPadOS Stage Manager, etc.). The iOS driver was adding a bogus `(screenSize − windowSize)` offset to every element, which only happened to be correct if the window was flush to the bottom-right corner. XCUIElement snapshots are already in screen-space, so the adjustment is removed entirely — outlines now align with the underlying controls regardless of window position.

## 0.12.1

### Patch Changes

- b9fef80: Fix iOS driver resolving the wrong foreground app on iPadOS 26. In windowed / Stage Manager modes, scene-based lookup returned shell processes (DockFolderViewService, SpringBoard) instead of the user's app; capture-ui and inspect now bind XCUIApplication by PID so the hierarchy reflects the running app. Also drops an AX snapshot in ScreenSizeHelper that hung 30s+ on heavy-AX apps like Plex.

## 0.12.0

### Minor Changes

- e04fc3f: Add `memory` command for debugging memory pressure across all platforms: reports system memory totals, per-app PSS/RSS/heap/code/stack/graphics breakdown, and object counts. Uses `dumpsys meminfo` on Android (Views, Activities, Binders, Parcels), `vm_stat` + `vmmap` on iOS simulators (region breakdown), and Playwright CDP `Performance.getMetrics` + `performance.memory` on web (Nodes, Documents, Frames, JSEventListeners, JS heap).

## 0.11.0

### Minor Changes

- 10dd2a6: Add capture-ui command and a11y fields to inspect

## 0.10.0

### Minor Changes

- 1e9725f: Drivers moved out of npm package; downloaded on first use from GitHub Releases into `~/.conductor/drivers/<version>/`. Lets downstream notarized macOS apps ship conductor cleanly without Apple rejecting the bundle over iOS/tvOS/Android driver binaries signed for non-macOS platforms.

## 0.9.0

### Minor Changes

- 1c439e0: Auto kill chrome daemons when parent process stops

## 0.8.0

### Minor Changes

- 59f689c: Add web device management

## 0.7.1

### Patch Changes

- 79b83d4: Fix web control

## 0.7.0

### Minor Changes

- 9dc701a: Add custom CDP url support for web control

### Patch Changes

- 6317ae4: Add --version

## 0.6.0

### Minor Changes

- 6002bfd: Add delete-device command
- 9647790: Add web support
- 6002bfd: Add logs command

### Patch Changes

- 7488ad8: Fix CLI command naming
- bdd1637: Do not require device selection for daemon-stop --all

## 0.5.0

### Minor Changes

- 9fe1c39: Add install-app command

## 0.4.0

### Minor Changes

- 4260368: Add app uninstall and clear-state commands

## 0.3.0

### Minor Changes

- 6ae546f: Add focused item query
- f8d758c: Add named devices support
- 786f119: Add inspect dump command
- bf6170c: Add tvOS support

### Patch Changes

- d462847: Fix CI release workflow
- d6a2ef8: Update README
- d131555: Updated skill installation
- d77b942: Update README with vibes
- 064a1cb: Fix Android driver never attaching to device
- 6cfc110: Update README

## 0.2.0

### Minor Changes

- 11858d2: Initial commit and project setup
