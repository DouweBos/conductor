# ios-capture — host-side simulator framebuffer H.264 capture

A standalone macOS host binary conductor's daemon spawns to capture an
iOS/tvOS **Simulator's framebuffer** at the **CoreSimulator/SimulatorKit**
level and encode it to **H.264 Annex B** with VideoToolbox. Ported from Argus's
`argus-sim-bridge` (capture half only; the touch/keyboard/button HID injection
is intentionally left behind — that lives in `packages/ios-hid`).

## How it works

`SimDeviceIOClient → ioPorts → com.apple.framebuffer.display → descriptor →
framebufferSurface` yields a live `IOSurface` (BGRA) backed by a Mach port
transferred over XPC from the simulator service. Each frame is wrapped zero-copy
in a `CVPixelBuffer` and fed to a `VTCompressionSession` (quality-VBR 0.8, H.264
Main profile, 1s keyframe interval, 30fps, longest encoded dimension capped at
1920). The AVCC output is rewritten to an Annex B elementary stream — SPS/PPS
prepended on every keyframe — and served on an **ephemeral loopback TCP port**.
The daemon connects to that port and fans the stream out to WebSocket
subscribers; a new TCP client triggers a forced keyframe so it can start
decoding promptly.

It links only the public SDK and resolves the private CoreSimulator /
SimulatorKit frameworks via `dlopen` at runtime.

## Build

```sh
packages/ios-capture/tools/build-capture.sh
# → packages/cli/drivers/ios-capture/conductor-capture  (ad-hoc signed)
```

## Protocol (newline-delimited JSON over stdio)

```
{"cmd":"ping"}                              → {"ok":true}
{"cmd":"start_capture","udid":"<UDID>"}     → {"ok":true,"port":<uint16>}   // TCP stream port on 127.0.0.1
{"cmd":"stop_capture"}                      → {"ok":true}
```

On failure a command responds `{"ok":false,"error":"..."}`.

## Wire contract

The TCP stream is a **raw H.264 Annex B elementary stream**: start-code-prefixed
(`00 00 00 01`) NAL units, with SPS/PPS prepended ahead of every keyframe (IDR).
No container, no framing headers. The Node-side `H264AccessUnitParser` depends on
this exactly — the VideoToolbox settings are the proven wire contract and should
not be tuned.

## Layout

```
Sources/ConductorCapture/
  CaptureInject.m     ObjC: IOSurface framebuffer capture + VideoToolbox H.264 encoder
  CaptureBridge.swift dlopen CoreSimulator/SimulatorKit, resolve SimDevice, capture wrappers
  main.swift          JSON-over-stdio loop + raw H.264 Annex B TCP StreamHub
tools/build-capture.sh  clang + swiftc + ad-hoc sign
```
