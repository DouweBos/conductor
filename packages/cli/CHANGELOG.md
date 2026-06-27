# @houwert/conductor

## 0.21.0

### Minor Changes

- 2092f3b: Add `conductor init`, the one-time manual setup command that installs conductor's bundled Claude Code skills into a repo's `.claude/skills/`. It's interactive when run in a terminal (choose scope and which skills) and non-interactive otherwise (`--yes`, piped, or headless installs all skills); `--global` targets `~/.claude/skills/` and `--force` re-syncs already-installed ones. The skills are capability-scoped — `conductor-device-interact`, `conductor-inspect`, `conductor-create-flow`, `conductor-metro-debugger`, `conductor-profiler`, and `conductor-device-setup` — and document every command and the act → observe → act workflow for AI agents.

  `init` records what it installed and the conductor version in a `.conductor-skills.json` manifest, so on a later run it detects skills left over from an older conductor (prompting to re-sync in the wizard, or printing an update hint when non-interactive) and prunes skills it previously installed that are no longer shipped. Pruning is bounded to the manifest and the `conductor-` prefix, so it never touches user-authored or third-party skills.

- d35a8bc: Add a way to discover the valid values for commands and parameters that only
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

## 0.20.0

### Minor Changes

- 92dbb8a: Wire `network logs`, `network request`, and `debug evaluate` to the web (Playwright) driver.

  These commands previously only spoke to a React Native Metro/Hermes target, so on a web/webtv device they failed with "Could not connect to Metro". They now branch to the web driver when the session targets a web device:
  - `network logs` — captures all page traffic via Playwright `request`/`response`/`requestfailed` events (fetch/XHR plus document/script/image/media), buffered in the daemon. Reports method, URL, status, resource type, duration, and failures. No page shim needed (unlike the RN path).
  - `network request <url>` — issues the request through the browser context, so it shares the page's cookies/session.
  - `debug evaluate <expr>` — evaluates JS in the page runtime via Playwright and returns the value, for poking a canvas webtv app (e.g. Lightning) at runtime.

  Backed by new web-driver endpoints (`/networkLogs`, `/networkRequest`, `/evaluate`) and client methods. The RN/Metro behavior of all three commands is unchanged.

- 51c8d08: Support canvas-rendered webtv apps (Lightning/WPE/RDK) in the web driver.

  Such apps draw their whole UI into a single `<canvas>` and expose the scene graph through a DOM-inspector mirror of off-screen `<div>`s — the real identity lives in `data-testid` and the focused node is flagged `data-focused="true"` (the canvas owns `document.activeElement`, so normal focus detection can't see it). conductor's web hierarchy is built from Playwright's ARIA snapshot, which captures none of this.
  - The web `/viewHierarchy` now harvests the `data-testid`/`data-focused` mirror via a single `page.evaluate` and merges it into the hierarchy: each mirror node enriches the overlapping ARIA node (adding `testId` and focus), or is appended when the ARIA snapshot lacks it.
  - `id:`/`query:` selectors match the harvested `data-testid` in preference to the ARIA `ref`, so `tap-on --id sign-in-button`, `assert-visible --id …`, etc. target the conventional test hook.
  - `focused:` and `conductor focused` now reflect `data-focused`, making D-pad focus navigation observable.
  - `press-key` maps `Remote Dpad Up/Down/Left/Right/Center` onto `ArrowUp/Down/Left/Right/Enter` on web, so the TV remote drives focus on canvas apps.

  Drive TV apps at the app's native resolution (e.g. `set-viewport 1920 1080`); mirror bounds are reported in viewport CSS pixels, so off-screen nodes need the matching viewport. Normal accessible web is unaffected — the mirror pass is a no-op when no `data-testid`/`data-focused` is present.

### Patch Changes

- bd37f09: `capture-ui` now rejects a non-`.json` `--output` path. The command always emits a JSON bundle (the screenshot is embedded as base64), so passing an image path like `--output foo.png` previously produced an image-named file full of JSON. It now fails fast with a clear message pointing to `take-screenshot` for actual image files. Extensionless and `.json` paths are unchanged.
- cd6e04e: Auto-start the daemon when reading logs without one running. `conductor logs` (both `--recent` and streaming) previously relied on `getDriver()` to bring the daemon up, but `getDriver()` only spawns the daemon when the driver _port_ is closed. After the daemon idle-times-out while leaving the driver alive (e.g. tvOS deliberately keeps its runner up across daemon restarts), the port stays open but the daemon socket — which hosts the log collector — is gone, so log reads failed with "Daemon … is not responding". The command now explicitly ensures the daemon socket is up via the idempotent `startDaemon()` before connecting.

## 0.19.1

### Patch Changes

- 710f408: Fix `take-screenshot --id/--text/<query>` cropping the wrong region on retina iOS and 4K tvOS. The crop pipeline derived its AX→pixel scale from the synthetic root `axElement.frame`, which is always zero, so bounds in logical points were applied as pixel coordinates and the crop landed in the top-left quadrant. Scale is now sourced from `deviceInfo`, and `--margin` is interpreted in the same logical units as the bounds it pads. Also adds the missing `-o` shorthand for `--output`.

## 0.19.0

### Minor Changes

- 9a7b868: `screenshot` can now target a single element via `--selector` (or a positional selector argument), cropping the capture to that element's bounds. Adds a new `png-crop` helper for in-process PNG cropping, so no external image tooling is required.
- 98b5170: Restore app focus on tvOS via a new `RestoreFocusHandler` in the iOS driver, wired through the daemon and bootstrap so tvOS sessions can recover focus after backgrounding or navigation.

### Patch Changes

- 016ccb3: Make the blast radius of `launch-app --clear-state` and `--clear-keychain` explicit: clarified `--help` text, updated `docs/commands.md`, and added a one-line stderr warning when either flag is used. These flags drop the app's keychain items (signing the user out) and are easy to reach for as a debugging shortcut — the new messaging spells that out. No behavior change.

## 0.18.0

### Minor Changes

- 411a7e6: Add a `set-viewport` command for web sessions. Resize the Playwright browser to a preset (`mobile`, `tablet`, `desktop`) or explicit `width`/`height`, with optional device scale factor, mobile emulation, user agent, and color scheme. The current URL is preserved across the resize, so a single browser session can be screenshotted at multiple form factors without booting more devices.
- 2134af5: Add ephemeral `@eN` element refs. `capture-ui` now assigns each accessible element a short ref (`@e1`, `@e2`, …) and persists its screen coordinates per session, so `tap-on @e3` can act on the captured point directly without re-querying or fuzzy text/id matching. Stale snapshots (different device or older than 60s) emit an advisory warning rather than hard-failing.

## 0.17.0

### Minor Changes

- 8393269: Add `clipboard read` / `clipboard write` and `paste` commands for working with the device clipboard (iOS).
- 82dd69e: Add `crashes` commands (`list`, `show`, `tail`) to capture and stream iOS and Android crash reports.
- aae581e: Add experimental React Native tooling: `debug` (Hermes/Fusebox debugger — evaluate JS, component tree, element inspection), `network` (HTTP traffic logs and requests), and `profile` (CPU, memory, and React commit profiling).
- 10629a9: Add `flow record` commands (`start`, `finish`, `echo`, `status`) to capture a YAML flow while interacting with a session.
- f6a1cb7: Add `pinch`, `rotate-gesture`, and `gesture` commands for two-finger and arbitrary multi-touch gestures, backed by a new multi-finger gesture-path route in the iOS and Android drivers.
- d5cd58f: Add an `--at <x,y>` flag to `inspect` to query the UI element at a specific screen point.
- bfdbd8d: Add `metro stop` and `metro reload` commands for controlling the React Native Metro bundler.
- 6376d17: Add a `run-sequence` command that runs a JSON-described sequence of Conductor commands serially against one session, stopping on the first failure.
- 6376d17: Add a `workspace info` command that reports the detected project type, bundle IDs, devices, and Metro port.

### Patch Changes

- 72ac3ef: Speed up iOS replay. Simple selectors (a single plain text/id) now resolve through a direct runner query instead of dumping the whole view hierarchy, the hierarchy is briefly cached between commands, and `start-device` prewarms the driver so the first interaction no longer pays the XCTest startup cost. Vertical swipes are also lifted clear of the on-screen keyboard, and dropped text input is retyped automatically.

## 0.16.0

### Minor Changes

- 13f514e: Add `--full-page` flag to `take-screenshot` for the web platform. When set,
  the web driver passes `fullPage: true` to Playwright so the entire scrollable
  document is captured in a single image instead of just the viewport. The flag
  is a no-op on iOS/Android.

### Patch Changes

- 23534d1: Added a public documentation manifest plus six user-facing pages (Getting started, Concepts, Command catalogue, Flows, Web testing, Privacy). These power a new multi-page documentation site at houwert.dev/conductor/docs covering everything Conductor supports — including a complete privacy disclosure since the CLI sends no telemetry of any kind.
- b06bee9: Trimmed the public-facing docs to drop internal implementation details (driver languages, build hosts, exact npm registry URL paths) while keeping the user-relevant content — concepts, command catalogue, flow format, web testing, and the full privacy disclosure.
- a040cf1: Web driver now strips the `HeadlessChrome` marker from the browser's
  User-Agent before any context is created, so sites loaded through the
  web driver see a normal `Chrome` UA. Custom UAs passed to `setViewport`
  still take precedence.

## 0.15.0

### Minor Changes

- 6e0bf14: `conductor start-device --platform android` can now auto-create an AVD when one
  doesn't exist, mirroring the iOS `--device-type` flow. Pass `--avd <name>
--device-type <profile>` (e.g. `--device-type pixel_7`) and conductor will pick
  an installed system image for the host arch (`arm64-v8a` on Apple Silicon, else
  `x86_64`), filtered by `--os-version` if provided, then run `avdmanager create
avd` and boot it. `--system-image <id>` lets you override the auto-pick. If no
  matching system image is installed, conductor exits with the exact `sdkmanager`
  command needed to install one — no automatic multi-gigabyte downloads.

### Patch Changes

- b1ec5c2: Fix Android foreground-app detection on API 29+. The `dumpsys activity activities` regex only matched the legacy `mResumedActivity:` label; modern Android prints `ResumedActivity:` / `topResumedActivity=`, causing `conductor foreground-app` to fail with "Could not determine foreground app" and `conductor memory` (without an explicit app id) to silently fall back to system-only output. The regex now matches all three forms. As a side fix, `conductor memory` no longer requires the gRPC driver daemon to be running just to resolve the foreground app — it queries adb directly — and emits a clear note when no app can be resolved.

## 0.14.0

### Minor Changes

- 5552763: Expand `conductor memory` into a real cross-platform memory debugger.

  **New flags**
  - `--objects` — per-class object counts and bytes. iOS uses `heap`, Android pulls a `.hprof` heap dump and parses it inline (full HPROF binary parser handling standard JVM and Android ART extensions, both 4- and 8-byte ids, per-heap segmentation), Web takes a real V8 `HeapProfiler` snapshot via CDP and parses the node table by constructor.
  - `--leaks` — leak/unreachable detection. iOS uses `leaks`, Android uses `dumpsys meminfo --unreachable` (aggregated by user library frame so the actual leaking module surfaces above libc/libart). Both report total count + bytes broken down by class/owner.
  - `--save <name>` / `--diff <name> [--vs <other>]` / `--snapshots` — snapshot save and diff workflow under `~/.conductor/memory-snapshots/`. Diffs surface per-class deltas (Δ count, Δ bytes) sorted by absolute change so the suspect class floats to the top.
  - `--top <n>` — caps every table (default 20).
  - `--no-gc` — skip the pre-measurement GC on Web (default-on for `--objects` so transient allocations don't pollute class counts).
  - `--filter <regex>` — restrict object/class tables (and diff rows) to matching names; useful for cutting JVM/system noise.
  - `--growth-only` — diff output only shows positive deltas, the leak-hunting view.

  **iOS reporting**
  - Reports `Footprint` (jetsam-relevant phys footprint) and `Dirty` totals from the host `footprint <pid>` tool, ahead of RSS — these are the numbers iOS actually uses to OOM-kill apps, while RSS overcounts shared text pages.

  **Bug fixes**
  - iOS `vm_stat` is now run on the host instead of inside the simulator (the binary doesn't ship inside the simulator runtime).
  - iOS `vmmap` region parser was breaking on the `===` separator row and dropping every region; now correctly populates the region table.

  **Dump artifacts**

  `--objects` also writes the raw platform dump (`.hprof` for Android, `.heapsnapshot` for Web) to `~/.conductor/heap-dumps/` so it can be opened in Android Studio's Memory Profiler or Chrome DevTools for deeper analysis (retainer paths, dominator trees).

### Patch Changes

- 9faf5f7: Fix `list-devices` and `start-device` missing Android AVDs when the SDK isn't on PATH. Conductor now resolves `emulator`, `adb`, `avdmanager`, and `sdkmanager` from `ANDROID_HOME`/`ANDROID_SDK_ROOT` and the OS-default install locations (e.g. `~/Library/Android/sdk`), and surfaces a warning when `emulator -list-avds` fails so the failure isn't silent.

## 0.13.1

### Patch Changes

- 87d1d73: Fix conductor memory using stale session appId

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
