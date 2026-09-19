---
'@houwert/conductor': patch
---

Fix `take-screenshot --display`

Three problems with the display redirect shipped in 0.33.1:

`--display` was silently ignored on Android and web, returning the default
screen with a success message. It now reports that the flag is iOS-only.

A physical iOS device reporting two displays would have failed outright, since
the redirect captures through simctl. It now keeps the driver path instead.

Cropping to an element on a redirected panel returned the wrong region, because
`deviceInfo` describes the main panel while the hierarchy is in the redirected
panel's coordinate space. The panel's framebuffer is also rotated relative to
that space, so conductor now refuses the crop with an explanation rather than
returning a plausible-looking but wrong image. Cropping against the main panel,
including on a folded foldable, is unchanged.
