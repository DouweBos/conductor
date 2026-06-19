---
"@houwert/conductor": minor
---

Wire `network logs`, `network request`, and `debug evaluate` to the web (Playwright) driver.

These commands previously only spoke to a React Native Metro/Hermes target, so on a web/webtv device they failed with "Could not connect to Metro". They now branch to the web driver when the session targets a web device:

- `network logs` — captures all page traffic via Playwright `request`/`response`/`requestfailed` events (fetch/XHR plus document/script/image/media), buffered in the daemon. Reports method, URL, status, resource type, duration, and failures. No page shim needed (unlike the RN path).
- `network request <url>` — issues the request through the browser context, so it shares the page's cookies/session.
- `debug evaluate <expr>` — evaluates JS in the page runtime via Playwright and returns the value, for poking a canvas webtv app (e.g. Lightning) at runtime.

Backed by new web-driver endpoints (`/networkLogs`, `/networkRequest`, `/evaluate`) and client methods. The RN/Metro behavior of all three commands is unchanged.
