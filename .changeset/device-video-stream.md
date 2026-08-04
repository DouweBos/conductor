---
'@houwert/conductor': minor
---

Add a conductor-owned live device video stream. A per-device WebSocket in the
daemon (`conductor stream-server`, port base 8075, reported as `streamPort` in
daemon `/status`) emits a low-latency H.264 stream with multi-subscriber fan-out
(one capture, N viewers). On connect the server sends a JSON `config` frame
(codec, dimensions, SPS/PPS/avcC) then binary H.264 Annex B access units,
keyframe-led; a late subscriber gets the cached config + keyframe immediately.

iOS/tvOS capture is a new host-side binary (`packages/ios-capture`) that captures
the Simulator framebuffer via SimulatorKit and VideoToolbox-encodes H.264, mirroring
the streaming `input-server`. Android/web are follow-ons. See
`docs/device-video-stream.md`.
