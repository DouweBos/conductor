#import <XCTest/XCTest.h>

@interface XCUIApplication (Helper)

+ (NSArray<NSDictionary<NSString *, id> *> *)activeAppsInfo;
+ (nullable XCUIApplication *)conductor_applicationWithBundleID:(NSString *)bundleID processID:(pid_t)pid;
/// Private -interfaceOrientation (UIInterfaceOrientation raw value), 0 when unavailable.
- (NSInteger)conductor_interfaceOrientation;

@end
