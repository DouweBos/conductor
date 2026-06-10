---
"@houwert/conductor": minor
---

`screenshot` can now target a single element via `--selector` (or a positional selector argument), cropping the capture to that element's bounds. Adds a new `png-crop` helper for in-process PNG cropping, so no external image tooling is required.
