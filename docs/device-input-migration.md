# Plan: device-input migration — conductor as sole input owner

Status: **Implemented (iOS + Android streaming; iOS HID injector opt-in).** This doc is
the conductor-side counterpart to `plan/device-interaction-migration.md` in the Argus
repo. It began as the P0 audit + protocol design; the system described in Parts 3–4 is now
built. It delivers: (1) an audit of conductor's existing device-input surface, (2) a gap
analysis vs the Argus command set with the injection-mechanism verdict, (3) the
streaming-socket protocol, and (4) the implementation.

## What shipped

- **Input WebSocket server** in the daemon (`src/daemon/input-server.ts`), one per device,
  loopback; frame types + capability handshake in `input-protocol.ts`; per-connection
  routing + pointer buffering in `input-router.ts`; platform backends (coord/keymap
  ownership) in `input-backends.ts`. Port allocated via `getInputPort` (base 7075),
  reported in daemon `/status` as `inputPort`.
- **CLI**: `conductor input-server` starts it (if needed) and prints the WebSocket URL.
- **iOS/tvOS + Android** backends route to the existing XCUITest / gRPC drivers. Live
  open-ended drags buffer `down→move…→up` and replay as one gesture on `up`
  (`liveDrag:"buffered"`); moves coalesce; phase transitions never drop.
- **Optional native HID** (`packages/ios-hid`): ported CoreSimulator/IndigoHID
  touch-continuity path as a held-touch backend for live iOS drags, enabled with
  `CONDUCTOR_IOS_HID=1` when built (`liveDrag:"native"`); otherwise buffered.
- **Tests**: `packages/cli/tests/input-streaming.test.ts` (protocol decode, router
  tap/drag/multitouch/cancel, coord+keymap translation, WebSocket handshake + coalescing).
  Validated live against an Android emulator (handshake + tap + home injection).

## Background / locked decisions (from the Argus migration plan)

- **Scope = input only.** Conductor takes over interaction injection (taps, drags,
  keyboard, hardware buttons, remotes). Argus keeps its video capture. On iOS, capture
  and input currently share one process in Argus (`argus-sim-bridge`); only the input
  half moves.
- **Transport = one persistent per-device streaming socket.** Argus opens a long-lived
  socket per active device and streams pointer/key/button frames through it (not
  per-event HTTP), so continuous drags/scrolls and fast typing stay low-latency. Web
  input (conductor REST) is the delegation reference, but its per-event HTTP transport is
  explicitly *not* copied for iOS/Android.
- **Rollout = phased with capability fallback.** iOS first, then Android; Argus falls
  back to its current native path when conductor can't handle an action or the socket is
  down.

---

# Part 1 — Audit: conductor's current input surface

## 1.1 iOS / tvOS — XCUITest test-runner over loopback HTTP

**Mechanism.** Conductor injects iOS/tvOS input through a **WebDriverAgent-derived
XCUITest runner** that runs *inside* the simulator as a detached
`xcodebuild test-without-building` process and exposes a **FlyingFox HTTP/JSON server** on
`127.0.0.1:<port>` (iOS base **1075**, tvOS base **2075**, per-device incrementing;
`bootstrap.ts:73-74,140`). Simulator apps share the host loopback, so the CLI reaches the
in-simulator server directly. Every gesture is synthesized via the **private XCTest event
pipeline** — `XCTRunnerDaemonSession.sharedSession().daemonProxy` →
**`_XCT_synthesizeEvent:completion:`**, building `XCSynthesizedEventRecord` +
`XCPointerEventPath` objects (`RunnerDaemonProxy.swift:8-18,36-50`,
`EventRecord.swift:15-17`, `PointerEventPath.swift:5-13`). This is **XCUITest-level**, not
IndigoHID/CoreSimulator-private, not `simctl`/`idb`. `simctl` is used only for
side-channels (launch-with-env, install, TCC, location, clipboard, media, video, openurl).

**Invocation model.** Persistent, per-device. A host daemon (`daemon/server.ts`, Unix
socket `~/.conductor/daemons/<sessionName>/daemon.sock`) manages *lifecycle only* — it
starts/health-checks/restarts the runner every 10s. Input traffic **bypasses the daemon
socket** and goes straight to the driver's HTTP port (`runner.ts:162-175`). PORT is
injected into the xctestrun plist via `plutil` and read as
`ProcessInfo.environment["PORT"]` (`bootstrap.ts:521-527`, `XCTestHTTPServer.swift:33-34`).

**Command surface** (`IOSDriver`, `src/drivers/ios.ts`):

| Driver API | Route | Backend |
|---|---|---|
| `tap(x,y,duration?)` | `POST /touch` | `_XCT_synthesizeEvent` touch path |
| `swipe(sx,sy,ex,ey,duration,appIds?)` | `POST /swipe` | `EventTarget.dispatchEvent` |
| `gesturePath(paths[])` **(multitouch)** | `POST /gesturePath` | one `XCPointerEventPath` per finger |
| `inputText(text,appIds)` | `POST /inputText` | text-input `XCPointerEventPath` |
| `pressKey(delete\|return\|enter\|tab\|space)` | `POST /pressKey` | `XCUIKeyboardKey` |
| `pressButton(home\|lock\|…/tvOS remote)` | `POST /pressButton` | `XCUIDevice.press` / `XCUIRemote.press` |
| `eraseText` | `POST /eraseText` | repeated delete |

**Coordinates.** CLI accepts normalized 0..1 *or* absolute and normalizes host-side to
**points** (`swipe.ts:50-67` multiplies by `widthPoints/heightPoints` when coord ≤ 1). The
driver consumes points; on-device `ScreenSizeHelper.orientationAwarePoint` rotates for
landscape (`ScreenSizeHelper.swift:81-94`). `deviceInfo` returns both points and pixels.

**Keymaps.** Host `IOS_KEY_MAP` / `IOS_BUTTON_MAP` (`press-key.ts:53-65`); on-device
`XCUIKeyboardKey` rawValues (`PressKeyRequest.swift:16-27`); modifier bitmask in
`KeyModifierFlags.swift`; tvOS `TVOS_REMOTE_BUTTONS` → `XCUIRemote.Button`
(`press-key.ts:68-78`, `PressButtonHandler.swift:19-44`).

**SpringBoard / no-app — CONFIRMED YES.** Taps go through the runner daemon session and
are not bound to any app's event target, so they land regardless of foreground app. Swipes
fall back to `XCUIApplication(bundleIdentifier: "com.apple.springboard")` when no user app
is foreground (`EventTarget.swift:10`, `RunningApp.swift:7,24,70`); screen sizing reads
SpringBoard's full-screen frame. **Caveat:** the XCUITest *runner process* must be up, but
**no user/target app needs to be attached** — home-screen and cross-app interactions work.

**Second plane (not input):** `packages/ios-inproc` is a `DYLD_INSERT` dylib for
introspection (inspect/nav/hittest/set), base port 6075. Its README states HID is
"intentionally omitted — the XCUITest driver already synthesizes touches via
`_XCT_synthesizeEvent:`." It requires an attached app and is not an input path.

## 1.2 Android — on-device gRPC APK + one-shot `adb shell input`

**Mechanism (split).** `AndroidDriver` (`src/drivers/android.ts`) uses two channels:
1. **On-device gRPC instrumentation APK** (plaintext `localhost:3763`, adb-forwarded;
   proto `proto/conductor_android.proto`) for `tap`, `gesturePath` (multi-pointer),
   `inputText`, `eraseAllText`, `launchApp`, hierarchy, screenshot. The APK injects
   server-side via `UiAutomation.injectInputEvent` (MotionEvent) and `dispatchGesture`
   (≥2 fingers, API 24+).
2. **One-shot `adb shell input`** for `swipe`/`scroll` (`input swipe`), `pressKeyEvent`
   (`input keyevent`), `back` (`input keyevent 4`).

**Invocation model.** The gRPC APK is a **persistent instrumentation daemon** started by
`startAndroidDriver` via `am instrument` + `adb forward tcp:3763` (`bootstrap.ts:721-786`),
health-checked/restarted by the daemon. The `adb shell input` calls are pure one-shots.

**Coordinates.** **Device pixels**, natural orientation; normalized→pixel translation
happens in the *command* layer (`swipe.ts`, `scroll.ts`, `gestures.ts`) using
`widthPixels/heightPixels`.

**Keymaps.** Raw numeric Android keycodes (not `AKEYCODE_*` symbols), duplicated in
`ANDROID_KEYCODE` (`press-key.ts:98-134`) and `ANDROID_KEYCODES` (`flow-runner.ts:422`):
Home=3, Back=4, Enter=66, Del=67, Power=26, VolUp=24, VolDown=25, Dpad 19-23, plus TV set.

**Physical devices.** Supported — all addressing is `adb -s <deviceId>` (emulator or
physical); no emulator-only path.

## 1.3 Web — persistent loopback HTTP (the delegation reference)

`src/daemon/web-server.ts` is a **persistent Node http server** inside the daemon (base
port **4075**), Playwright-backed. `WebDriver` (`src/drivers/web.ts`) is a thin HTTP
client. Input endpoints: `POST /tap {x,y,duration?}`, `/swipe {startX,startY,endX,endY,
duration}`, `/inputText {text}`, `/pressKey {key}`, `/eraseText {count}`. **Per-event
request/response, no streaming, no WebSocket.** Coords are CSS/viewport pixels. This is the
"CLI = thin client, daemon = server" pattern we generalize — but the transport is the part
we replace for iOS/Android.

---

# Part 2 — Gap analysis vs Argus, and the injection-mechanism verdict

## 2.1 Capability matrix

| Capability | Argus native (today) | Conductor (today) | Verdict |
|---|---|---|---|
| Single tap | ✅ IndigoHID mouse | ✅ XCUITest `_XCT_synthesizeEvent` | parity |
| Discrete swipe / scroll | ✅ | ✅ (whole path in one synthesize) | parity |
| **Live continuous drag (open-ended)** | ✅ streamed moves, touch held (prevMsg continuity, 17ms cadence) | ⚠️ only as a *complete* gesture — a touch can't stay held across HTTP calls | **GAP (the real one)** |
| Multitouch (pinch/rotate/N-finger) | ❌ single mouse sequence | ✅ `gesturePath`, one path per finger | conductor ahead |
| Keyboard / text | ✅ Indigo keyboard NSEvent | ✅ text `XCPointerEventPath` + `pressKey` | parity |
| Hardware: Home | ✅ (only Home mapped) | ✅ `XCUIDevice.press(.home)` | parity |
| Hardware: Lock | ⚠️ probe-only (`hw_button`) | ✅ private `pressLockButton` | conductor ahead |
| Hardware: Volume / Siri | ⚠️ probe-only, unmapped | ❌ not mapped | **GAP (both weak)** |
| tvOS remote | ✅ faked as keyboard chords (arrows/Return/Esc/Space) | ✅ real `XCUIRemote.press` (+ hold) | conductor ahead |
| **SpringBoard / no-app injection** | ✅ backboardd, no runner needed | ✅ via runner daemon session (no *app* needed) | **parity — see verdict** |
| Android tap/text/multitouch | ✅ gRPC/scrcpy | ✅ gRPC APK | parity |
| Android live continuous drag | ✅ streamed sendevent/scrcpy | ⚠️ `adb shell input swipe` (whole gesture, ~200ms spawn) | GAP |

## 2.2 Injection-mechanism verdict

**We do NOT need to port the CoreSimulator/IndigoHID backend from `argus-sim-bridge` to
reach SpringBoard, hardware buttons, or the tvOS remote.** The pre-written Argus plan
assumed conductor's XCUITest path couldn't reach those; the audit shows otherwise:

- **SpringBoard / no-app:** conductor already reaches it — taps go through the runner
  daemon session (not app-bound), swipes fall back to the SpringBoard bundle
  (`EventTarget.swift:10`, `RunningApp.swift:7,24,70`). The only precondition is that the
  XCUITest *runner* is running, which conductor already keeps alive persistently.
- **Hardware buttons:** Home + Lock are supported today (`PressButtonHandler.swift`);
  Argus only has Home wired. Volume/Siri are missing on *both* sides.
- **tvOS remote:** conductor uses real `XCUIRemote` — arguably higher fidelity than
  Argus's keyboard-chord emulation.
- **Multitouch:** conductor already exceeds Argus (which has none).

**The one genuine architectural gap is streaming continuity, not reach.** XCUITest's
`_XCT_synthesizeEvent` is **atomic**: a gesture is one `XCSynthesizedEventRecord` with the
complete down→moves→up path, synthesized in a single call. There is **no supported way to
hold a touch DOWN and append moves across separate calls.** Argus's whole reason for the
persistent socket — a live drag where the user's finger moves in realtime and the app
animates *during* the drag — maps naturally onto IndigoHID's continuity model (open touch,
stream `move` frames with `prevMsg`, close) and does **not** map onto XCUITest.

### Recommendation: **hybrid, XCUITest-first**

1. **Baseline injector = conductor's existing XCUITest driver.** It already covers
   SpringBoard, hardware buttons, tvOS remote, multitouch, keyboard, and discrete
   taps/swipes. P1 reuses it wholesale behind the new socket — no HID port required for
   parity.
2. **Add a streaming pointer backend by porting the CoreSimulator/IndigoHID touch path
   from `ArgusHID.m` / `ArgusBridge.swift`** — but scoped narrowly to **live, open-ended
   pointer drags/scrolls** (the `pointer` stream with a held touch). This is the only
   thing XCUITest structurally cannot do. It runs host-side in the conductor daemon
   (CoreSimulator/SimulatorKit are host frameworks; no in-simulator runner needed), which
   also makes live drag independent of the XCUITest runner.
3. **Capability handshake decides routing per event:** discrete gestures, multitouch,
   buttons, remote, text → XCUITest; `pointer` streams with `phase:down→move…→up` → HID
   backend when advertised, else XCUITest buffers the path and synthesizes on `up`
   (degraded: no mid-drag animation, but functional — the fallback for P1 before the HID
   backend lands).

If porting the HID backend slips, **P1 can ship XCUITest-only** with the buffer-and-
synthesize-on-`up` fallback; the socket protocol below is designed so adding the HID
backend later is just a new advertised capability, no protocol change.

**Porting cost note (load-bearing IndigoHID details from the Argus audit)** — if/when we
port: the four trailing `1.0` doubles in `IndigoHIDMessageForMouseNSEvent` (FP registers,
touch silently drops otherwise), main-thread thread-local continuity, **per-UDID `prevMsg`
snapshotting** (Indigo's static buffer is process-global and would splice devices), the
`[0,1]` clamp crash-guard (out-of-range relaunches SpringBoard), the 17ms drag throttle
(~60/s ceiling), mach-port-invalidation detect+retry (sync DOWN), and `buttonTarget=51` for
`IndigoHIDMessageForButton` (invalid target aborts backboardd). Only the **touch/drag**
path is worth porting; buttons/remote/text stay on XCUITest.

## 2.3 Android gap

Android multitouch/tap/text are at parity (gRPC APK). The gap is the same streaming one:
live drag/scroll goes through one-shot `adb shell input swipe` (whole gesture, ~200ms
process spawn). P3 moves continuous drag into the gRPC APK as a streamed
`injectInputEvent` sequence (ACTION_DOWN → ACTION_MOVE… → ACTION_UP over the persistent
channel) so the socket's `pointer` stream maps cleanly.

---

# Part 3 — Streaming-socket protocol

## 3.1 Connection model

- **One WebSocket per device**, served by the conductor **daemon** (which already owns
  device lifecycle and per-device ports). WebSocket over loopback — not a raw socket —
  because it gives us framing, a clean text/binary split, ping/pong keepalive, and
  close-codes for free, and Argus's renderer can speak it directly. Endpoint:
  `ws://127.0.0.1:<daemonWsPort>/input?device=<id>&platform=<ios|tvos|android>`.
- Port: a new per-daemon WS listener (reuse the daemon's existing port-allocation scheme;
  it is *not* the driver's HTTP port — input frames are demuxed by the daemon and routed
  to the right backend). One socket multiplexes all event kinds for that device.
- **Framing:** newline-delimited **JSON text frames** for the control/handshake channel
  and for all event kinds initially. Reserve **binary frames** for a later fast-path
  (packed `pointer` moves) if profiling shows JSON parse cost matters at 60–120 Hz; the
  handshake advertises `binaryPointer` support so this is additive.

## 3.2 Capability handshake

On connect, conductor sends one `hello` frame; Argus replies `select`. Argus uses
`capabilities` to decide, per action, stream-vs-native-fallback.

```jsonc
// conductor → argus, first frame
{ "t": "hello", "protocol": 1, "device": "…", "platform": "ios",
  "capabilities": {
    "touch": true, "drag": true, "multitouch": true,
    "buttons": ["home", "lock"],          // only what's actually wired
    "keyboard": true, "text": true,
    "tvRemote": false,                     // true on tvOS
    "springboard": true,                   // input works with no app attached
    "liveDrag": "buffered",               // "native" once HID backend lands, else "buffered"
    "binaryPointer": false,
    "coord": "normalized"                  // 0..1, conductor owns device translation
  } }

// argus → conductor
{ "t": "select", "protocol": 1, "coalesce": { "pointerHz": 120 } }
```

Rules: unknown capability keys are ignored (forward-compat). `buttons` is an explicit
allow-list; anything not listed → Argus uses its native fallback. `liveDrag:"buffered"`
tells Argus the drag won't animate mid-gesture (so it may prefer its own HID path for live
drags until conductor advertises `"native"`).

## 3.3 Event frames (Argus → conductor)

All coordinates **normalized 0..1** (origin top-left, portrait); conductor owns
coord→device and keymap translation. Every frame carries a monotonic `seq` (u32, per
socket) for ordering/telemetry.

```jsonc
{ "t":"pointer", "seq":42, "id":0, "phase":"down"|"move"|"up"|"cancel", "x":0.5, "y":0.3 }
{ "t":"key",     "seq":43, "code":"Backspace", "mods":["shift"], "down":true }
{ "t":"text",    "seq":44, "value":"hello" }              // batched text entry
{ "t":"button",  "seq":45, "name":"home", "action":"press"|"down"|"up", "holdMs":0 }
{ "t":"scroll",  "seq":46, "x":0.5, "y":0.5, "dx":0.0, "dy":-0.2 }   // normalized deltas
{ "t":"tvremote","seq":47, "button":"up"|"down"|"left"|"right"|"select"|"menu"|"playPause", "holdMs":0 }
```

- **`pointer`** is the primitive for live drag: `id` supports multitouch (multiple
  concurrent ids); a stream is `down` → N×`move` → `up` (or `cancel`). Conductor routes it
  to the HID backend (held touch) when `liveDrag:"native"`, else buffers to a `gesturePath`
  synthesized on `up`. `key` uses conductor's own name→keycode maps (host-side, not raw
  keycodes over the wire). `scroll` is a normalized-delta convenience that conductor
  expands into a pointer drag or platform scroll.

## 3.4 Responses, ordering, backpressure, coalescing

- **Mostly fire-and-forget.** Conductor does not ack every frame (that would serialize the
  stream and kill latency). It emits an `error` frame `{ "t":"error", "seq":N, "code":…,
  "msg":… }` referencing the failing `seq`, and periodic `{ "t":"stat", "dropped":n }` if
  it coalesces. Discrete request/response actions that need a result (rare on the input
  path) may set `"ack":true` and get `{ "t":"ok", "seq":N }`.
- **Ordering:** strictly per-`id` for `pointer` (a device's touch sequence must not
  reorder); the daemon processes each socket's frames in `seq` order on a single-consumer
  queue. Different pointer `id`s are independent.
- **Coalescing / backpressure:** conductor coalesces `pointer move` frames to the injector's
  ceiling (iOS HID ~60 Hz / 17ms; Android to the gRPC channel rate) — it keeps the latest
  position and drops intermediate moves under load (`stat.dropped`), but **never drops
  `down`/`up`/`cancel`** (phase transitions are lossless). `key`/`button`/`tvremote` are
  never coalesced. If the socket send buffer backs up, Argus (sender) drops its own
  intermediate moves before enqueuing — coalescing happens on both ends, phases always
  survive.

## 3.5 Lifecycle

Socket opens when Argus activates a device, closes on deactivate. On close mid-drag,
conductor injects a synthetic `up`/`cancel` for any open pointer id (so no touch is left
stuck down). Reconnect is a fresh `hello`/`select`; no session resumption needed.

---

# Part 4 — P1 implementation plan

**Goal of P1:** stand up the conductor input socket server + iOS backend, advertise
capabilities, and prove parity so Argus's P2 cutover can begin. iOS-only; Android is P3.

### P1.1 — Input WebSocket server in the daemon
- New module `src/daemon/input-server.ts`: a WS listener owned by the daemon, one
  connection per device, demuxing frames onto a per-device single-consumer queue. Reuses
  the daemon's lifecycle/health-check machinery (`daemon/server.ts`) and port allocation
  (`bootstrap.ts` `getDriverPort` scheme, new `input` role). Plugs in next to the existing
  daemon Unix-socket endpoints (`/status`, `/logs`) — those stay; input is a separate WS
  port so streaming never blocks control RPC.

### P1.2 — Frame router + coord/keymap ownership
- `src/daemon/input-router.ts`: maps each frame kind to a backend call, does normalized→
  points translation (reuse `swipe.ts` logic, moved into a shared helper), applies the
  host-side key/button maps (`IOS_KEY_MAP`, `IOS_BUTTON_MAP`, `TVOS_REMOTE_BUTTONS`). This
  centralizes translation so backends receive device-space input.

### P1.3 — iOS backend = existing XCUITest driver (no port yet)
- Route `tap/swipe/gesturePath/inputText/pressKey/pressButton` frames to `IOSDriver`
  (`src/drivers/ios.ts`) as-is. `pointer` streams: buffer `down…up` and synthesize one
  `gesturePath` on `up` (`liveDrag:"buffered"`). This alone reaches parity for everything
  except mid-drag animation, and unblocks the Argus cutover.
- Advertise capabilities from a static per-platform table + runtime probe of the running
  driver (tvOS sets `tvRemote:true`, omits touch multitouch nuances as needed).

### P1.4 — (parallel/optional) HID streaming backend
- New host-side module (Swift/ObjC, built like `packages/ios-inproc`'s tool) that ports
  **only** the CoreSimulator/IndigoHID **touch/drag continuity** path from `ArgusHID.m` /
  `ArgusBridge.swift` — with all the load-bearing details in §2.2. Exposes open-touch/
  stream-move/close to the daemon. When present, flip `liveDrag:"native"` and route
  `pointer` streams here instead of buffering. Independent of the XCUITest runner, so live
  drag works even before the runner is warm.
- Decision gate: land P1.3 first, measure buffered-drag UX in Argus; build P1.4 only if
  mid-drag fidelity is required (likely yes for scroll-heavy apps).

### P1.5 — Volume/Siri buttons (small, both platforms weak today)
- Add Volume Up/Down/Siri to `PressButtonHandler` (private `XCUIDevice` selectors, probe
  as Argus's `hw_button` does) and to the `buttons` capability list once verified live.

### P1.6 — Tests & validation
- Extend the CLI custom runner (`packages/cli/tests/`, `SUITE=e2e` on a booted sim) with a
  socket-level suite: connect, handshake, drive tap/drag/multitouch/button/remote frames,
  assert via existing `assert-visible`. Prove SpringBoard injection (no app foreground) and
  tvOS remote on a tvOS sim.

### Android follow-on (P3, sketched)
- Reuse the same socket server + router; add an `AndroidDriver` backend. Move the numeric
  keycode maps (`ANDROID_KEYCODE`) into the shared router. Live drag: extend the gRPC APK
  with a streamed `injectInputEvent` (ACTION_DOWN→MOVE…→UP) over the persistent channel,
  replacing one-shot `adb shell input swipe` for `pointer` streams; advertise
  `liveDrag:"native"` for Android. Physical devices come for free (adb addressing).

### Sequencing
P1.1 → P1.2 → P1.3 (parity + Argus unblock) → validate → P1.4 (fidelity) → P1.5 → P1.6.
Argus P2 can start against P1.3's socket the moment capabilities are advertised; the HID
backend upgrades `liveDrag` under it without a protocol change.
