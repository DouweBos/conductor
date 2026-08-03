#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

/// Reads React Native Fabric props off a host component view. The typed
/// `ViewProps` are reconstructed Swift-side from the mounted view; this shim's
/// job is the C++-only bit: dumping `react::Props::rawProps` (a folly::dynamic)
/// to JSON. That path only compiles when the build has RN's C++ headers on the
/// include path (guarded by __has_include); otherwise it degrades to nil + note.
@interface ReactPropsBridge : NSObject

/// True for `RCTViewComponentView` and subclasses (every Fabric host view).
+ (BOOL)isFabricView:(UIView *)view;

/// `react::Props::rawProps` serialized to a JSON string, or nil. On nil, `note`
/// explains why (headers absent, rawProps not retained, or extraction failed).
/// Never throws — any ObjC/C++ failure degrades to nil + note.
+ (nullable NSString *)rawPropsJSON:(UIView *)view note:(NSString *_Nullable *_Nullable)note;

@end

NS_ASSUME_NONNULL_END
