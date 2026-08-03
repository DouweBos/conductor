#import "ReactPropsBridge.h"
#import <objc/runtime.h>

// The typed react::ViewProps struct layout is only knowable with RN's own C++
// headers — reading its fields by blind offset would risk crashing the host app.
// So the real C++ path is compiled only when those headers are reachable; the
// shipped generic driver build has no app Pods on its include path and takes the
// degrade path. To enable the real path, build with the target app's
// React-Core / RCT-Folly headers on -I and this lights up automatically.
#if __has_include(<react/renderer/core/Props.h>) && __has_include(<folly/json.h>)
#define CONDUCTOR_HAS_RN_FABRIC 1
#import <react/renderer/core/Props.h>
#import <folly/dynamic.h>
#import <folly/json.h>
using facebook::react::Props;
#endif

@implementation ReactPropsBridge

+ (BOOL)isFabricView:(UIView *)view {
    Class fabric = NSClassFromString(@"RCTViewComponentView");
    return fabric != nil && [view isKindOfClass:fabric];
}

+ (nullable NSString *)rawPropsJSON:(UIView *)view note:(NSString *_Nullable *_Nullable)note {
    if (![self isFabricView:view]) {
        if (note) { *note = @"not a React Native Fabric view"; }
        return nil;
    }
#if CONDUCTOR_HAS_RN_FABRIC
    @try {
        // `_props` is a react::Props::Shared (std::shared_ptr<const Props>) ivar
        // on RCTViewComponentView. Reading the shared_ptr's held pointer is
        // stable libc++ ABI; the field offsets *inside* Props are not — hence we
        // only touch rawProps via its public folly::dynamic accessor.
        const Props *props = nullptr;
        for (Class c = [view class]; c != nil; c = class_getSuperclass(c)) {
            Ivar ivar = class_getInstanceVariable(c, "_props");
            if (ivar == nullptr) { continue; }
            ptrdiff_t offset = ivar_getOffset(ivar);
            auto *shared = reinterpret_cast<const std::shared_ptr<const Props> *>(
                reinterpret_cast<const char *>((__bridge const void *)view) + offset);
            props = shared ? shared->get() : nullptr;
            break;
        }
        if (props == nullptr) {
            if (note) { *note = @"Fabric view has no _props"; }
            return nil;
        }
        const folly::dynamic &raw = props->rawProps;
        if (raw.isNull() || (raw.isObject() && raw.empty())) {
            if (note) { *note = @"rawProps not retained in this build"; }
            return nil;
        }
        std::string json = folly::toJson(raw);
        return [[NSString alloc] initWithBytes:json.data() length:json.size() encoding:NSUTF8StringEncoding];
    } @catch (NSException *e) {
        if (note) { *note = e.reason ?: @"rawProps extraction failed"; }
        return nil;
    } @catch (...) {
        if (note) { *note = @"rawProps extraction failed (C++ exception)"; }
        return nil;
    }
#else
    if (note) {
        *note = @"rawProps unavailable: React Native C++ headers not on this build's include path";
    }
    return nil;
#endif
}

@end
