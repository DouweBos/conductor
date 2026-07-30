#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Bridges ObjC exceptions to Swift so runtime introspection (arbitrary KVC,
/// heap reads) can't crash the host app on a bad key/selector.
@interface ConductorObjC : NSObject
+ (nullable id)catching:(id _Nullable (^)(void))block error:(NSString *_Nullable *_Nullable)errorMessage;
@end

NS_ASSUME_NONNULL_END
