---
"@houwert/conductor": patch
---

Web driver now strips the `HeadlessChrome` marker from the browser's
User-Agent before any context is created, so sites loaded through the
web driver see a normal `Chrome` UA. Custom UAs passed to `setViewport`
still take precedence.
