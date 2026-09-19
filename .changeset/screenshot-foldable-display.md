---
'@houwert/conductor': patch
---

Screenshot the panel that's actually on, and let `--display` pick one

`take-screenshot` captured `XCUIScreen.main`, which on an iPhone Duo is the
cover panel. Unfolded, that panel is powered off, so screenshots came back
black with nothing to explain why — and `assert-screenshot` compared black
frames. It now asks the device which panel is live and captures that one.

`--display` overrides the choice: `cover`/`inner` for a foldable's panels, or a
display id for anything else attached, such as CarPlay or an external screen. An
unknown value lists that device's displays and their ids rather than capturing
the wrong screen. Devices with a single display are unaffected.
