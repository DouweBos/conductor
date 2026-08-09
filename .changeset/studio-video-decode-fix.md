---
"conductor-studio": patch
---

Fix the device stream never rendering. The daemon sends bare IDR access units
with the SPS/PPS only in the config frame, so a decoder configured for Annex B
had no parameter sets and never produced a picture. Studio now rewrites each
access unit to AVCC and configures the decoder with the avcC `description` — the
same path Argus's device streams use — and adopts its keyframe resync, decode
backpressure and structured-clone handling. Connect failures also report
themselves: the stream-server timeout covers a cold daemon boot, and socket
errors surface in the device panel instead of leaving a spinner up forever.
