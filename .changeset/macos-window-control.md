---
'@houwert/conductor': minor
---

macOS window control. `window list` shows the target app's windows.
`window focus "<title>"` raises a window and makes it the one conductor drives:
screenshots, coordinates, the hierarchy and the live stream all follow it.
`window focus --clear` goes back to the front window. `set-viewport <w> <h>`
resizes the driven window, and rejects the web-only flags.
