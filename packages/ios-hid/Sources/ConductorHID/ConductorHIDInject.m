// ConductorHIDInject.m — CoreSimulator-level HID injection (touch/keyboard/button).
//
// Ported from Argus's argus-sim-bridge (ArgusHID.m), injection half only — the
// framebuffer/VideoToolbox capture is intentionally left behind (Argus keeps
// capture; conductor owns input). Runs on the host, talks to backboardd via
// SimulatorKit's IndigoHID message builders + SimDeviceLegacyHIDClient. Works on
// SpringBoard with no app attached — the reason this path exists alongside the
// XCUITest driver: it can hold a touch DOWN and stream moves for a live drag,
// which XCUITest's atomic _XCT_synthesizeEvent cannot.
//
// The load-bearing details (four trailing 1.0 doubles, per-UDID prevMsg
// snapshotting, [0,1] clamp crash-guard, 17ms drag throttle, mach-port retry)
// are preserved verbatim from the original — changing them silently breaks
// injection or reboots SpringBoard.

#import <stdatomic.h>
#import <mach/mach_time.h>
#import <objc/message.h>
#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>

// IndigoHIDMessageForMouseNSEvent: point, prevMsg, 0x32, nsEventType, direction
// → 320-byte static buffer. The 4 trailing `double` args land in d0–d3 and MUST
// be 1.0 or the built touch never registers with backboardd.
typedef void* (*IndigoMouseFn)(CGPoint*, void*, int, int, int,
                               double, double, double, double);

typedef struct {
    char udid[64];
    void *lastIndigoMsg;
    uint64_t lastTouchTime;
    _Atomic(bool) invalid;
} SHTouchState;

#define MAX_TOUCH_STATES 8
static SHTouchState g_touchStates[MAX_TOUCH_STATES];
static int g_touchStateCount = 0;

static SHTouchState *_touchStateForUDID(const char *udid) {
    for (int i = 0; i < g_touchStateCount; i++) {
        if (strcmp(g_touchStates[i].udid, udid) == 0) return &g_touchStates[i];
    }
    if (g_touchStateCount < MAX_TOUCH_STATES) {
        SHTouchState *s = &g_touchStates[g_touchStateCount++];
        strlcpy(s->udid, udid, sizeof(s->udid));
        s->lastIndigoMsg = NULL;
        s->lastTouchTime = 0;
        atomic_store(&s->invalid, false);
        return s;
    }
    if (g_touchStates[0].lastIndigoMsg) {
        free(g_touchStates[0].lastIndigoMsg);
        g_touchStates[0].lastIndigoMsg = NULL;
    }
    for (int i = 1; i < MAX_TOUCH_STATES; i++) g_touchStates[i - 1] = g_touchStates[i];
    SHTouchState *s = &g_touchStates[MAX_TOUCH_STATES - 1];
    strlcpy(s->udid, udid, sizeof(s->udid));
    s->lastIndigoMsg = NULL;
    s->lastTouchTime = 0;
    atomic_store(&s->invalid, false);
    return s;
}

// IndigoHIDMessageForMouseNSEvent's internal throttle is ~16ms; use 17ms.
#define INDIGO_MIN_INTERVAL_NS 17000000ULL
#define SH_TOUCH_MSG_SIZE 320
#define SH_KEYBOARD_MSG_SIZE 192

static void _ensureTimebase(mach_timebase_info_data_t *out) {
    static mach_timebase_info_data_t s_timebase;
    static dispatch_once_t s_once;
    dispatch_once(&s_once, ^{ mach_timebase_info(&s_timebase); });
    *out = s_timebase;
}

bool SHIsHIDClientInvalidForUDID(const char *udid) {
    for (int i = 0; i < g_touchStateCount; i++) {
        if (strcmp(g_touchStates[i].udid, udid) == 0) return atomic_load(&g_touchStates[i].invalid);
    }
    return false;
}

void SHResetHIDClientInvalidForUDID(const char *udid) {
    SHTouchState *s = _touchStateForUDID(udid);
    atomic_store(&s->invalid, false);
}

void SHClearTouchStateForUDID(const char *udid) {
    for (int i = 0; i < g_touchStateCount; i++) {
        if (strcmp(g_touchStates[i].udid, udid) == 0) {
            if (g_touchStates[i].lastIndigoMsg) free(g_touchStates[i].lastIndigoMsg);
            g_touchStates[i].lastIndigoMsg = NULL;
            g_touchStates[i].lastTouchTime = 0;
            return;
        }
    }
}

static void* SHCallIndigoMouseFn(IndigoMouseFn fn, CGPoint *pt, void *prevMsg,
                                 int nsEventType, int direction) {
    // The four 1.0 doubles are load-bearing (see typedef comment).
    return fn(pt, prevMsg, 0x32, nsEventType, direction, 1.0, 1.0, 1.0, 1.0);
}

int32_t SHSendTouch(id client, void *fnPtr, const char *udid,
                    float normX, float normY, int nsEventType, int direction) {
    if (!client || !fnPtr || !udid) return -1;
    SHTouchState *ts = _touchStateForUDID(udid);

    uint64_t now = mach_absolute_time();
    if (direction == 0 && ts->lastTouchTime != 0) {
        uint64_t elapsed = now - ts->lastTouchTime;
        mach_timebase_info_data_t timebase;
        _ensureTimebase(&timebase);
        uint64_t elapsedNano = elapsed * timebase.numer / timebase.denom;
        if (elapsedNano < INDIGO_MIN_INTERVAL_NS) return 0; // silently skip early drag
    }

    IndigoMouseFn fn = (IndigoMouseFn)fnPtr;

    // Clamp to [0,1] — out-of-range trips a backboardd assert and reboots SpringBoard.
    if (normX < 0.0f) normX = 0.0f; else if (normX > 1.0f) normX = 1.0f;
    if (normY < 0.0f) normY = 0.0f; else if (normY > 1.0f) normY = 1.0f;
    CGPoint pt = { (double)normX, (double)normY };

    // Continuity: pass our OWN snapshot, never Indigo's process-global buffer.
    void *prevMsg = (direction == 1) ? NULL : ts->lastIndigoMsg;
    void *msg = SHCallIndigoMouseFn(fn, &pt, prevMsg, nsEventType, direction);
    if (!msg) return -2;

    ts->lastTouchTime = now;

    void *copy = malloc(SH_TOUCH_MSG_SIZE);
    void *owned = malloc(SH_TOUCH_MSG_SIZE);
    if (!copy || !owned) { free(copy); free(owned); return -7; }
    memcpy(copy, msg, SH_TOUCH_MSG_SIZE);
    memcpy(owned, msg, SH_TOUCH_MSG_SIZE);

    if (ts->lastIndigoMsg) free(ts->lastIndigoMsg);
    ts->lastIndigoMsg = owned;

    _Atomic(bool) *invalidFlag = &ts->invalid;
    SEL sel = NSSelectorFromString(@"sendWithMessage:freeWhenDone:completionQueue:completion:");

    if (direction == 1) {
        // DOWN: synchronous so we detect a stale mach port immediately.
        dispatch_semaphore_t sem = dispatch_semaphore_create(0);
        __block NSError *sendError = nil;
        dispatch_queue_t queue = dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0);
        void (^completion)(NSError *) = ^(NSError *error) { sendError = error; dispatch_semaphore_signal(sem); };
        ((void (*)(id, SEL, void *, BOOL, dispatch_queue_t, void(^)(NSError *)))objc_msgSend)(
            client, sel, copy, YES, queue, completion);
        dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 500 * NSEC_PER_MSEC));
        if (sendError) {
            atomic_store(invalidFlag, true);
            free(ts->lastIndigoMsg); ts->lastIndigoMsg = NULL; ts->lastTouchTime = 0;
            return -6; // caller recreates client and retries
        }
    } else {
        NSString *udidNS = [[NSString alloc] initWithUTF8String:udid];
        dispatch_queue_t queue = dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0);
        void (^completion)(NSError *) = ^(NSError *error) {
            if (error) {
                atomic_store(invalidFlag, true);
                dispatch_async(dispatch_get_main_queue(), ^{ SHClearTouchStateForUDID(udidNS.UTF8String); });
            }
        };
        ((void (*)(id, SEL, void *, BOOL, dispatch_queue_t, void(^)(NSError *)))objc_msgSend)(
            client, sel, copy, YES, queue, completion);
    }

    if (direction == 2) {
        free(ts->lastIndigoMsg); ts->lastIndigoMsg = NULL; ts->lastTouchTime = 0;
    }
    return 0;
}

typedef void* (*IndigoKeyboardFn)(id);

int32_t SHSendKeyboard(id client, void *fnPtr, const char *udid,
                       uint16_t keyCode, uint64_t modifierFlags, BOOL isDown) {
    if (!client || !fnPtr || !udid) return -1;
    SHTouchState *ts = _touchStateForUDID(udid);
    IndigoKeyboardFn fn = (IndigoKeyboardFn)fnPtr;

    NSEventType eventType = isDown ? NSEventTypeKeyDown : NSEventTypeKeyUp;
    NSEvent *event = [NSEvent keyEventWithType:eventType
                                      location:NSMakePoint(0, 0)
                                 modifierFlags:modifierFlags
                                     timestamp:[[NSDate date] timeIntervalSince1970]
                                  windowNumber:0
                                       context:nil
                                    characters:@""
                   charactersIgnoringModifiers:@""
                                     isARepeat:NO
                                       keyCode:keyCode];
    if (!event) return -2;

    void *msg = fn(event);
    if (!msg) return -3;
    void *copy = malloc(SH_KEYBOARD_MSG_SIZE);
    if (!copy) return -5;
    memcpy(copy, msg, SH_KEYBOARD_MSG_SIZE);

    _Atomic(bool) *invalidFlag = &ts->invalid;
    SEL sel = NSSelectorFromString(@"sendWithMessage:freeWhenDone:completionQueue:completion:");
    dispatch_queue_t queue = dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0);
    void (^completion)(NSError *) = ^(NSError *error) { if (error) atomic_store(invalidFlag, true); };
    ((void (*)(id, SEL, void *, BOOL, dispatch_queue_t, void(^)(NSError *)))objc_msgSend)(
        client, sel, copy, YES, queue, completion);
    return 0;
}

// IndigoHIDMessageForButton(keyCode, op, target) — calloc's a fresh 192-byte
// message OWNED by the caller. op: down=1, up=2. target MUST be a valid
// IndigoHIDTarget (buttonTarget, 21 or 51) or backboardd aborts.
typedef void* (*IndigoButtonFn)(uint32_t, uint32_t, uint32_t);

int32_t SHSendButton(id client, void *fnPtr, const char *udid,
                     uint32_t keyCode, uint32_t op, uint32_t target) {
    if (!client || !fnPtr || !udid) return -1;
    IndigoButtonFn fn = (IndigoButtonFn)fnPtr;
    void *msg = fn(keyCode, op, target);
    if (!msg) return -3;
    void *copy = malloc(SH_KEYBOARD_MSG_SIZE);
    if (!copy) { free(msg); return -5; }
    memcpy(copy, msg, SH_KEYBOARD_MSG_SIZE);
    free(msg);

    _Atomic(bool) *invalidFlag = NULL;
    for (int i = 0; i < g_touchStateCount; i++) {
        if (strcmp(g_touchStates[i].udid, udid) == 0) { invalidFlag = &g_touchStates[i].invalid; break; }
    }
    SEL sel = NSSelectorFromString(@"sendWithMessage:freeWhenDone:completionQueue:completion:");
    dispatch_queue_t queue = dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0);
    void (^completion)(NSError *) = ^(NSError *error) { if (error && invalidFlag) atomic_store(invalidFlag, true); };
    ((void (*)(id, SEL, void *, BOOL, dispatch_queue_t, void(^)(NSError *)))objc_msgSend)(
        client, sel, copy, YES, queue, completion);
    return 0;
}

void SHEnableHardwareKeyboard(id device) {
    if (!device) return;
    SEL sel = NSSelectorFromString(@"setHardwareKeyboardEnabled:keyboardType:error:");
    if (![device respondsToSelector:sel]) return;
    NSError *err = nil;
    ((BOOL (*)(id, SEL, BOOL, unsigned long long, NSError **))objc_msgSend)(device, sel, YES, 0ULL, &err);
}
