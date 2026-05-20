//
// CCoreSimulator.h
//
// Minimal re-declarations of the private CoreSimulator + IOKit IOHIDEvent
// surface that conductor-sim-driver uses. Only the selectors/functions we
// actually call are declared here. No Apple headers are vendored.
//
// The full underlying types live in:
//   /Library/Developer/PrivateFrameworks/CoreSimulator.framework
//   /System/Library/Frameworks/IOKit.framework (IOHIDEvent SPI)
//
// API stability:
//   - SimServiceContext, SimDeviceSet, SimDevice classes are accessed via
//     NSClassFromString + objc_msgSend; no link-time dependence on a header.
//   - IOHIDEventCreate* functions are weak-linked: we resolve them at runtime
//     through dlsym so missing symbols on a future macOS / Xcode version
//     degrade gracefully (route returns 500 instead of crashing the process).
//
// If this file ever fails to compile against a future Xcode toolchain, it
// almost certainly means one of:
//   - IOHIDEventCreateDigitizerFingerEventWithQuality changed signature
//   - +[SimServiceContext sharedServiceContextForDeveloperDir:error:] was
//     renamed
//   - SimDevice's IO client accessor moved
// All three are checked at startup via objc_msgSend with NSSelectorFromString
// and reported on /status — easy to grep.
//
#ifndef CCORESIMULATOR_H
#define CCORESIMULATOR_H

#include <stdint.h>
#include <stddef.h>
#include <CoreFoundation/CoreFoundation.h>

#ifdef __cplusplus
extern "C" {
#endif

// MARK: - IOHIDEvent

// Opaque handle to a HID event. The real type lives in IOKit but isn't
// exposed publicly. We treat it as a CFTypeRef-equivalent: created with
// IOHIDEventCreate*, released with CFRelease.
typedef struct __IOHIDEvent *IOHIDEventRef;

// Digitizer "transducer" types used when synthesizing a finger event.
// Mirrors IOHIDEventTypes.h's kIOHIDDigitizerTransducerType*. We only need
// `Finger` for touch synthesis.
//
// The value `2` is the documented finger transducer constant in IOKit's
// public header IOHIDEventTypes.h — using it here is not a private-API
// detail.
#define CSD_DIGITIZER_TRANSDUCER_FINGER 2

// IOHIDEvent option bits. We only use these two for touch events.
#define CSD_OPTION_NONE 0

// IOHIDEvent senderID we publish with our synthesized events. Any non-zero
// value works; CoreSimulator uses this purely for event routing inside the
// simulator process.
#define CSD_HID_SENDER_ID 0x0001000000000001ULL

// The IOHIDEvent function pointers are resolved at runtime to keep us
// resilient to ABI drift on private APIs (and to avoid a hard build-time
// dependency on IOKit's SPI headers which aren't on the SDK path).
extern int csd_resolve_iohid(void);
extern const char *csd_iohid_resolve_error(void);

// One-finger digitizer event. timestamp=0 → CoreSimulator uses "now".
// `index` is the finger identifier (1-based, distinct across simultaneous
// fingers). `range` and `touch` are 0/1 — set both to 1 for touch-down and
// 0 for touch-up. Quality/identity/irregularity match the values WebDriverAgent
// and idb use for synthesized taps.
extern IOHIDEventRef csd_create_finger_event(
    uint64_t timestamp,
    uint32_t index,
    uint32_t identity,
    int eventMask,
    float x,
    float y,
    float quality,
    int isRange,
    int isTouch);

// Parent digitizer wrapper. Wrap one or more finger events under this for
// multi-touch. Pass `numFingers` 1 for a tap.
extern IOHIDEventRef csd_create_digitizer_event(
    uint64_t timestamp,
    int eventMask,
    uint32_t numFingers,
    int isRange,
    int isTouch);

// IOHIDEventAppendEvent — attaches a child event to a parent. Used to nest
// per-finger events under the digitizer root for multi-touch synthesis.
extern void csd_append_child(IOHIDEventRef parent, IOHIDEventRef child);

// Release the event. Wraps CFRelease so callers don't need to import
// CoreFoundation directly.
extern void csd_release_event(IOHIDEventRef ev);

// MARK: - IOHID event mask helpers

// Bitmask values mirroring IOHIDDigitizerEventMask in IOKit's
// IOHIDEventTypes.h. We hard-code only the bits we send. The constants
// themselves are public; only the functions that consume them are private.
#define CSD_DIGITIZER_MASK_RANGE    (1 << 0)
#define CSD_DIGITIZER_MASK_TOUCH    (1 << 1)
#define CSD_DIGITIZER_MASK_POSITION (1 << 2)

// MARK: - Keyboard / button HID

// HID usage pages and usage codes used by csd_create_keyboard_event.
// These are public USB HID standard values, not Apple-private.
//   kHIDPage_KeyboardOrKeypad = 0x07
//   kHIDPage_Consumer         = 0x0C
//   kHIDPage_GenericDesktop   = 0x01
#define CSD_HID_PAGE_KEYBOARD 0x07
#define CSD_HID_PAGE_CONSUMER 0x0C
#define CSD_HID_PAGE_GENERIC  0x01

extern IOHIDEventRef csd_create_keyboard_event(
    uint64_t timestamp,
    uint32_t usagePage,
    uint32_t usage,
    int isDown);

#ifdef __cplusplus
}
#endif

#endif // CCORESIMULATOR_H
