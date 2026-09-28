---
'@houwert/conductor': patch
---

react-native-macos: `metro use` writes `RCT_jsLocation` into the host's
`defaults` for the app. For a sandboxed app it writes into the app's container.
The daemon now also finds the app's Metro port from its own sockets, and
matches Metro targets by the Mac's computer name.
