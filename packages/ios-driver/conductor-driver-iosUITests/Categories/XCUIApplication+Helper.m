#import "XCUIApplication+Helper.h"
#import "AXClientProxy.h"
#import "FBLogger.h"
#import "XCTestDaemonsProxy.h"
#import "XCAccessibilityElement.h"
#import "XCTestManager_ManagerInterface-Protocol.h"

@implementation XCUIApplication (Helper)

+ (NSArray<NSDictionary<NSString *, id> *> *)appsInfoWithAxElements:(NSArray<id<XCAccessibilityElement>> *)axElements
{
    NSMutableArray<NSDictionary<NSString *, id> *> *result = [NSMutableArray array];
    id<XCTestManager_ManagerInterface> proxy = [XCTestDaemonsProxy testRunnerProxy];
    for (id<XCAccessibilityElement> axElement in axElements) {
        NSMutableDictionary<NSString *, id> *appInfo = [NSMutableDictionary dictionary];
        pid_t pid = axElement.processIdentifier;
        appInfo[@"pid"] = @(pid);
        __block NSString *bundleId = nil;
        dispatch_semaphore_t sem = dispatch_semaphore_create(0);
        [proxy _XCT_requestBundleIDForPID:pid
                                    reply:^(NSString *bundleID, NSError *error) {
            if (nil == error) {
                bundleId = bundleID;
            } else {
                [FBLogger logFmt:@"Cannot request the bundle ID for process ID %@: %@", @(pid), error.description];
            }
            dispatch_semaphore_signal(sem);
        }];
        dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1 * NSEC_PER_SEC)));
        appInfo[@"bundleId"] = bundleId ?: @"unknowBundleId";
        [result addObject:appInfo.copy];
    }
    return result.copy;
}

+ (NSArray<NSDictionary<NSString *, id> *> *)activeAppsInfo
{
    return [self appsInfoWithAxElements:[AXClientProxy.sharedClient activeApplications]];
}

+ (XCUIApplication *)conductor_applicationWithBundleID:(NSString *)bundleID processID:(pid_t)pid
{
    // iOS 26 removed +[XCUIApplication applicationWithPID:]. We approximate the
    // same binding by constructing via bundle identifier and then overriding the
    // processID via the private setter. That keeps .snapshot() / .query targeted
    // at the PID we discovered via AXClientProxy activeApplications, bypassing
    // scene-based resolution (which in iPadOS 26 windowed / Stage Manager modes
    // can pick the wrong process, e.g. DockFolderViewService).
    XCUIApplication *app = [[XCUIApplication alloc] initWithBundleIdentifier:bundleID];
    SEL setPID = NSSelectorFromString(@"setProcessID:");
    if ([app respondsToSelector:setPID]) {
        IMP imp = [app methodForSelector:setPID];
        void (*fn)(id, SEL, pid_t) = (void *)imp;
        fn(app, setPID, pid);
    } else {
        NSLog(@"[conductor] -setProcessID: not available on XCUIApplication; PID binding skipped");
    }
    return app;
}

@end
