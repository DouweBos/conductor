---
'@houwert/conductor': minor
---

Drivers moved out of npm package; downloaded on first use from GitHub Releases into `~/.conductor/drivers/<version>/`. Lets downstream notarized macOS apps ship conductor cleanly without Apple rejecting the bundle over iOS/tvOS/Android driver binaries signed for non-macOS platforms.
