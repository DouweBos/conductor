---
'@houwert/conductor': minor
---

Drive macOS apps on the host Mac. The Mac is a device with the fixed id
`macos`: `conductor start-device --platform macos` checks the automation setup
and warms up a new macOS build of the XCUITest driver, and every command then
takes `--device macos`. `inspect`, `capture-ui`, `tap-on`, `input-text`,
`take-screenshot`, flows and the rest work as on iOS, against the frontmost
app's front window — screenshots capture that window, and hierarchy frames and
coordinates are relative to its top-left corner.

Mac-specific input: `tap-on --right-click`, `--hover` and `--modifiers cmd,shift`,
a real double-click for `--double-tap`, keyboard shortcuts in `press-key`
(`cmd+s`, `cmd+shift+z`) and flow `pressKey`, `swipe --drag`, and a new
`menu "File > Save"` command. `scroll` and `swipe` use the scroll wheel.

App lifecycle goes through the host: `launch-app`, `stop-app`, `list-apps`,
`install-app` (copies the .app into `~/Applications`), `open-link`, clipboard,
unified-log streaming in `logs`, and `crashes` from DiagnosticReports.
Simulator-only operations (`set-location`, `set-permissions`, `clear-state`,
recording, gestures, injection, …) fail with an explicit message instead.

By default it runs in the background: a small ConductorAX helper drives the app
through Accessibility (element actions, key events posted to that app only) and
captures its window with ScreenCaptureKit, so it never takes over the pointer or
keyboard and works on covered windows and other displays. It needs Accessibility
and Screen Recording approval once. `CONDUCTOR_MACOS_FOREGROUND=1` switches to
the XCUITest driver for real pointer input (hover, drag, modifier clicks), which
needs Automation Mode as well.

Both macOS drivers carry the Studio icon, so they're recognisable in System
Settings' permission lists.
