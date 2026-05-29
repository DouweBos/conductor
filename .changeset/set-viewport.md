---
"@houwert/conductor": minor
---

Add a `set-viewport` command for web sessions. Resize the Playwright browser to a preset (`mobile`, `tablet`, `desktop`) or explicit `width`/`height`, with optional device scale factor, mobile emulation, user agent, and color scheme. The current URL is preserved across the resize, so a single browser session can be screenshotted at multiple form factors without booting more devices.
