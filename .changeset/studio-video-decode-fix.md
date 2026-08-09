---
"conductor-studio": patch
---

Fix the device stream never rendering: the daemon sends bare IDR access units
with the SPS/PPS only in the config frame, so the WebCodecs decoder had no
parameter sets and never produced a picture. Studio now re-attaches them to each
keyframe. Connect failures also report themselves — the stream-server timeout
covers a cold daemon boot, and socket errors surface in the device panel instead
of leaving a spinner up forever.
