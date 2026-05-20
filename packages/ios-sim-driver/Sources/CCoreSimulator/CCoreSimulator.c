//
// CCoreSimulator.c
//
// Runtime resolver for the private IOHIDEvent SPI. We don't link the IOKit
// SPI headers at compile time (they're not on the public SDK path); instead
// we dlsym the symbols on first use, store the pointers, and call them via
// typed function pointers.
//
// References:
//   - WebDriverAgent (MIT): FBSimulatorControl/FBHIDEvent.m
//   - idb (MIT):           FBSimulatorControl uses the same IOHIDEventCreateDigitizerFingerEventWithQuality
//                          signature. We mirror the call pattern without copying their code.
//
// Symbols looked up:
//   IOHIDEventCreateDigitizerFingerEventWithQuality
//   IOHIDEventCreateDigitizerEvent
//   IOHIDEventCreateKeyboardEvent
//   IOHIDEventAppendEvent
//
// If any of these are missing on the active macOS / Xcode, csd_resolve_iohid
// returns non-zero and the calling Swift code surfaces a 500 on /status's
// `iohidResolveError` field.
//

#include "CCoreSimulator.h"

#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <dlfcn.h>

// Typed function pointers — signatures match the public-ish IOKit SPI.
// The first argument to each Create* is a CFAllocatorRef; passing NULL
// asks IOKit to use the default allocator, which is what every known
// caller does.
typedef IOHIDEventRef (*csd_finger_fn_t)(
    CFAllocatorRef allocator,
    uint64_t timestamp,
    uint32_t index,
    uint32_t identity,
    uint32_t eventMask,
    float x,
    float y,
    float z,
    float tipPressure,
    float twist,
    uint8_t range,
    uint8_t touch,
    int options);

typedef IOHIDEventRef (*csd_digit_fn_t)(
    CFAllocatorRef allocator,
    uint64_t timestamp,
    uint32_t transducerType,
    uint32_t index,
    uint32_t identity,
    uint32_t eventMask,
    uint32_t buttonMask,
    float x,
    float y,
    float z,
    float tipPressure,
    float barrelPressure,
    uint8_t range,
    uint8_t touch,
    int options);

typedef IOHIDEventRef (*csd_keyboard_fn_t)(
    CFAllocatorRef allocator,
    uint64_t timestamp,
    uint32_t usagePage,
    uint32_t usage,
    uint8_t down,
    int options);

typedef void (*csd_append_fn_t)(IOHIDEventRef parent, IOHIDEventRef child);

static csd_finger_fn_t s_finger_fn = NULL;
static csd_digit_fn_t s_digit_fn = NULL;
static csd_keyboard_fn_t s_keyboard_fn = NULL;
static csd_append_fn_t s_append_fn = NULL;
static char s_error[256] = {0};

int csd_resolve_iohid(void) {
    if (s_finger_fn && s_digit_fn && s_keyboard_fn && s_append_fn) return 0;

    // IOKit owns the IOHIDEvent SPI. RTLD_DEFAULT picks it up because IOKit
    // is linked into the process via Package.swift's linkerSettings.
    void *handle = RTLD_DEFAULT;
    s_finger_fn = (csd_finger_fn_t)dlsym(handle, "IOHIDEventCreateDigitizerFingerEventWithQuality");
    s_digit_fn = (csd_digit_fn_t)dlsym(handle, "IOHIDEventCreateDigitizerEvent");
    s_keyboard_fn = (csd_keyboard_fn_t)dlsym(handle, "IOHIDEventCreateKeyboardEvent");
    s_append_fn = (csd_append_fn_t)dlsym(handle, "IOHIDEventAppendEvent");

    if (!s_finger_fn || !s_digit_fn || !s_keyboard_fn || !s_append_fn) {
        snprintf(s_error, sizeof(s_error),
            "IOHIDEvent SPI missing (finger=%p digit=%p kb=%p append=%p)",
            (void *)s_finger_fn, (void *)s_digit_fn,
            (void *)s_keyboard_fn, (void *)s_append_fn);
        return 1;
    }
    return 0;
}

const char *csd_iohid_resolve_error(void) {
    if (s_error[0] == '\0') return NULL;
    return s_error;
}

IOHIDEventRef csd_create_finger_event(
    uint64_t timestamp,
    uint32_t index,
    uint32_t identity,
    int eventMask,
    float x,
    float y,
    float quality,
    int isRange,
    int isTouch) {
    if (!s_finger_fn) return NULL;
    // The "Quality" variant takes pressure/twist params; we pass quality for
    // tipPressure as a stand-in for fidelity (matches what WebDriverAgent uses).
    return s_finger_fn(
        NULL,
        timestamp,
        index,
        identity,
        (uint32_t)eventMask,
        x,
        y,
        0.0f,
        quality,
        0.0f,
        (uint8_t)(isRange ? 1 : 0),
        (uint8_t)(isTouch ? 1 : 0),
        0);
}

IOHIDEventRef csd_create_digitizer_event(
    uint64_t timestamp,
    int eventMask,
    uint32_t numFingers,
    int isRange,
    int isTouch) {
    if (!s_digit_fn) return NULL;
    return s_digit_fn(
        NULL,
        timestamp,
        CSD_DIGITIZER_TRANSDUCER_FINGER,
        0,
        0,
        (uint32_t)eventMask,
        0,
        0.0f,
        0.0f,
        0.0f,
        0.0f,
        0.0f,
        (uint8_t)(isRange ? 1 : 0),
        (uint8_t)(isTouch ? 1 : 0),
        0);
}

IOHIDEventRef csd_create_keyboard_event(
    uint64_t timestamp,
    uint32_t usagePage,
    uint32_t usage,
    int isDown) {
    if (!s_keyboard_fn) return NULL;
    return s_keyboard_fn(NULL, timestamp, usagePage, usage, (uint8_t)(isDown ? 1 : 0), 0);
}

void csd_append_child(IOHIDEventRef parent, IOHIDEventRef child) {
    if (!s_append_fn || !parent || !child) return;
    s_append_fn(parent, child);
}

void csd_release_event(IOHIDEventRef ev) {
    if (ev) CFRelease(ev);
}
