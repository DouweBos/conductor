---
"@houwert/conductor": patch
---

Fix iOS driver resolving the wrong foreground app on iPadOS 26. In windowed / Stage Manager modes, scene-based lookup returned shell processes (DockFolderViewService, SpringBoard) instead of the user's app; capture-ui and inspect now bind XCUIApplication by PID so the hierarchy reflects the running app. Also drops an AX snapshot in ScreenSizeHelper that hung 30s+ on heavy-AX apps like Plex.
