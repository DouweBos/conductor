---
'@houwert/conductor': patch
---

Fix `metro reload --device` reloading the wrong device (or silently no-op)
when multiple apps share one Metro server.

- Device matching is now tolerant of the suffixes Metro appends to the model
  name — Android's `ro.product.model` is `Chromecast` while Metro reports it as
  `Chromecast - 14 - API 34`, so the exact-match lookup never matched and the
  reload fell through to the first target (e.g. an Apple TV) while reporting
  success.
- A device-scoped reload that can't find its device now errors and lists the
  available targets instead of silently reloading a different one. Use
  `--target <index>` to pick one explicitly.
