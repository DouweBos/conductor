// CaptureInject.m — host-side simulator framebuffer capture + VideoToolbox
// H.264 encoder. Ported from Argus's argus-sim-bridge (ArgusHID.m), capture
// half only — the HID/Indigo injection is intentionally left behind (conductor
// owns input via packages/ios-hid; this package owns capture).
//
// Framebuffer path:
//   SimDeviceIOClient → ioPorts → find "com.apple.framebuffer.display" →
//   descriptor (SimDisplayIOSurfaceRenderable) → framebufferSurface → IOSurface
//
// The descriptor's `framebufferSurface` returns a live IOSurface backed by a
// Mach port transferred over XPC from the simulator service process. Each frame
// is wrapped zero-copy in a CVPixelBuffer and fed to a VTCompressionSession; the
// output callback converts the AVCC (length-prefixed) NAL units to an Annex B
// elementary stream (SPS/PPS on keyframes) that the Node-side H264AccessUnitParser
// expects. The VideoToolbox settings are the proven wire contract — do not tune.

#import <stdatomic.h>
#import <mach/mach_time.h>
#import <objc/message.h>
#import <Foundation/Foundation.h>
#import <IOSurface/IOSurface.h>
#import <CoreGraphics/CoreGraphics.h>
#import <VideoToolbox/VideoToolbox.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>

// ---------------------------------------------------------------------------
// MARK: - Hardware keyboard enable (kept for parity with the capture session)
// ---------------------------------------------------------------------------

/// Enable hardware-keyboard mode on the SimDevice so physical key events are
/// routed to the focused text field. Called once per capture session.
void SHEnableHardwareKeyboard(id device) {
    if (!device) return;
    SEL sel = NSSelectorFromString(@"setHardwareKeyboardEnabled:keyboardType:error:");
    if (![device respondsToSelector:sel]) {
        NSLog(@"[Capture] setHardwareKeyboardEnabled:keyboardType:error: unavailable");
        return;
    }
    NSError *err = nil;
    // keyboardType 0 = default. Pass the type as a full 64-bit register so the
    // value is 0 regardless of the parameter's real width.
    BOOL ok = ((BOOL (*)(id, SEL, BOOL, unsigned long long, NSError **))objc_msgSend)(
        device, sel, YES, 0ULL, &err);
    if (!ok || err) {
        NSLog(@"[Capture] setHardwareKeyboardEnabled failed: %@", err);
    }
}

// ---------------------------------------------------------------------------
// MARK: - Framebuffer capture via SimDeviceIOClient + IOSurface
// ---------------------------------------------------------------------------

typedef void (*SHFrameCallback)(const uint8_t *, size_t);

// Forward declaration
void SHStopFramebuffer(void);

static dispatch_source_t g_captureTimer = NULL;
static SHFrameCallback g_frameCallback = NULL;
static id g_ioClient = nil;
static id g_displayDescriptor = nil;   // SimDisplayIOSurfaceRenderable proxy
static id g_captureDevice = nil;       // SimDevice retained for IOClient recreation

// ---------------------------------------------------------------------------
// MARK: - VideoToolbox H.264 encoder
//
// The IOSurface is wrapped zero-copy in a CVPixelBuffer and fed to a
// VTCompressionSession. The output callback converts the AVCC (length-prefixed)
// NAL units to an Annex B elementary stream (with SPS/PPS on keyframes) and
// emits it via g_frameCallback — matching what the Node-side
// H264AccessUnitParser expects.
// ---------------------------------------------------------------------------

static VTCompressionSessionRef g_vtSession = NULL;
static int32_t g_vtWidth = 0;   // source (IOSurface) dims — for change detection
static int32_t g_vtHeight = 0;
static int64_t g_frameIndex = 0;
static _Atomic(bool) g_forceKeyframe = false;

static const uint8_t kAnnexBStartCode[4] = {0x00, 0x00, 0x00, 0x01};

// Cap the longest ENCODED dimension for performance (consistent with the
// Android capture path's maxSize default). The framebuffer is captured at
// native resolution and VideoToolbox scales it down to fit; 0 disables the
// cap. 1920 keeps Retina mirrors crisp while roughly halving the encode cost
// of the largest devices.
static int32_t g_maxEncodeDim = 1920;

/// Compute the (aspect-preserving, even) H.264 encode dimensions for a source
/// framebuffer, applying the resolution cap.
static void _encodeDims(int32_t sw, int32_t sh, int32_t *ew, int32_t *eh) {
    int32_t longest = sw > sh ? sw : sh;
    if (g_maxEncodeDim > 0 && longest > g_maxEncodeDim) {
        double scale = (double)g_maxEncodeDim / (double)longest;
        sw = (int32_t)(sw * scale);
        sh = (int32_t)(sh * scale);
    }
    sw &= ~1;  // H.264 requires even dimensions
    sh &= ~1;
    *ew = sw < 2 ? 2 : sw;
    *eh = sh < 2 ? 2 : sh;
}

/// VT output callback — runs on a VideoToolbox-managed thread. Serializes the
/// compressed access unit as Annex B and hands it to the frame callback.
static void _vtOutputCallback(void *outputCallbackRefCon,
                              void *sourceFrameRefCon,
                              OSStatus status,
                              VTEncodeInfoFlags infoFlags,
                              CMSampleBufferRef sampleBuffer) {
    SHFrameCallback cb = g_frameCallback;
    if (status != noErr || !sampleBuffer || !cb) return;
    if (!CMSampleBufferDataIsReady(sampleBuffer)) return;

    // A frame is a keyframe unless it is explicitly flagged NotSync.
    bool isKeyframe = true;
    CFArrayRef attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, false);
    if (attachments && CFArrayGetCount(attachments) > 0) {
        CFDictionaryRef dict = (CFDictionaryRef)CFArrayGetValueAtIndex(attachments, 0);
        isKeyframe = !CFDictionaryContainsKey(dict, kCMSampleAttachmentKey_NotSync);
    }

    NSMutableData *out = [NSMutableData data];

    // Prepend SPS/PPS (as Annex B) ahead of every keyframe so late joiners can
    // configure their decoder.
    if (isKeyframe) {
        CMFormatDescriptionRef fmt = CMSampleBufferGetFormatDescription(sampleBuffer);
        if (fmt) {
            size_t paramCount = 0;
            if (CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                    fmt, 0, NULL, NULL, &paramCount, NULL) == noErr) {
                for (size_t i = 0; i < paramCount; i++) {
                    const uint8_t *ps = NULL;
                    size_t psLen = 0;
                    if (CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                            fmt, i, &ps, &psLen, NULL, NULL) == noErr && ps) {
                        [out appendBytes:kAnnexBStartCode length:4];
                        [out appendBytes:ps length:psLen];
                    }
                }
            }
        }
    }

    // Convert the AVCC block buffer (4-byte length prefixes) to Annex B.
    CMBlockBufferRef bb = CMSampleBufferGetDataBuffer(sampleBuffer);
    if (bb) {
        size_t totalLen = 0;
        char *dataPtr = NULL;
        if (CMBlockBufferGetDataPointer(bb, 0, NULL, &totalLen, &dataPtr) == noErr && dataPtr) {
            size_t offset = 0;
            while (offset + 4 <= totalLen) {
                uint32_t nalLen = ((uint32_t)(uint8_t)dataPtr[offset] << 24) |
                                  ((uint32_t)(uint8_t)dataPtr[offset + 1] << 16) |
                                  ((uint32_t)(uint8_t)dataPtr[offset + 2] << 8) |
                                  ((uint32_t)(uint8_t)dataPtr[offset + 3]);
                offset += 4;
                if (offset + nalLen > totalLen) break;
                [out appendBytes:kAnnexBStartCode length:4];
                [out appendBytes:(dataPtr + offset) length:nalLen];
                offset += nalLen;
            }
        }
    }

    if (out.length > 0) {
        cb((const uint8_t *)out.bytes, out.length);
    }
}

/// Tear down the compression session and reset encoder state.
static void _teardownVTSession(void) {
    if (g_vtSession) {
        VTCompressionSessionCompleteFrames(g_vtSession, kCMTimeInvalid);
        VTCompressionSessionInvalidate(g_vtSession);
        CFRelease(g_vtSession);
        g_vtSession = NULL;
    }
    g_vtWidth = 0;
    g_vtHeight = 0;
    g_frameIndex = 0;
}

/// Create the compression session lazily, recreating it if the surface
/// dimensions changed. Returns NO on failure.
static BOOL _ensureVTSession(int32_t w, int32_t h) {
    if (g_vtSession && g_vtWidth == w && g_vtHeight == h) return YES;
    _teardownVTSession();

    int32_t ew, eh;
    _encodeDims(w, h, &ew, &eh);

    OSStatus st = VTCompressionSessionCreate(
        kCFAllocatorDefault, ew, eh, kCMVideoCodecType_H264,
        NULL, NULL, NULL, _vtOutputCallback, NULL, &g_vtSession);
    if (st != noErr || !g_vtSession) {
        NSLog(@"[Capture] VTCompressionSessionCreate failed: %d", (int)st);
        g_vtSession = NULL;
        return NO;
    }

    VTSessionSetProperty(g_vtSession, kVTCompressionPropertyKey_RealTime, kCFBooleanTrue);
    VTSessionSetProperty(g_vtSession, kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse);
    VTSessionSetProperty(g_vtSession, kVTCompressionPropertyKey_ProfileLevel,
                         kVTProfileLevel_H264_Main_AutoLevel);

    // Quality-driven VBR instead of a fixed average bitrate: crisp text,
    // near-zero bytes on static screens, and the bitrate rises only under
    // motion. No bitrate cap — the transport is localhost.
    // Kept below 1.0: at 1.0 VideoToolbox preserves the BGRA source's full
    // chroma and emits High 4:4:4 (profile 244), which WebCodecs can't decode;
    // 0.8 keeps it 4:2:0 / decodable while still visually lossless for UI.
    float quality = 0.8f;
    CFNumberRef qNum = CFNumberCreate(NULL, kCFNumberFloat32Type, &quality);
    VTSessionSetProperty(g_vtSession, kVTCompressionPropertyKey_Quality, qNum);
    CFRelease(qNum);

    // Keyframe every 1s (time-based) for fast recovery and late-joiner
    // startup, independent of frame rate.
    double kfDur = 1.0;
    CFNumberRef kfNum = CFNumberCreate(NULL, kCFNumberFloat64Type, &kfDur);
    VTSessionSetProperty(g_vtSession, kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, kfNum);
    CFRelease(kfNum);

    int32_t fps = 30;
    CFNumberRef fpsNum = CFNumberCreate(NULL, kCFNumberSInt32Type, &fps);
    VTSessionSetProperty(g_vtSession, kVTCompressionPropertyKey_ExpectedFrameRate, fpsNum);
    CFRelease(fpsNum);

    // When encoding below native resolution, let VideoToolbox scale the source
    // pixel buffer down (aspect preserved by _encodeDims, so Trim never crops).
    if (ew != w || eh != h) {
        const void *ks[] = { kVTPixelTransferPropertyKey_ScalingMode };
        const void *vs[] = { kVTScalingMode_Trim };
        CFDictionaryRef xfer = CFDictionaryCreate(NULL, ks, vs, 1,
            &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
        VTSessionSetProperty(g_vtSession, kVTCompressionPropertyKey_PixelTransferProperties, xfer);
        CFRelease(xfer);
    }

    VTCompressionSessionPrepareToEncodeFrames(g_vtSession);

    g_vtWidth = w;
    g_vtHeight = h;
    g_frameIndex = 0;
    NSLog(@"[Capture] VTCompressionSession source %dx%d → encode %dx%d (quality VBR)",
          w, h, ew, eh);
    return YES;
}

/// Force the next encoded frame to be a keyframe. Called when a new streaming
/// client connects so it gets a decodable stream (SPS/PPS + IDR) promptly.
void SHRequestKeyframe(void) {
    atomic_store(&g_forceKeyframe, true);
}

/// (Re)create the SimDeviceIOClient and find the display descriptor.
/// Returns YES if g_displayDescriptor is ready, NO on failure.
static BOOL _rebuildIOClient(void) {
    g_displayDescriptor = nil;
    g_ioClient = nil;

    if (!g_captureDevice) return NO;

    Class ioClientClass = NSClassFromString(@"SimDeviceIOClient");
    if (!ioClientClass) return NO;

    SEL initSel = NSSelectorFromString(@"initWithDevice:errorQueue:errorHandler:");
    dispatch_queue_t errQueue = dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0);
    void (^errorHandler)(NSError *) = ^(NSError *err) {
        NSLog(@"[Capture] IOClient error: %@", err);
    };

    g_ioClient = ((id (*)(id, SEL, id, dispatch_queue_t, void(^)(NSError *)))objc_msgSend)(
        [ioClientClass alloc], initSel, g_captureDevice, errQueue, errorHandler);

    if (!g_ioClient) return NO;

    // Find the framebuffer display port whose descriptor has a live IOSurface.
    // There can be multiple "com.apple.framebuffer.display" ports — only the one
    // backed by SimScreen (not the bare descriptor) provides the surface.
    NSArray *ports = [g_ioClient valueForKey:@"ioPorts"];
    g_displayDescriptor = nil;
    for (id port in ports) {
        @try {
            id portId = ((id (*)(id, SEL))objc_msgSend)(
                port, NSSelectorFromString(@"portIdentifier"));
            if (![portId isEqualToString:@"com.apple.framebuffer.display"]) {
                continue;
            }
            id desc = ((id (*)(id, SEL))objc_msgSend)(
                port, NSSelectorFromString(@"descriptor"));
            if (!desc) continue;

            // Check if this descriptor actually has a framebufferSurface
            IOSurfaceRef surface = (__bridge IOSurfaceRef)((id (*)(id, SEL))objc_msgSend)(
                desc, NSSelectorFromString(@"framebufferSurface"));
            if (surface) {
                g_displayDescriptor = desc;
                break;
            }
            // Keep this descriptor as a fallback (surface may appear later)
            if (!g_displayDescriptor) {
                g_displayDescriptor = desc;
            }
        } @catch (NSException *e) {
            continue;
        }
    }

    if (!g_displayDescriptor) {
        NSLog(@"[Capture] No com.apple.framebuffer.display port found (%lu ports total)",
              (unsigned long)ports.count);
        g_ioClient = nil;
        return NO;
    }

    return YES;
}

int32_t SHStartFramebuffer(id device, SHFrameCallback callback) {
    SHStopFramebuffer();

    if (!device || !callback) return -1;
    g_frameCallback = callback;
    g_captureDevice = device;

    if (!_rebuildIOClient()) {
        NSLog(@"[Capture] Initial IOClient setup failed");
        g_captureDevice = nil;
        return -3;
    }

    // Check if surface is already available
    @try {
        IOSurfaceRef surface = (__bridge IOSurfaceRef)((id (*)(id, SEL))objc_msgSend)(
            g_displayDescriptor, NSSelectorFromString(@"framebufferSurface"));
        if (surface) {
            NSLog(@"[Capture] Capturing %zux%zu BGRA framebuffer",
                  IOSurfaceGetWidth(surface), IOSurfaceGetHeight(surface));
        } else {
            NSLog(@"[Capture] framebufferSurface not yet available — will retry IOClient");
        }
    } @catch (NSException *e) {
        NSLog(@"[Capture] framebufferSurface threw: %@ — will retry", e.reason);
    }

    // --- Start timer for H.264 encoding at ~30fps ---
    // If framebufferSurface stays nil, the timer will periodically rebuild the
    // IOClient — the surface port is bound at creation time, so a stale client
    // created before Simulator.app switched to this device will never get one.
    dispatch_queue_t timerQueue = dispatch_queue_create(
        "com.conductor.capture", DISPATCH_QUEUE_SERIAL);
    g_captureTimer = dispatch_source_create(
        DISPATCH_SOURCE_TYPE_TIMER, 0, 0, timerQueue);
    dispatch_source_set_timer(g_captureTimer,
        DISPATCH_TIME_NOW,
        33 * NSEC_PER_MSEC,   // ~30fps
        5 * NSEC_PER_MSEC);   // leeway

    __block uint32_t nilSurfaceCount = 0;

    dispatch_source_set_event_handler(g_captureTimer, ^{
        if (!g_frameCallback || !g_captureDevice) return;

        // If we lost the descriptor (rebuild failed), try again periodically
        if (!g_displayDescriptor) {
            nilSurfaceCount++;
            // Retry every ~330ms (10 timer ticks at 33ms)
            if (nilSurfaceCount % 10 == 0) {
                NSLog(@"[Capture] Retrying IOClient rebuild...");
                _rebuildIOClient();
            }
            return;
        }

        IOSurfaceRef surface = NULL;
        @try {
            surface = (__bridge IOSurfaceRef)((id (*)(id, SEL))objc_msgSend)(
                g_displayDescriptor, NSSelectorFromString(@"framebufferSurface"));
        } @catch (NSException *e) {
            return;
        }

        if (!surface) {
            nilSurfaceCount++;
            // After ~330ms of nil surfaces, rebuild the IOClient — the surface
            // port is established at creation time so a client created before
            // the simulator window activated will never get one.
            if (nilSurfaceCount % 10 == 0) {
                NSLog(@"[Capture] framebufferSurface still nil after %u ticks — rebuilding IOClient",
                      nilSurfaceCount);
                _rebuildIOClient();
            }
            return;
        }

        // Got a valid surface — reset nil counter
        if (nilSurfaceCount > 0) {
            NSLog(@"[Capture] Capturing %zux%zu BGRA framebuffer (after %u nil ticks)",
                  IOSurfaceGetWidth(surface), IOSurfaceGetHeight(surface), nilSurfaceCount);
            nilSurfaceCount = 0;
        }

        int32_t w = (int32_t)IOSurfaceGetWidth(surface);
        int32_t h = (int32_t)IOSurfaceGetHeight(surface);

        if (!_ensureVTSession(w, h)) return;

        // Wrap the IOSurface (32BGRA) zero-copy in a CVPixelBuffer and encode.
        CVPixelBufferRef pb = NULL;
        CVReturn cvret = CVPixelBufferCreateWithIOSurface(NULL, surface, NULL, &pb);
        if (cvret != kCVReturnSuccess || !pb) {
            if (pb) CVPixelBufferRelease(pb);
            return;
        }

        CMTime pts = CMTimeMake(g_frameIndex++, 30);

        CFDictionaryRef frameProps = NULL;
        if (atomic_exchange(&g_forceKeyframe, false)) {
            const void *keys[1] = { kVTEncodeFrameOptionKey_ForceKeyFrame };
            const void *vals[1] = { kCFBooleanTrue };
            frameProps = CFDictionaryCreate(NULL, keys, vals, 1,
                &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
        }

        VTCompressionSessionEncodeFrame(g_vtSession, pb, pts, kCMTimeInvalid,
                                        frameProps, NULL, NULL);

        if (frameProps) CFRelease(frameProps);
        CVPixelBufferRelease(pb);
    });

    dispatch_resume(g_captureTimer);

    NSLog(@"[Capture] Capture started at 30fps");
    return 0;
}

void SHStopFramebuffer(void) {
    if (g_captureTimer) {
        dispatch_source_cancel(g_captureTimer);
        g_captureTimer = NULL;
    }

    _teardownVTSession();
    atomic_store(&g_forceKeyframe, false);

    g_displayDescriptor = nil;
    g_ioClient = nil;
    g_captureDevice = nil;
    g_frameCallback = NULL;
}
