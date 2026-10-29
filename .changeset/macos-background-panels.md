---
'@houwert/conductor': patch
---

macOS background driver fixes. Tapping a SwiftUI button inside a scroll view now presses the button instead of failing on the enclosing scroll area. Coordinates stay relative to the app's main window, even when a menu or hover-card panel is in front. Before, they could jump to the panel's origin and turn negative. Child panels, popovers and hover cards over the window now appear in `inspect`, are composited into `take-screenshot` and are marked `(overlay)` in `window list`. `tap-on --hover` now fails with an explicit reason instead of silently doing nothing, because tracking areas only follow the real pointer.
