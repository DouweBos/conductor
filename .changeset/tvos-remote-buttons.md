---
'@houwert/conductor': minor
---

Add the missing Siri Remote buttons for tvOS

`press-key` gains `Remote Page Up`, `Remote Page Down` and `Remote Guide`
(tvOS 14.3+), plus `Remote TV Provider`, `Remote One Two Three` and
`Remote Four Colors` (tvOS 18.1+). Page Up/Down move a screenful at a time,
which is the fastest way through a long list on an Apple TV. The driver
reports a precondition error when the device's OS predates a button rather
than pressing the wrong one.

The streaming-input WebSocket accepts the same buttons, and its `hello` frame
now advertises the tvOS remote buttons instead of just `home`/`lock`, so
clients can render the right controls up front.

Also replaces the tvOS `swipe` error, which pointed at plain D-pad presses and
didn't say why: XCTest has no Siri Remote touch-surface gesture at all
("Swipe events are only implemented for iOS, visionOS, and watchOS"), so the
message now says that and points at paging.
