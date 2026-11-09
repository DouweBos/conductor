// ConductorFold — hinge/fold control for foldable simulators (iPhone Duo).
//
// Injected into the simulator's locationd, which is where CoreMotion's
// CMDeviceStateRelayManager lives. That relay is the only producer of the hinge
// IOHID event SpringBoard folds on, and its sole input is an "AVP" dictionary —
// the same one Device Hub's hinge slider sends via CoreDevice's remote HID
// channel. Every other way in is walled off: backboardd's Indigo consumer
// rejects hinge events, the AVP HID service isn't an Indigo target, making our
// own HID device needs an entitlement the simulator won't launch, and dtuhidd's
// XPC listener refuses unprivileged peers. So we feed the relay in-process.
//
// Control channel is a pair of files, UDID-scoped because a simulator process's
// /tmp is the host's /tmp and several devices may be booted at once:
//   /tmp/conductor-fold-<UDID>        write an angle (0-180) to apply it
//   /tmp/conductor-orientation-<UDID> write an orientation token to apply it
//                                     (portrait, pud, landscape-left,
//                                      landscape-right, faceup, facedown)
//   /tmp/conductor-fold-<UDID>.pid    locationd pid, so the CLI knows whether
//                                     this dylib is still loaded
//   /tmp/conductor-fold-<UDID>.angle  the relay's effective angle, rewritten on
//                                     every change (ours or Device Hub's)
#import <Foundation/Foundation.h>
#import <objc/runtime.h>
#import <objc/message.h>

static id gRelay = nil;
static NSString *gControlPath = nil;
static NSString *gAnglePath = nil;
static NSString *gOrientationPath = nil;
// Held for the process lifetime: under ARC a local source is released on return.
static dispatch_source_t gControlSource = nil;
static dispatch_source_t gOrientationSource = nil;

static void (*orig_startUpdates)(id, SEL, id);
static void (*orig_startUpdatesAOP)(id, SEL, BOOL, id);
static void (*orig_setEffectiveAngle)(id, SEL, id);

/// The relay has no singleton accessor, so grab it as locationd starts it up.
static void hooked_startUpdates(id self, SEL _cmd, id device) {
  gRelay = self;
  orig_startUpdates(self, _cmd, device);
}

/// iOS 27.2 renamed the start call to take a BOOL plus an AOP angle source.
static void hooked_startUpdatesAOP(id self, SEL _cmd, BOOL physical, id aopAngle) {
  gRelay = self;
  orig_startUpdatesAOP(self, _cmd, physical, aopAngle);
}

/// devicectl lost its hinge reader in Xcode 27.2, so publish the angle for get-fold.
static void hooked_setEffectiveAngle(id self, SEL _cmd, id angle) {
  orig_setEffectiveAngle(self, _cmd, angle);
  if (![angle respondsToSelector:@selector(doubleValue)]) return;
  [[NSString stringWithFormat:@"%.1f", [angle doubleValue]]
      writeToFile:gAnglePath atomically:YES encoding:NSUTF8StringEncoding error:nil];
}

/// Feed the relay one of Device Hub's two AVP controls.
static void feedAVP(NSString *source, NSString *type, id value) {
  ((void (*)(id, SEL, id))objc_msgSend)(
      gRelay, NSSelectorFromString(@"processAVPDictionary:"),
      @{@"source": source, @"type": type, @"value": value});
}

static void applyOrientationFromControlFile(void) {
  NSString *raw = [NSString stringWithContentsOfFile:gOrientationPath encoding:NSUTF8StringEncoding error:nil];
  raw = [raw stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
  if (!raw.length) return;
  if (!gRelay) {
    NSLog(@"[conductor-fold] relay not captured yet; ignoring orientation '%@'", raw);
    return;
  }
  feedAVP(@"orientation-picker-control", @"enum", raw);
  NSLog(@"[conductor-fold] orientation=%@", raw);
}

static void applyAngleFromControlFile(void) {
  NSString *raw = [NSString stringWithContentsOfFile:gControlPath encoding:NSUTF8StringEncoding error:nil];
  raw = [raw stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
  if (!raw.length) return;
  if (!gRelay) {
    NSLog(@"[conductor-fold] relay not captured yet; ignoring '%@'", raw);
    return;
  }
  double angle = MIN(180.0, MAX(0.0, raw.doubleValue));
  feedAVP(@"hinge-slider-control", @"range", @(angle));
  NSLog(@"[conductor-fold] angle=%.1f", angle);
}

static dispatch_source_t watchControlFile(NSString *path, dispatch_block_t handler) {
  [NSFileManager.defaultManager createFileAtPath:path contents:[NSData data] attributes:nil];
  int fd = open(path.fileSystemRepresentation, O_EVTONLY);
  if (fd < 0) {
    NSLog(@"[conductor-fold] cannot watch %@: %s", path, strerror(errno));
    return nil;
  }
  dispatch_source_t src = dispatch_source_create(
      DISPATCH_SOURCE_TYPE_VNODE, fd,
      DISPATCH_VNODE_WRITE | DISPATCH_VNODE_EXTEND | DISPATCH_VNODE_ATTRIB,
      dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0));
  dispatch_source_set_event_handler(src, handler);
  dispatch_source_set_cancel_handler(src, ^{ close(fd); });
  dispatch_resume(src);
  return src;
}

static void swizzle(Class cls, NSString *sel, IMP replacement, void *origOut) {
  Method m = class_getInstanceMethod(cls, NSSelectorFromString(sel));
  if (!m) return;
  *(IMP *)origOut = method_getImplementation(m);
  method_setImplementation(m, replacement);
}

__attribute__((constructor)) static void conductorFoldInit(void) {
  @autoreleasepool {
    if (![NSProcessInfo.processInfo.processName isEqualToString:@"locationd"]) return;

    Class relay = objc_getClass("CMDeviceStateRelayManager");
    if (!relay) {
      NSLog(@"[conductor-fold] CMDeviceStateRelayManager unavailable — runtime has no fold support");
      return;
    }
    swizzle(relay, @"startUpdatesForPhysicalDevice:", (IMP)hooked_startUpdates, &orig_startUpdates);
    swizzle(relay, @"startUpdatesForPhysicalDevice:aopAngle:", (IMP)hooked_startUpdatesAOP, &orig_startUpdatesAOP);
    if (!orig_startUpdates && !orig_startUpdatesAOP) {
      NSLog(@"[conductor-fold] relay API changed — fold control unavailable");
      return;
    }

    NSString *udid = NSProcessInfo.processInfo.environment[@"SIMULATOR_UDID"] ?: @"unknown";
    gControlPath = [NSString stringWithFormat:@"/tmp/conductor-fold-%@", udid];
    gOrientationPath = [NSString stringWithFormat:@"/tmp/conductor-orientation-%@", udid];
    gAnglePath = [gControlPath stringByAppendingPathExtension:@"angle"];
    [NSFileManager.defaultManager removeItemAtPath:gAnglePath error:nil];
    swizzle(relay, @"setEffectiveAngle:", (IMP)hooked_setEffectiveAngle, &orig_setEffectiveAngle);
    [[NSString stringWithFormat:@"%d", getpid()]
        writeToFile:[gControlPath stringByAppendingPathExtension:@"pid"]
         atomically:YES encoding:NSUTF8StringEncoding error:nil];

    gControlSource = watchControlFile(gControlPath, ^{ applyAngleFromControlFile(); });
    gOrientationSource = watchControlFile(gOrientationPath, ^{ applyOrientationFromControlFile(); });
    if (!gControlSource || !gOrientationSource) return;
    NSLog(@"[conductor-fold] ready (%@)", gControlPath);
  }
}
