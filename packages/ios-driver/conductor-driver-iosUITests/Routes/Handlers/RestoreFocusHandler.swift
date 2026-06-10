import FlyingFox
import XCTest
import os

#if os(tvOS)
import UIKit
#endif

/// Restore foreground focus to the app that was active before the XCUITest runner
/// took over. The runner launching pushes the user's app to background; without
/// this step the runner stays on screen (or, after a home press, the device sits
/// on the home screen) and subsequent inspect/automation commands run against the
/// wrong target.
///
/// Behavior:
///   - List running apps via the AX client.
///   - Drop shell apps (SpringBoard / HeadBoard) and the runner itself.
///   - If a candidate remains, activate it.
///   - Otherwise press the home button so the runner is at least dismissed.
@MainActor
struct RestoreFocusHandler: HTTPHandler {

    private let logger = Logger(
        subsystem: Bundle.main.bundleIdentifier!,
        category: String(describing: Self.self)
    )

    private static let shellBundleIds: Set<String> = [
        "com.apple.springboard",
        "com.apple.HeadBoard",
        "com.apple.DocumentManager.DockFolderViewService",
    ]

    func handleRequest(_ request: FlyingFox.HTTPRequest) async throws -> HTTPResponse {
        let runnerBundleId = Bundle.main.bundleIdentifier ?? ""
        let runningApps = XCUIApplication.activeAppsInfo() ?? []

        let descriptions = runningApps.map { (info: [String: Any]) -> String in
            "\(info["bundleId"] ?? "?")[\(info["pid"] ?? "?")]"
        }
        NSLog("[RestoreFocus] active apps: \(descriptions)")

        let candidates = runningApps.compactMap { (info: [String: Any]) -> String? in
            guard let bundleId = info["bundleId"] as? String else { return nil }
            if RestoreFocusHandler.shellBundleIds.contains(bundleId) { return nil }
            if bundleId == runnerBundleId { return nil }
            return bundleId
        }

        var restored: String? = nil
        if let target = candidates.first {
            NSLog("[RestoreFocus] activating \(target)")
            XCUIApplication(bundleIdentifier: target).activate()
            restored = target
        } else {
            NSLog("[RestoreFocus] no candidate; pressing home")
            #if os(tvOS)
            XCUIRemote.shared.press(.home)
            #else
            XCUIDevice.shared.press(.home)
            #endif
        }

        let response: [String: Any] = ["restoredBundleId": restored ?? ""]
        let data = try JSONSerialization.data(withJSONObject: response)
        return HTTPResponse(statusCode: .ok, body: data)
    }
}
