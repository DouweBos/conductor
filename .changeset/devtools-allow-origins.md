---
'@houwert/conductor': patch
---

Let DevTools attach to the web daemon's Chromium. It now launches with
`--remote-allow-origins=http://127.0.0.1:<cdpPort>`; without it Chromium
rejected every CDP WebSocket that sent an Origin header. Only the loopback
origin is allowed.
