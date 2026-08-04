# ios-hid — host-side CoreSimulator HID injector

A standalone macOS host binary conductor's daemon spawns to inject **touch,
keyboard, and hardware-button** HID at the **CoreSimulator** level — below
XCUITest. Ported from Argus's `argus-sim-bridge` (injection half only; the
framebuffer/VideoToolbox capture is intentionally left behind — Argus keeps
capture, conductor owns input).

## Why this exists alongside the XCUITest driver

The XCUITest driver (`packages/ios-driver`) already reaches SpringBoard, hardware
buttons, the tvOS remote, and multitouch via `_XCT_synthesizeEvent`. But that API
is **atomic**: a gesture is one complete down→moves→up record — you cannot hold a
touch DOWN and append moves across calls. A live, open-ended drag (the reason the
input socket streams `pointer` frames) needs exactly that, and IndigoHID's
continuity model (open touch, stream moves with `prevMsg`, close) provides it.

So this binary is used **only** for live held-touch drags, gated behind
`CONDUCTOR_IOS_HID=1`. Everything else (discrete taps/swipes, multitouch,
keyboard, buttons, tvOS remote) stays on XCUITest. It is **single-touch** — one
sequence per UDID, like Argus's original.

## Status

**Ported, not yet validated on a live simulator in this repo.** The injection
logic is a faithful copy of the reverse-engineered Argus path, including the
load-bearing details (see below). It builds against the public SDK and resolves
private frameworks via `dlopen` at runtime. Build it and validate on a booted
simulator before enabling in production. The default input path (`liveDrag:
"buffered"`, XCUITest) does **not** depend on this binary.

## Build

```sh
packages/ios-hid/tools/build-hid.sh
# → packages/cli/drivers/ios-hid/conductor-hid  (ad-hoc signed)
```

Then enable it:

```sh
CONDUCTOR_IOS_HID=1 conductor input-server   # daemon picks up the HID backend
```

The daemon `ping`s the binary on startup; if it's missing or unresponsive it logs
a fallback and stays on buffered drag.

## Protocol (newline-delimited JSON over stdio)

```
{"cmd":"ping"}                                                    → {"ok":true}
{"cmd":"touch","udid":"<UDID>","x":0.5,"y":0.5,"type":0|1|2}      → {"ok":true,"rc":0}   // 0=down 1=move 2=up
{"cmd":"keyboard","udid":"<UDID>","keyCode":36,"modifierFlags":0,"isDown":true}
{"cmd":"button","udid":"<UDID>","keyCode":1,"op":1,"target":51}                          // op 1=down 2=up
```

Coordinates are normalized 0..1. Node client: `packages/cli/src/drivers/ios-hid.ts`.

## Load-bearing details (do not "simplify")

Preserved verbatim from the Argus reverse-engineering — changing any silently
breaks injection or reboots SpringBoard:

- `IndigoHIDMessageForMouseNSEvent`'s **four trailing `1.0` doubles** (d0–d3) — the
  touch is built but never registers without them.
- **Main-thread + thread-local continuity**: the builder tracks the active touch
  in thread-local state; drag continuity is via passing back our **own per-UDID
  `prevMsg` snapshot** (never Indigo's process-global buffer, which any other
  simulator's call overwrites).
- **[0,1] clamp crash-guard**: an out-of-range coordinate trips a backboardd
  assert and relaunches SpringBoard.
- **17ms drag throttle** (~60/s ceiling; the builder's own threshold is ~16ms).
- **mach-port-invalidation detect + retry**: DOWN is sent synchronously to catch a
  stale client immediately, then recreated and retried once.
- **`IndigoHIDMessageForButton` `target`** must be a valid `IndigoHIDTarget`
  (`SimDeviceScreen.buttonTarget`, 21 or 51) or backboardd aborts.

## Layout

```
Sources/ConductorHID/
  ConductorHIDInject.m   ObjC injection core (touch/keyboard/button + per-UDID state)
  HIDBridge.swift        dlopen CoreSimulator/SimulatorKit, per-UDID HID clients
  main.swift             JSON-over-stdio request loop
tools/build-hid.sh       clang + swiftc + ad-hoc sign
```
