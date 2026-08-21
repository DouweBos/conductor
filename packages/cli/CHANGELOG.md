# @houwert/conductor

## 0.29.1

### Patch Changes

- 94586c0: Two bugs found running 0.29.0 against a Fire TV Stick 4K Max.

  **`profile frames` reported percentiles over a window with no frames.** With
  nothing drawn, `dumpsys gfxinfo` still prints percentiles, filled from the top
  histogram bucket — so a static screen reported `p50 4950ms … p99 4950ms`
  alongside `frames rendered: 0`. Read quickly that is catastrophic jank; the
  truth is that no frame existed. The platform percentiles and `jankyPercent` are
  now omitted entirely when `totalFrames` is 0, and a `no-frames` note says the
  app drew nothing and suggests why. This was the same principle the rest of the
  release already applied — absence must not be representable as a value — missed
  in the one path that took its numbers from the platform rather than computing
  them.

  **`profile js` failed outright on React Native's Fusebox backend.** It answers
  `Profiler.enable` with `-32601 Unsupported method` while implementing
  `Profiler.start` perfectly well, so enabling is now best-effort rather than a
  precondition. Without this the command could not start on any modern RN target.

  **`profile js` now reports where the sampled time actually went** before ranking
  anything: `namedJsPercent`, `gcPercent` and `idlePercent`. On real hardware a
  capture came back 69.7% in `[root]`, 30% in Hermes GC frames and almost nothing
  in named functions, which made the top-30 function table noise assembled from
  single-digit hit counts — while looking exactly like a normal ranking. Below 25%
  named-JS attribution the summary carries a `low-attribution` note explaining
  that a large empty-stack share is itself a result (the JS thread was idle when
  sampled, so JS is not the bottleneck) and that a large GC share is a memory
  finding to follow with `profile memory --track`, not a function ranking.

## 0.29.0

### Minor Changes

- 2cdd1f4: Adopt Qase's model for test cases, and remove test cases from the CLI.

  **This minor release removes commands.** Released as a minor rather than a
  major by choice; if you automate against `conductor cases`, read the
  breaking notes below before upgrading.

  A case is now a Qase case entity — `id`, `title`, `description`,
  `preconditions`, steps as `action`/`data`/`expected_result`, `suite_id`,
  `severity`/`priority`/`type`/`behavior`/`status`, `custom_fields` and a flat
  `tags` list — written to YAML with Qase's own field names and its enums spelled
  out rather than left as the integers the API sends. Conductor's homegrown fields
  (`userStory`, `altIds`, dimension-map `tags`, `owner`, `state`, `links`) are
  gone. The one non-Qase addition is a `conductor:` block holding what Qase has no
  concept of: the flow that implements the case, and each step's page object.

  Studio can now mirror cases from **Qase**. Set the datasource per project from
  the Cases toolbar, paste an API token (stored encrypted via Electron's
  `safeStorage`; `QASE_API_TOKEN` overrides it) and sync. Qase owns case content
  and wins on every sync, but the `conductor:` block is re-attached, a page object
  that could not be re-attached is reported rather than dropped, and a case Qase no
  longer returns is marked `deprecated` rather than deleted — deleting it would
  take its flow link with it. Qase-owned fields become read-only in the editor.
  Matrix columns come from a Qase custom field of your choosing, falling back to
  the suite. Projects left on `local` keep authoring cases in Studio as before.
  Results now carry Qase's shape (`case_id`, `status` including `invalid`,
  `time_ms`, `comment`, per-step statuses) plus `app_version`, so pushing them to a
  Qase test run later is a small addition rather than a remap.

  **Breaking:** `conductor cases` (`list`, `report --junit`, `result`) is removed,
  along with the `conductor-test-cases` skill — `conductor init --force` prunes it
  from repos that have it. The CLI is for device control and app debugging; test
  cases are Studio's, and Studio's MCP server is how an agent reaches them, now via
  `list_test_cases`, `describe_test_case`, `get_cases_datasource`,
  `sync_test_cases`, `scaffold_case_flow`, `link_case_flow` and
  `record_case_result`. `cases report --junit` has no replacement: it existed only
  to ingest a CI run, and Studio is a local test-engineering tool.

  **Breaking:** there is no migration. Existing case files and `results.jsonl`
  records are not read by this version.

- 764e310: Profiling that works on release builds and real TV hardware.

  **`profile frames`** (Android, incl. a physical Fire TV Stick over adb) parses
  `dumpsys gfxinfo <pkg> framestats` into jank rate, p50–p99 frame times and a
  per-frame phase breakdown — vsync delay, traversal, draw, sync, GPU issue,
  swap — so a jank spike can be attributed rather than just observed. `--track <s>`
  resets, samples and reports; because the on-device ring buffer only holds ~120
  frames it polls and merges by vsync timestamp to cover the whole window, and
  says so in a note when polling can't keep up rather than silently reporting the
  tail. `--save-baseline` / `--diff` / `--baselines` make before-and-after
  comparisons repeatable.

  **`press-key <key> --measure`** times input-to-response. It reports focus→move
  latency on every platform along with the cost of one hierarchy dump as an
  explicit error bar, and on Android also reports on-device input→frame latency
  taken from gfxinfo in nanoseconds, which excludes adb round-trip. `--repeat <n>`
  gives a distribution; focus identity is keyed on accessibility id plus bounds,
  not the visible label, so repeated TV row titles don't read as "no change".

  **`profile js`** runs the Hermes sampling profiler over the Metro CDP
  connection, ranking functions by self and total time with `file:line` and
  writing the raw `.cpuprofile`. `record --duration <s>` is one shot; `start` /
  `stop` bracket a flow you drive yourself, with a detached holder keeping the
  CDP session open in between.

  **`profile cpu --report`** runs `simpleperf report` on-device and returns a
  ranked symbol table, so the command yields something an agent can read instead
  of a binary `perf.data`.

  **`profile memory --track`** now reports heap growth over the window and, on
  Android, ART GC pause counts and durations scraped from logcat.

  **`run-flow --benchmark --repeat <n>`** runs a flow repeatedly and reports
  per-command p50/p90/stddev — TV run-to-run variance otherwise swamps the effect
  sizes worth chasing.

  **Fixed: `profile react` over-counted renders.** The injected hook walked the
  whole fiber tree each commit and recorded every fiber with a non-zero
  `actualDuration`. React does not clear that field on fibers it left alone, so
  stale durations were re-counted on every subsequent commit: the reported
  `renders` was really "commits in which this fiber had ever rendered" and
  `totalMs` was inflated. The hook now tracks a watermark of the highest
  `actualStartTime` seen and counts only fibers React began work on in that
  commit. The same fact — React only begins work walking down from the root — lets
  it prune, so the walk now costs the size of the rendered set rather than the
  size of the tree. Per-component self time is computed properly as a fiber's
  duration minus that of the children that rendered with it, and results sort by
  `selfMs` (additive) with `totalMs` kept as the subtree-inclusive figure.

  `profile react` also stops truncating silently: `--max-commits` and
  `--max-components` are configurable and the output carries `truncated`,
  `droppedCommits` and `droppedComponents`. `--json` now retains the per-commit
  timeline with timestamps and durations (`--timeline` adds per-commit component
  detail) so commits can be lined up against input events. On a release build,
  where React strips the timing instrumentation, it now fails with an explanation
  instead of reporting an empty result.

  Metro-backed commands auto-detect Metro's port from the device instead of
  assuming 8081, and an unreachable Metro now names the port it tried and how to
  override it. That covers `profile react`, `profile js`, `debug *`, `network`,
  `native-rn` and `metro reload`. `metro stop` deliberately keeps the literal
  8081 default: it kills whatever is listening on the port it resolves, and
  discovering one risks killing a Metro the user did not mean to stop.

  **Absence is now structurally distinguishable from a good value.** An empty
  `Distribution` reports `null` for every percentile rather than `0` — a missing
  measurement that reads as `0ms` reads as a _perfect_ one, and relying on every
  consumer to check `count` first is relying on the wrong thing. `hasSamples()`
  narrows the type where a real number is required. `profile frames` reports
  `inputLatency` only when frames actually carried input timestamps, and says so
  in a note when they did not.

  **`press-key --measure` no longer conflates a boundary with a hang.** Focus
  correctly declining to move at the end of a rail used to look identical to a
  3000ms timeout, which would have manufactured evidence of the sluggishness the
  command exists to find. Samples now carry
  `outcome: 'moved' | 'unchanged' | 'query-failed'`, and only `moved` samples feed
  the latency figures. Repeats are also no longer assumed to be repeated
  measurements of one event — pressing Right twenty times walks twenty _different_
  transitions, so results are grouped by the transition actually performed, with
  `--sequence` to oscillate between two positions instead of drifting across the
  UI. On Android it adds `pressToFrame`, computed entirely from device-side
  clocks, and flags the polling-based figure as transport-bound when one focus
  query costs more than the latency it is timing.

  **Structured notes.** `notes` on frame and latency reports are now
  `{code, message, ...}` rather than prose, so a caller can branch on `poll-gap`
  and re-run at the reported `suggestedIntervalMs` instead of string-matching
  wording that may change.

  **Frame diffs carry polarity and significance.** Each row reports `better`
  (`lower`/`higher`/`neutral`) and a `verdict`, so a consumer needn't hardcode
  that more `totalFrames` in a fixed window is an improvement while more
  `jankyFrames` is not. `profile frames report --track N --repeat M` captures M
  windows and records their spread, and a baseline holding that spread lets
  `--diff` mark a delta `significant: false` when it sits inside the noise.

  **Phase attribution travels with the numbers.** Reports name the phase driving
  the worst frames and, separately, the phase every frame pays for — measurement
  on real hardware showed these are often different, and reporting only the first
  would have pointed at an intermittent 16ms vsync delay while a steady 13ms
  texture upload went unmentioned.

  **Clock anchor.** Frame reports carry a `clockAnchor` reading the device's
  monotonic and realtime clocks in a single adb invocation, so its accuracy is
  bounded by on-device dump time (±16ms measured) rather than by network
  round-trip. Frames carry `atDeviceRealtimeMs`, directly comparable to the
  timestamps `profile react` records, which is what allows a specific dropped
  frame to be attributed to a specific React commit.

  Defaults and documentation are now measured rather than assumed, on a Fire TV
  Stick 4K Max and an NVIDIA SHIELD: `--track --interval` defaults to 1000ms
  (100% frame coverage on a saturated Stick, versus 66% at 3000ms), and
  `docs/tv-performance.md` records adb transport costs, the ~713ms on-device cost
  of `adb shell input keyevent`, and the device-dependence of `NewestInputEvent`.

  `press-key --measure` on Android now injects inside the device-side bracket and
  timestamps the press _after_ the injection returns. `adb shell input keyevent`
  costs ~713ms on the device because it spawns an `app_process` JVM per call, and
  that cost lands before the event is dispatched — timestamping beforehand
  attributed all of it to the app. It also reports a `driver-perturbation` note
  carrying the measured injection cost, because spawning a JVM beside the frames
  being measured is load on exactly the resources a memory-constrained TV is
  short of, and `pressToFrame` can exclude the startup time but not the
  contention.

  `profile frames report --track` announces the measurement window on stderr when
  stderr is a terminal, so a person driving the physical remote can synchronise
  with it. That path matters more on TV than it sounds: focus moves one discrete
  step per keypress with no momentum, so unlike mobile there is no way to capture
  navigation frames without something driving input — and a human with the remote
  is the only input path that applies no load of its own.

## 0.28.0

### Minor Changes

- eab890e: `list-devices` now reports a `formFactor` for Android devices (`tv` or
  `handset`), read from `ro.build.characteristics` for booted devices and from the
  AVD name for available ones. Android reports TVs, phones and tablets alike as
  `android`, so nothing downstream could tell them apart — a TV test could be sent
  to a phone emulator. Studio uses it to pick the right device for a flow and to
  offer tvOS and Android TV as separate choices.
- eab890e: Turn Studio's test cases from a read-only matrix into test case management:
  authoring, structured steps that name the page object automating them (so a flow
  can be scaffolded from a case and checked against it), an execution log fed by
  flow runs, manual verdicts, the agent and CI, test plans that run a selection on
  a device, and CSV import/export. Cases and results live under
  `~/.conductor/studio`, not in the repo under test, and results are local only —
  there is no CI sync. Adds `conductor cases
list | report | result` so CI can file JUnit results without Studio running.
- eab890e: Let a long-running client hold a device reservation. `device-pool --acquire`
  stamped the claim with the CLI's own PID, and conductor frees claims whose owner
  has exited — so the reservation was gone the instant the command returned, and
  nothing could actually reserve a device. It now takes `--owner <pid>` to hold the
  claim for a process that sticks around, and `--device <id>` to claim a specific
  device instead of any free one, failing if someone else holds it.

  Conductor Studio uses this: an agent reserves its device for the length of the
  session and releases it however the session ends, refuses to start on a device
  another agent holds, and marks reserved devices in the picker.

### Patch Changes

- eab890e: Tag CLI releases `cli-v<version>` instead of `v<version>`, so the conductor
  repo's release list stays legible now that Conductor Studio publishes
  `studio-v<version>` releases alongside them.

  The driver bootstrap downloads `drivers.tar.gz` from its own release tag, so it
  moves in lockstep — a release builds that file and cuts its tag from the same
  commit. Already-published versions are unaffected: they keep fetching the
  unprefixed tags, which stay where they are.

- eab890e: Fix `device-pool --acquire` handing back a device the caller already holds when
  asked for any free device. Re-claiming stays idempotent when the device is named
  with `--device`, which is how Studio's reservations work, but an unqualified
  acquire now only returns a genuinely free device — otherwise two parallel runs
  by the same owner land on one screen.
- eab890e: Flow runs now reserve their device too, not just agent sessions — a run sharing a
  device with another agent tests whatever that agent left on screen. Claims are
  counted, so an agent and a run on the same device share one claim and the device
  is only released when the last of them finishes. `device-pool --acquire` is also
  re-entrant: re-claiming a device you already hold succeeds instead of reporting a
  conflict with yourself.
- eab890e: Fix `pressKey` in flows on tvOS. `conductor press-key "Remote Dpad Up"` routed
  remote keys to `pressButton`, but the flow runner didn't — a `pressKey` step
  fell through to the software-keyboard path, which tvOS doesn't have, so the step
  silently did nothing. Remote keys now reach `pressButton` on tvOS, `Enter` maps
  to Select, `Escape`/`Back` to Menu, and a key tvOS has no button for now fails
  loudly instead of no-opping.

## 0.27.2

### Patch Changes

- 42b83f5: Split the native in-process instrument out of the `conductor-inspect` skill into
  a new `conductor-native` skill. `conductor-inspect` now covers only external
  observation (accessibility snapshots, screenshots, `@eN` refs) and assertions;
  `conductor-native` owns the `--inject` + `native-*` commands for native
  inspection **and** live editing (set view properties, force appearance/RTL, run
  Swift). Cross-references in `conductor-device-setup` and `conductor-metro-debugger`
  updated. Consumers get the new skill (and pruning of the moved content) on the
  next `conductor init --force`.

## 0.27.1

### Patch Changes

- 9864b0c: Support `config.yaml` path aliases in Maestro flows. A `file:` reference of the
  form `@alias/rest` (in `runFlow`, `runScript`, or `addMedia`) now resolves via a
  `paths:` map in the nearest `config.yaml` walking up from the flow file, matching
  the plexinc/maestro fork. Non-alias paths are unchanged (relative to the flow
  file, or absolute).

## 0.27.0

### Minor Changes

- 9007bc9: Add Maestro-parity commands and coordinate tapping:
  - `tap-on --at <x,y>` taps a raw coordinate (px, `%`, or `0-1` fraction), plus
    `--repeat <n>` / `--delay <ms>` on any tap.
  - `copy-text-from <element>` prints an element's text (and copies it to the iOS clipboard).
  - `assert-true <expr>` asserts a JavaScript expression in the flow sandbox (no device).
  - `assert-screenshot <reference.png>` does visual-regression comparison against a
    baseline (`--threshold`, `--update`; writes a `.diff.png` on mismatch).
  - `set-permissions <perm=value>...`, `add-media <path>...`, `set-airplane-mode`
    / `toggle-airplane-mode` (Android), and `travel <lat,lng>... [--speed]` surface
    existing driver capabilities as first-class CLI verbs.
  - `record-video start|stop` records a screen video (iOS via simctl, Android via
    screenrecord) — distinct from `flow record`, which records a YAML flow.

## 0.26.0

### Minor Changes

- 386fe08: Add a conductor-owned live device video stream. A per-device WebSocket in the
  daemon (`conductor stream-server`, port base 8075, reported as `streamPort` in
  daemon `/status`) emits a low-latency H.264 stream with multi-subscriber fan-out
  (one capture, N viewers). On connect the server sends a JSON `config` frame
  (codec, dimensions, SPS/PPS/avcC) then binary H.264 Annex B access units,
  keyframe-led; a late subscriber gets the cached config + keyframe immediately.

  iOS/tvOS capture is a new host-side binary (`packages/ios-capture`) that captures
  the Simulator framebuffer via SimulatorKit and VideoToolbox-encodes H.264, mirroring
  the streaming `input-server`. Android/web are follow-ons. See
  `docs/device-video-stream.md`.

## 0.25.0

### Minor Changes

- 6b2ba8e: Add in-process native inspection for iOS and tvOS simulators. `launch-app --inject`
  injects a dylib into the target app via `DYLD_INSERT_LIBRARIES`, then `native-inspect`
  returns the real UIView/CALayer tree (resolved component colors, fonts, text, corner
  radii, borders, shadows, gradients) and `native-nav` returns the view-controller
  hierarchy (navigation stacks, tab selection, presented controllers). `native-screenshot`
  renders the key window to PNG and `native-image <x,y,w,h>` extracts any component as a
  PNG by its window-absolute frame (`absFrame`, included on every inspect node) — works for
  UIKit, React Native Fabric, and custom renderers. `native-ping` checks the injected server
  is alive.

  Reveal-style runtime inspection is also included: every inspect node has a stable `id`, and
  `native-view <id>` returns full property detail, `native-set <id> <key> <value>` live-edits a
  view (alpha, colors, cornerRadius, frame, text, …) on the running app, `native-constraints`
  dumps Auto Layout + ambiguity, `native-hittest <x,y>` selects the view at a point, `native-find`
  searches by class/text, and `native-highlight` flashes an overlay on the device.
  `native-snapshot <id>` renders a single view's own content in isolation (subviews hidden,
  transparent elsewhere) — the per-layer texture for a 3D exploded-view inspector — and each
  inspect node carries `depth`/`z`/`transform3D`/`maskedCorners`/`rn` for stacking planes.

  Also adds runtime + diagnostics inspection: arbitrary KVC get/set, class metadata
  (properties/ivars/methods), responder chain, gesture and target-action dumps, appearance
  toggles (dark/light, RTL, Dynamic Type, animation freeze), SwiftUI tree, UserDefaults /
  Keychain / cookies / sandbox files, a live-object heap browser (malloc-zone scan), and
  stdout/stderr + HTTP capture. Exposed via `native-raw <path>` plus wrappers
  `native-console`, `native-network`, `native-heap`, `native-appearance`, and a batch
  `/snapshots` endpoint that returns every layer texture in one call. `native-eval` is the
  escape hatch — it compiles arbitrary Swift to a dylib and runs it inside the app (full
  UIKit / ObjC-runtime access) for anything no fixed endpoint covers.

  This reaches native detail the external XCUITest driver can't see. New native package
  `packages/ios-inproc`.

- 87b017c: Add a streaming device-input server so conductor owns interaction injection. A
  persistent per-device WebSocket (loopback, one per daemon) accepts normalized
  pointer/key/text/button/scroll/tvremote frames and injects them via the existing
  iOS XCUITest and Android gRPC drivers — conductor owns coord→device translation
  and keymaps. `conductor input-server` starts it (if needed) and prints the
  WebSocket URL; the daemon `/status` reports `inputPort`.

  Live open-ended drags are buffered `down → move… → up` and replayed as one
  gesture on `up` (XCUITest's `_XCT_synthesizeEvent` is atomic and can't hold a
  touch across frames); consecutive moves coalesce so a fast drag never backs up
  the injector, and phase transitions are never dropped. Multitouch, hardware
  buttons, keyboard, and the tvOS remote route straight to the driver, and iOS
  input reaches SpringBoard with no app attached.

  New optional package `packages/ios-hid` ports the CoreSimulator/IndigoHID
  touch-continuity path (host-side) as a held-touch backend for live drags with
  mid-gesture animation; enabled with `CONDUCTOR_IOS_HID=1` when built, otherwise
  the buffered path is used.

## 0.24.1

### Patch Changes

- bb0ecfb: Fix `start-device --platform android` OOM-killing heavy React Native debug
  builds on auto-created AVDs. Stock TV device profiles (`tv_1080p`, `tv_4k`,
  `tv_720p`) default to 1024MB RAM, so Android's `lowmemorykiller` SIGKILLs the app
  during JS bundle load. After creating an AVD, conductor now raises its
  `config.ini` `hw.ramSize`/`vm.heapSize` to a 4096/512MB floor (written as plain
  integers — an `M` suffix makes the emulator silently fall back to 1024MB). Only
  ever raises, so higher existing values are kept, and only at creation time —
  never an AVD the user already had. A new `--memory <mb>` flag overrides the
  floor.
- 7ea5e1f: Fix `focused`/hierarchy mis-reporting on canvas TV apps (Lightning/WPE/RDK). The
  canvas scene-graph mirror was merged into the ARIA tree by **bounds overlap**, so
  with an overlay open (e.g. a drawer) a real-DOM item overlapping a focused tile
  could steal the tile's focus — and even its `data-testid` identity. `conductor
focused` then reported the wrong element.

  Focus and identity now ride `data-testid`, read natively from each element, and
  are joined to the tree by identity instead of geometry: a scene node enriches /
  focuses the tree node that _is_ it, and canvas-only nodes are surfaced on their
  own. The focus path's deepest `data-focused` node wins. Plain DOM apps are
  unaffected — when no canvas mirror is present, focus still comes from ARIA
  `[active]` / `document.activeElement`.

## 0.24.0

### Minor Changes

- d4d1db7: Discover external CDP endpoints automatically. Previously an already-running
  browser exposing a remote-debugging port (e.g. an Electron app started with
  `--remote-debugging-port`, one page target per webview/tile) could only be
  attached to by passing `--cdp-url`/`--cdp-target` explicitly. Now `list-devices`
  scans the conventional localhost debugging ports (9222–9229) and surfaces each
  `type=page` webview as a booted `web:cdp:<port>:<targetId>` device.

  The device id is self-describing, so a discovered webview is drivable with no
  `--cdp-*` flags — `conductor --device web:cdp:9222:<targetId> <cmd>` hydrates the
  CDP url and target from the id itself. `web-targets --cdp-url <url>` still lists
  targets for endpoints on non-default ports. Port probes run in parallel with a
  short timeout and swallow errors, so discovery adds negligible latency when no
  CDP endpoint is present.

## 0.23.0

### Minor Changes

- 1611258: Support long-pressing tvOS remote buttons via `press-key`. Add `--long-press`
  (holds ~1.5s, matching `tap-on`) and `--duration <seconds>` for a custom hold
  time — e.g. `conductor press-key "Remote Dpad Center" --long-press` to trigger
  held-Select behaviors like icon-jiggle/edit mode on the Apple TV home screen.

  Implemented by threading an optional duration through `pressButton` to the
  tvOS driver's `XCUIRemote.shared.press(_:forDuration:)` overload. Only applies
  to tvOS remote buttons; ignored elsewhere. (Requires a rebuilt tvOS driver to
  take effect on-device.)

- 46c7ae6: Add Vega (Amazon Fire TV) as a fifth platform, alongside iOS, Android, tvOS, and
  web. Vega is a React Native (Hermes) OS driven host-side through Amazon's
  `vega`/`kepler` CLI plus the on-device automation toolkit — there is no driver
  process or control port. `conductor start-device --platform vega` boots a Vega
  Virtual Device (VVD) via `vega virtual-device start` (or attaches to a running
  one; `--name <vvd>` selects a specific device); devices appear in `list-devices`
  as `vega:<serial>`.

  D-pad remote navigation works via `press-key "Remote Dpad …"`, and coordinate
  `tap-on`/`swipe`/`scroll` work via the stock `inputd-cli`. `inspect`/`capture-ui`
  reuse the Android element resolver — the toolkit page source is re-emitted as
  uiautomator XML. `screenshot`, `input-text`, and app launch/stop/install are
  supported. Device + Metro logs are collected by a logs-only daemon (React Native
  Metro/profiler attach over Hermes). Deep links, `set-location`, gestures, screen
  recording, clipboard, and `clear-state`/`uninstall-app` are unsupported and fail
  with a clear message.

  The Vega SDK CLI must be installed and on `PATH` (or set `CONDUCTOR_VEGA_CLI`);
  the VVD's developer mode must be enabled for input, and apps under test should be
  launched via conductor so the automation toolkit attaches.

## 0.22.0

### Minor Changes

- 8e86c40: Add `web-targets` and `--cdp-url` / `--cdp-target` for driving an existing
  browser over CDP.
  - `web-targets --cdp-url <url>` lists the controllable page targets a browser
    exposes over its remote-debugging endpoint (e.g. one per Electron
    `WebContentsView`), each with a ready-to-paste bind command. Reads the
    DevTools `/json/list` endpoint directly — no Playwright needed, works before
    any session exists.
  - `--cdp-url` / `--cdp-target` set the CDP attachment for a web session and
    persist it to the session, so after binding a `--device` to a target once,
    later commands for that device no longer need the flags. Use a distinct
    fully-qualified `--device web:<browser>:<label>` per target to drive several
    concurrently.

### Patch Changes

- 5a13c01: Fix `metro reload --device` reloading the wrong device (or silently no-op)
  when multiple apps share one Metro server.
  - Device matching is now tolerant of the suffixes Metro appends to the model
    name — Android's `ro.product.model` is `Chromecast` while Metro reports it as
    `Chromecast - 14 - API 34`, so the exact-match lookup never matched and the
    reload fell through to the first target (e.g. an Apple TV) while reporting
    success.
  - A device-scoped reload that can't find its device now errors and lists the
    available targets instead of silently reloading a different one. Use
    `--target <index>` to pick one explicitly.

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
