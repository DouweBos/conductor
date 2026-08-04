# Plan: device video stream — conductor as the live-capture owner

Status: **Implemented (iOS + tvOS live H.264 stream). Android/web are follow-ons.**
This is the capture counterpart to `docs/device-input-migration.md`. Where that
doc moved *input injection* into conductor as a streaming per-device socket, this
one moves *live video capture* into conductor as a second streaming per-device
socket, so any client — the Argus IDE, a planned lightweight device-viewer app, a
web client — is a thin subscriber instead of each re-implementing capture.

It delivers: (1) an audit of conductor's existing capture surface, (2) the stream
protocol / frame contract, (3) the fan-out + capture lifecycle, and (4) the iOS
implementation (daemon stream server + host-side capture backend + CLI).

## What shipped

- **Video WebSocket server** in the daemon (`src/daemon/video-server.ts`), one per
  device, loopback. Frame contract + config serialization in `video-protocol.ts`;
  the Annex B elementary-stream parser in `h264-annexb.ts`; multi-subscriber
  fan-out with config/keyframe caching in `video-hub.ts`; the capture producer in
  `video-source.ts`. Port allocated via `getStreamPort` (base **8075**), reported
  in daemon `/status` as `streamPort`.
- **iOS/tvOS capture backend** (`packages/ios-capture`): a host-side Swift/ObjC
  binary `conductor-capture` that captures the Simulator framebuffer via the
  private SimulatorKit/CoreSimulator IOSurface path and **VideoToolbox-encodes
  H.264**, serving a raw Annex B byte stream on a loopback TCP port. Ported from
  Argus's `argus-sim-bridge` (capture half only), mirroring how `packages/ios-hid`
  ported the input half. No in-simulator runner needed.
- **CLI**: `conductor stream-server` starts it (if needed) and prints the WebSocket
  URL + codec (`--json` → `{ device, platform, streamPort, url, codec }`).
- **Tests**: `packages/cli/tests/video-streaming.test.ts` (Annex B parser config
  extraction + AU splitting + keyframe flagging, hub late-joiner replay, WS server
  config handshake + binary AU delivery + capture ref-counting) — all device-free.

## Locked decisions (mirroring the input migration)

- **Scope = capture only.** Input stays on `input-server`. The two device-I/O
  sockets are deliberately symmetric (daemon lifecycle, port allocation, capability
  handshake) so a client wires them the same way.
- **Codec = H.264, low latency first.** Interactive mirroring is the whole point;
  we emit a keyframe-led Annex B elementary stream and cache the last config + IDR
  so a late subscriber decodes immediately. This is exactly the wire shape the
  Argus renderer already consumes via WebCodecs (`VideoDecoder`/`EncodedVideoChunk`).
- **One capture, N viewers.** Fan-out lives in the daemon; the first subscriber
  starts capture, the last one out stops it.
- **Transport = one persistent per-device WebSocket**, loopback, bound next to the
  input socket. The capture backend↔daemon hop is a separate loopback TCP stream
  internal to the daemon (the native binary's port), never exposed to clients.

---

# Part 1 — Audit: conductor's current capture surface

Conductor already captures pixels three ways, none of them a low-latency live
stream:

- **Still screenshots.** iOS: `GET /screenshot` on the XCUITest driver
  (`ios.ts:556`). Android: gRPC `screenshot` call (`android.ts:136`). Web:
  `GET /screenshot` on the Playwright driver (`web.ts:211`). One PNG per request
  over the control channel — fine for `capture-ui`/asserts, useless for mirroring.
- **File recording.** iOS: `xcrun simctl io <id> recordVideo --codec hevc`
  spawned to a file (`ios.ts:487`) — HEVC, to disk, no live subscribers, stops on
  SIGINT. Android has the analogous `screenrecord` path. This is an artifact
  recorder, not a stream.
- **No live path today.** There is no CDP screencast or any push-based frame
  transport in conductor (the CDP screencast referenced in the brief lives in
  Argus, not here). So the live stream is genuinely new surface, not a re-transport
  of something existing.

**Verdict:** reuse the screenshot/record plumbing for what it's good at (stills,
saved clips) and build the live stream fresh, modeled on the input server. The
valuable IP to move is Argus's native SimulatorKit→VideoToolbox capture, which is
the only thing in the stack that produces a low-latency encoded stream.

# Part 2 — The stream protocol / frame contract

**URL.** `ws://127.0.0.1:<streamPort>/stream?device=<id>&platform=<ios|tvos|android|web>`
(`streamPort` from `getStreamPort`, base 8075; also in `daemon-status --json`).

**Handshake.** On connect the server sends exactly one **JSON** `config` frame,
then every subsequent message is **binary**. Clients distinguish by frame type
(text vs binary), matching the Argus decode path.

```jsonc
// config frame (text)
{
  "t": "config",
  "protocol": 1,
  "device": "<udid|serial>",
  "platform": "ios",
  "codec": "h264",          // "jpeg" for web (follow-on) so clients pick a decoder
  "width": 886, "height": 1920,
  "rotation": 0,            // degrees; 0 for simulators, carried for device parity
  "fps": 30,
  "codecString": "avc1.640028",  // h264 only — feed straight to VideoDecoderConfig
  "sps": "<base64 SPS NAL, no start code>",   // h264 only
  "pps": "<base64 PPS NAL, no start code>",   // h264 only
  "avcC": "<base64 AVCDecoderConfigurationRecord>" // h264 only — SPS+PPS packed
}
```

Every message after the config is **one H.264 Annex B access unit** (binary): raw
NAL units with `00 00 00 01` start codes, keyframe-led, SPS/PPS re-prepended ahead
of each keyframe by the encoder. WebCodecs clients can decode either by feeding
`avcC` as the `description` and converting AUs to length-prefixed, or by staying in
Annex B mode — both `sps`/`pps` and `avcC` are provided so the client picks.

A late subscriber is guaranteed the cached `config` frame **and** a keyframe access
unit immediately on connect (see Part 3), so it never waits out a GOP to start
decoding. A rare non-fatal `notice` frame (`{t:"notice",code,msg}`) may be sent,
e.g. if the capture backend fails to start.

# Part 3 — Fan-out + capture lifecycle

`VideoHub` (`video-hub.ts`) is the fan-out point, one per device: subscribers
register listeners; `emitConfig`/`emitFrame` broadcast; the last config and last
keyframe AU are cached and replayed synchronously to any late subscriber. A config
change invalidates the cached keyframe (dimensions may differ).

`video-server.ts` ref-counts subscribers over the hub: the **first** connection
starts the capture source, the **last** disconnect stops it. Start/stop are
serialized through a single-flight promise chain so rapid connect/disconnect churn
can't race the backend. `video-source.ts` (`IOSCaptureSource`) is the producer: it
spawns `conductor-capture`, sends `start_capture`, connects to the returned
loopback TCP port, parses the Annex B stream into config + access units, and feeds
the hub. If the backend or its TCP stream drops while subscribers remain, the
source relaunches after a short backoff — a dead capture never wedges the socket.

# Part 4 — iOS implementation

- **`packages/ios-capture`** — `conductor-capture`, a newline-delimited-JSON-over-
  stdio binary (mirrors `packages/ios-hid`):
  - `{"cmd":"ping"}` → `{"ok":true}`
  - `{"cmd":"start_capture","udid":"…"}` → `{"ok":true,"port":<uint16>}` (loopback
    TCP port serving the raw Annex B stream)
  - `{"cmd":"stop_capture"}` → `{"ok":true}`

  Internally it loads CoreSimulator + SimulatorKit at runtime (`dlopen`), finds the
  `SimDevice`, gets the framebuffer `IOSurface` off the display descriptor, wraps it
  zero-copy in a `CVPixelBuffer`, and feeds a `VTCompressionSession` (H.264 Main,
  quality-VBR 0.8, 1s keyframe interval, 30fps, longest-dimension cap 1920). The VT
  output callback rewrites AVCC length prefixes to Annex B and prepends SPS/PPS to
  keyframes. A `StreamHub` fans the encoded bytes out to connected TCP clients and
  forces a keyframe when a new one connects. tvOS uses the identical path.

- **Daemon wiring** (`server.ts`): after the input server comes up, the daemon
  starts the video server for iOS/tvOS if the capture binary is present
  (`getCaptureBinaryPath`); `streamPort` is reported in `/status` and torn down in
  `cleanup()`. Capture is lazy — the binary isn't spawned until the first WS
  subscriber connects.

- **CLI/runner** (`runner.ts:streamServerInfo`, `commands/stream-server.ts`):
  resolves the device, starts the daemon, polls `/status` for `streamPort`, and
  prints the URL. If the daemon is up but never reports a `streamPort` (capture
  binary missing from the installed drivers), it fails fast with that message
  instead of waiting out the timeout.

## Build / packaging

`packages/ios-capture/tools/build-capture.sh` compiles the binary (ad-hoc signed)
to `packages/cli/drivers/ios-capture/conductor-capture`. Wired into the Makefile
(`build-ios-capture`, in `build` and the drivers tarball) so it ships in the
`drivers.tar.gz` the CLI downloads per release, alongside `ios`, `ios-inproc`, and
`tvos`.

# Follow-ons (P2)

- **Android**: reuse scrcpy-server's H.264 output (conductor already shells to
  scrcpy) as an `AndroidCaptureSource` feeding the same hub — same config + Annex B
  AU contract, no client changes.
- **Web**: adapt a CDP screencast to the same `config`+frames shape with
  `codec:"jpeg"` (frames are whole JPEGs, not H.264 AUs) so clients switch decoder
  off the advertised codec.
- **Rotation / DPR** metadata for real devices once a device (non-simulator) path
  exists.
