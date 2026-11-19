---
'@houwert/conductor': patch
---

Fix iOS taps, swipes and gestures missing their target in apps that force landscape, such as a full-screen video player. The driver rotated coordinates by the device's orientation, which stays unknown or portrait when only the app rotates, so a landscape point like a player's close button was sent off-screen. It now uses the foreground app's interface orientation and falls back to the device orientation only when that's unavailable. `deviceInfo` reports the same oriented size.
