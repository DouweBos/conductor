# Plan: experimental iOS dylib driver

Status: proposal
Owner: TBD
Last updated: 2026-05-18

## Goal

Add an opt-in experimental iOS driver that injects a small dylib into
the target app and serves a narrow set of **interaction routes**
in-process. The motivation is lower per-call latency and more reliable
text input vs. the current XCUITest-based driver, without changing any
user-visible behavior beyond those routes.

The XCUITest driver continues to run alongside, unchanged, and serves
every route the dylib does not own. Users opt in per session via
`--ios-driver dylib`.

## Non-goals

- New inspection capabilities (background color, fonts, layer
  properties, etc.). The dylib unlocks them in theory, but they are
  explicitly out of scope for this iteration.
- Replacing the XCUITest driver. The two coexist.
- Network capture, SpringBoard-level features, hardware-button
  (`pressButton`) handling. All deferred.
- tvOS and physical iOS devices. iOS simulators only.

## Routes the dylib owns

Five interaction routes, mapping 1:1 to the methods on `IOSDriver`
in `packages/cli/src/drivers/ios.ts`:

- `tap`
- `swipe`
- `gesturePath`
- `inputText`
- `pressKey`

Every other route — `viewHierarchy`, `screenshot`, `deviceInfo`,
`launchApp` / `terminateApp`, permissions, location, orientation,
recording, clipboard, `isScreenStatic`, etc. — continues to be served
by the existing XCUITest driver.

## Architecture

Two drivers coexist on the booted simulator:

1. **XCUITest driver** (today's) — unchanged. HTTP server on the
   existing base port (1075).
2. **`libConductorInject.dylib`** (new) — loaded into the target app
   via `DYLD_INSERT_LIBRARIES`. On constructor:
   - Reads `CONDUCTOR_DYLIB_PORT` from env.
   - Opens a TCP HTTP listener on `127.0.0.1:<port>` from inside the
     app process (simulator processes share the macOS network stack).
   - Serves the five routes with the same JSON contract as the
     XCUITest equivalents.

When the CLI is invoked with `--ios-driver dylib`, `IOSDriver` routes
the five interaction routes to the dylib port and everything else to
the XCUITest port as today. The HTTP request/response shapes are
unchanged, so no consumer (a11y enrichment, element resolver, flow
runner, recorded flows, Argus) sees any wire-level difference.

### Injection mechanism

`simctl spawn <udid> launchctl setenv DYLD_INSERT_LIBRARIES <dylib-path>`
sets the env var in the simulator's launchd. Every app launched
*after* this call gets the dylib injected automatically. Borrowed
from Argent's approach — Conductor does not need to own the launch
path for coverage to apply.

Also set: `CONDUCTOR_DYLIB_PORT=<port>` (per device, from
`~/.conductor/ports.json`, base 1076).

### Already-running apps

Apps that were already running when the driver started have **no
dylib loaded**. For the five interaction routes, `IOSDriver` falls
back transparently to XCUITest if no dylib has registered for the
foreground bundleId. `daemon-status` surfaces a "no dylib loaded —
restart-app to enable in-process routes" hint per running app.

### Build & packaging

- New workspace package `packages/ios-dylib/` containing the Xcode /
  Swift Package project for the dylib.
- Universal `iphonesimulator` binary, adhoc-signed
  (`codesign -s -`) by the build script.
- Bundled into the CLI distribution under
  `packages/cli/drivers/ios-dylib/libConductorInject.dylib`.
- Cached on first use at `~/.conductor/ios-dylib/` (mtime-keyed,
  matching the XCUITest cache pattern in `bootstrap.ts`).
- Wired into `make package-cli`.

### Flag plumbing

- CLI flag: `--ios-driver xctest|dylib` (default `xctest`).
- Env: `CONDUCTOR_IOS_DRIVER=dylib`.
- Persisted in the daemon session record alongside `driverPort` and
  `driverPlatform`. Subsequent commands in the same daemon honor the
  choice without re-passing the flag.
- `daemon-status` shows the active impl and, when `dylib`, the list
  of registered bundleIds.
- Switching impls within an existing daemon requires `daemon-stop`
  first; the daemon errors out clearly rather than swapping
  mid-flight.

## Backwards-compatibility risks

Because the dylib only handles five routes and the XCUITest driver
keeps serving everything else, the risk surface is small.

1. **`inputText` behavior change (intentional).** Moving from
   simulated-keyboard typing to `[firstResponder insertText:]` removes
   autocorrect, smart-quote substitution, predictive-bar artifacts,
   and per-keystroke `shouldChangeCharactersInRange:` deliveries.
   Most flows benefit; OTP-style flows that watch keystroke timing
   may behave differently. Document in flag help and changelog. The
   dylib must `becomeFirstResponder` on the target field before
   inserting; fall back to HID if no responder is set.
2. **`tap` / `swipe` / `gesturePath` fidelity.** Synthesizing
   `UIEvent`s in-process bypasses parts of the system gesture
   pipeline (3D-touch, edge-pan recognizers, multi-window
   arbitration). Invisible for the overwhelming majority of taps but
   a real difference vs. CoreSimulator HID. Allow per-route fallback
   to XCUITest if a specific app surfaces problems.
3. **Stale-process routes.** Apps launched before the driver came up
   have no dylib loaded. Fallback to XCUITest is transparent;
   `daemon-status` surfaces the state so users know that restarting
   the app enables the fast path.
4. **Port allocation.** New base port 1076 added to
   `~/.conductor/ports.json`, allocated per device alongside 1075.

Risks intentionally not in scope (would only matter if the dylib
expanded to inspection): view-hierarchy shape drift, settle-timing
divergence, system-dialog visibility, tvOS branching.

## Phases

1. **Dylib skeleton.** Xcode project for
   `libConductorInject.dylib`, iphonesimulator target, adhoc-signed.
   Constructor opens TCP listener on `$CONDUCTOR_DYLIB_PORT`, logs
   registration. Bootstrap injects via
   `simctl spawn <udid> launchctl setenv DYLD_INSERT_LIBRARIES <path>`
   plus `launchctl setenv CONDUCTOR_DYLIB_PORT <port>`. Verify "hello"
   with a hand-launched test app.
2. **Routes.** Implement `tap`, `swipe`, `gesturePath`, `pressKey`,
   `inputText` against the same JSON shapes XCUITest uses today.
   `IOSDriver` swap is a one-line URL change per method.
3. **Flag plumbing.** `--ios-driver dylib`, daemon session record,
   fallback-to-XCUITest when the foreground bundleId has no dylib
   registered, `daemon-status` field.
4. **Parity test.** Run the existing E2E suite under
   `--ios-driver dylib`. Capture per-route latency deltas vs.
   XCUITest as a side artifact.
5. **Documentation.** Add a **Dylib** support column to the
   Interaction table in `docs/commands.md`, marking each row by
   which of the five dylib routes it uses (✅ fully served, ◐ uses
   the dylib for the interaction step but composes with an XCUITest
   step like inspection or clipboard, — XCUITest-only). Include a
   short legend below the table explaining the flag, the
   iOS-sim-only scope, and the relaunch requirement for
   already-running apps. Update any agent-facing reference (CLAUDE.md
   / skills) that re-lists these commands.

## Open questions

- Naming: `--ios-driver dylib` vs. `--ios-driver experimental` vs.
  `--ios-driver core-sim`. Current proposal is `dylib`.
- Per-route XCUITest fallback knob: implicit on registration miss
  only, or also a `--fallback-on-error` mode for fidelity issues?
  Defer until phase 4 reveals real failures.

## Phase 6: host-side sim-driver

Status: implemented
Last updated: 2026-05-18

### Why this phase exists

Phase 1–5 shipped the dylib for five routes: tap, swipe, gesturePath,
pressKey, inputText. In practice the four HID-class routes (everything
except inputText) silently no-op for React Native, SwiftUI, and any
view that handles raw touches. The dylib synthesizes `UIEvent` in
process; real touch dispatch happens at the HID layer in
`backboardd` / `CoreSimulator`, which the in-process dylib can't reach
without private SPI it doesn't link.

Argent (software-mansion/argent) hit the same wall and solved it the
same way every other open-source iOS-sim automation stack solves it:
ship a **host-side binary** that drives HID events into the named
SimDevice via the private `CoreSimulator.framework` + IOKit's
`IOHIDEvent*` API. Conductor follows suit.

### Architecture pivot

The previous "dylib does everything experimental" model splits in two:

- **`conductor-sim-driver`** (new) — host macOS binary, one process per
  UDID. Listens on `127.0.0.1:<port>` (base 1500). Owns the five
  HID-class routes (`/touch`, `/swipeV2`, `/gesturePath`, `/pressKey`,
  `/pressButton`). Synthesizes real digitizer / keyboard events through
  `SimDevice.io` → `IOHIDEvent*`. Unconditional on iOS sessions — not
  gated by `--ios-driver dylib`.
- **`libConductorInject.dylib`** (unchanged) — opt-in via
  `--ios-driver dylib`, in-process. Now owns exactly one route:
  `inputText`, where the in-process `[firstResponder insertText:]`
  approach genuinely beats HID-level keystroke synthesis. The dylib's
  tap/swipe/etc. handlers stay in the codebase but are no longer wired
  to from the CLI — they're dead code, kept for now to avoid churn.

The CLI's `IOSDriver` ends up with two optional ports: `simDriverPort`
(set whenever the sim-driver is running) and `dylibPort` (set when
`--ios-driver dylib` is active). HID routes try sim-driver first,
fall back to XCUITest on any error. `inputText` tries dylib first,
falls back to XCUITest. The dylib is **never** in the HID fallback
chain — that would just add latency for no payoff.

### Packaging and lifecycle

- New workspace package `packages/ios-sim-driver/` (Swift Package).
  Produces a universal macOS binary (`arm64 + x86_64`), adhoc-signed,
  written to `packages/cli/drivers/ios-sim-driver/conductor-sim-driver`.
- Cached on first use at `~/.conductor/ios-sim-driver/` (mtime-keyed,
  matching the dylib and XCUITest cache patterns).
- Wired into `make build` and `make package-cli` next to
  `build-ios-dylib`.
- Spawned by the daemon for each iOS session at startup, killed on
  daemon-stop (PID tracked at
  `~/.conductor/daemons/<udid>/sim-driver.pid`).
- Failure to start is non-fatal — the daemon logs the error and serves
  HID routes through XCUITest. `daemon-status` surfaces the port (or
  the failure) for triage.

### Private API surface

The sim-driver depends on a handful of selectors / functions that are
private to Apple. Listed here so future Xcode upgrades can grep for
ABI drift:

- `+[SimServiceContext sharedServiceContextForDeveloperDir:error:]`
  (or `serviceContextForDeveloperDir:error:` on older Xcode).
- `-[SimServiceContext defaultDeviceSetWithError:]`
- `-[SimDeviceSet devicesByUDID]`
- `-[SimDevice io]` (or `deviceIOClient` / `ioClient` — probed in
  order).
- `-[SimDeviceIOClient performIO:]` (or `enqueueIOHIDEvent:`).
- `IOHIDEventCreateDigitizerFingerEventWithQuality`
- `IOHIDEventCreateDigitizerEvent`
- `IOHIDEventCreateKeyboardEvent`
- `IOHIDEventAppendEvent`

The Obj-C selectors are dispatched dynamically via `NSClassFromString`
+ `objc_msgSend`. The IOHIDEvent functions are resolved at runtime via
`dlsym`. Missing symbols surface on `/status` (`error` field) so the
CLI can fall back to XCUITest cleanly instead of crashing the daemon.

### Risks

1. **Private SPI drift.** Every Xcode release is a chance the
   selectors get renamed. Runtime resolution + clean fallback contains
   the blast radius.
2. **Parallel-execution port allocation.** Sim-driver gets its own
   range (1500+) in `~/.conductor/ports.json` under
   `simDriverAssignments`, mirroring how the dylib uses `dylibAssignments`.
   Multiple daemons → multiple sim-driver processes → no port
   collisions.
3. **Tvos.** Out of scope. The daemon doesn't allocate a sim-driver
   port on tvOS sessions; the CLI's IOSDriver only gets a sim-driver
   port from `daemon-status` for iOS.
