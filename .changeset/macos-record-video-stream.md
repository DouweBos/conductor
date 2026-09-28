---
'@houwert/conductor': minor
---

macOS: `record-video start/stop` records the target app's window to an H.264
`.mp4` (also the flow `startRecording`/`stopRecording` steps), and
`stream-server` serves a live H.264 stream of that window. The stream follows
window resizes. Both use the background driver, which needs a rebuilt
ConductorAX with Screen Recording allowed.
