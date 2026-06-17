---
"@houwert/conductor": patch
---

`capture-ui` now rejects a non-`.json` `--output` path. The command always emits a JSON bundle (the screenshot is embedded as base64), so passing an image path like `--output foo.png` previously produced an image-named file full of JSON. It now fails fast with a clear message pointing to `take-screenshot` for actual image files. Extensionless and `.json` paths are unchanged.
