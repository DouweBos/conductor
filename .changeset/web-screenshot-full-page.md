---
"@houwert/conductor": minor
---

Add `--full-page` flag to `take-screenshot` for the web platform. When set,
the web driver passes `fullPage: true` to Playwright so the entire scrollable
document is captured in a single image instead of just the viewport. The flag
is a no-op on iOS/Android.
