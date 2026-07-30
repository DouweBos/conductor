#import "ConductorObjC.h"

@implementation ConductorObjC

+ (id)catching:(id (^)(void))block error:(NSString **)errorMessage {
    @try {
        return block();
    } @catch (NSException *exception) {
        if (errorMessage) {
            *errorMessage = exception.reason ?: exception.name ?: @"ObjC exception";
        }
        return nil;
    }
}

@end
