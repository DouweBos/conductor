# ios-fold

Hinge and orientation control for foldable iOS simulators (iPhone Duo,
Xcode 27.1+).

`tools/build-fold.sh` builds `conductor-fold.dylib` into
`packages/cli/drivers/ios-fold/`. The CLI injects it into the booted
simulator's `locationd` on the first `set-fold`, then drives the hinge by
writing an angle to `/tmp/conductor-fold-<UDID>`.

It also drives orientation, via `/tmp/conductor-orientation-<UDID>`. Foldables
accept `devicectl device orientation set` and then ignore it — their pose
machine owns orientation — so `set-orientation` checks the result and rotates
through the relay when the device didn't take it. The relay's vocabulary is its
own: `portrait`, `pud`, `landscape-left`, `landscape-right`, `faceup`,
`facedown`.

## Why injection

Apple ships no fold setter. `simctl` has nothing, and `devicectl` only *reads*
the angle (`device motion hinge-angle`). A fold is an AVP event — `{source:
"hinge-slider-control", type: "range", value: <angle>}` — that Device Hub sends
over CoreDevice's remote-HID channel to the guest's `dtuhidd`, which hands it to
`locationd`, whose `CMDeviceStateRelayManager` synthesises the hinge IOHID event
(type 44) SpringBoard folds on. Orientation is the same channel with a different
source, `orientation-picker-control`.

Every other way in is closed:

- **Conductor's Indigo channel** (the one `ios-hid` uses for touches) cannot
  carry it. backboardd's `SimHIDVirtualServiceManager` accepts only event types
  `{1, 2, 6, 11, 17}`; the hinge event is 44. Targeting the AVP service by its
  `dtuhidd` id crashes backboardd — those ids are a different namespace.
- **SpringBoard's own `SBSDisplayToolService`** (`swapDisplayWithSettings:`,
  `replayHingeSamples…`) is gated on `com.apple.springboard.sbdisplay`, and the
  simulator refuses to launch any process carrying a restricted entitlement.
- **Making our own HID device** needs `IOHIDUserDeviceCreate`, a host-kernel
  user client the simulator can't hand out.
- **`dtuhidd`'s XPC services** are reachable by name but drop unprivileged peers
  immediately, whatever the message shape.

So the dylib feeds the relay from inside `locationd`, which is the same input
Device Hub produces — just without the UI.

## Notes

- Injection lasts until `locationd` restarts; the CLI re-injects when the pid
  recorded in `/tmp/conductor-fold-<UDID>.pid` no longer matches.
- Restarting `locationd` resets CoreMotion's relay to a 0° hinge, i.e. it folds
  the device. The CLI reads the angle before injecting and restores it after, so
  injection doesn't quietly change the pose.
- `get-fold` reads `devicectl`, not anything we cache: the hinge can be moved
  from Device Hub too, and a local cache would only cover our own writes.
- A simulator process's `/tmp` is the host's `/tmp`, so the control files are
  UDID-scoped — several foldables can be booted at once.
