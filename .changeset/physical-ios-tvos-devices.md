---
'@houwert/conductor': minor
---

Support physical iOS and tvOS devices

Real iPhones, iPads, and Apple TVs can now be driven alongside simulators. They
are discovered via `devicectl`, appear in `list-devices` as `connected`, and are
addressed by their CoreDevice identifier.

Because a real device only runs code signed for the user's team, the XCTest
driver is built and signed locally on first use and cached per team under
`~/.conductor/<platform>-driver-device/`. Set `CONDUCTOR_TEAM_ID` when the Mac
has more than one development team. The driver binds all interfaces on device
(the host reaches it over the LAN rather than a shared loopback), and app
lifecycle goes through `devicectl` instead of `simctl`.

Simulator-only features fail with an explicit message on device: `set-location`,
`open-link`, clipboard, `clear-keychain`, `add-media`, screen recording, the live
video stream, and OS log collection (Metro logs still stream).

Also fixes tvOS view inspection hanging on physical Apple TVs, where querying
HeadBoard for screen size, the status bar, and window origin never returns.
