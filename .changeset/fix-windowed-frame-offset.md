---
"@houwert/conductor": patch
---

Fix element frames in `inspect` / `capture-ui` being shifted when the app runs windowed (iPadOS Stage Manager, etc.). The iOS driver was adding a bogus `(screenSize − windowSize)` offset to every element, which only happened to be correct if the window was flush to the bottom-right corner. XCUIElement snapshots are already in screen-space, so the adjustment is removed entirely — outlines now align with the underlying controls regardless of window position.
