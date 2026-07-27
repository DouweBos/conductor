---
'@houwert/conductor': minor
---

Discover external CDP endpoints automatically. Previously an already-running
browser exposing a remote-debugging port (e.g. an Electron app started with
`--remote-debugging-port`, one page target per webview/tile) could only be
attached to by passing `--cdp-url`/`--cdp-target` explicitly. Now `list-devices`
scans the conventional localhost debugging ports (9222–9229) and surfaces each
`type=page` webview as a booted `web:cdp:<port>:<targetId>` device.

The device id is self-describing, so a discovered webview is drivable with no
`--cdp-*` flags — `conductor --device web:cdp:9222:<targetId> <cmd>` hydrates the
CDP url and target from the id itself. `web-targets --cdp-url <url>` still lists
targets for endpoints on non-default ports. Port probes run in parallel with a
short timeout and swallow errors, so discovery adds negligible latency when no
CDP endpoint is present.
