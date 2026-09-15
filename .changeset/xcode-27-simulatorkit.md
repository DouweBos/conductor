---
"@houwert/conductor": patch
---

Support Xcode 27 alongside Xcode 26.

- `SimulatorKit.framework` moved from `Developer/Library/PrivateFrameworks` into
  the Xcode bundle's `SharedFrameworks`, which broke the native HID injector and
  simulator video capture; both now probe each location.
- Indigo's mouse message grew (320 → 352/512 bytes) and is now heap-allocated.
  The fixed-size copy left a garbage tail that made backboardd memmove past its
  stack buffer, crashing it and respringing SpringBoard mid-gesture; the message
  is now sized from the allocation and freed when owned.
- Xcode 27 replaced Simulator.app with DeviceHub.app, so `start-device` falls
  back to the hub when Simulator.app is absent.
