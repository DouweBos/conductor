import Foundation
import XCTest
import os

struct RunningApp {
    
    static let springboardBundleId = "com.apple.springboard"
    private static let logger = Logger(
        subsystem: Bundle.main.bundleIdentifier!,
        category: String(describing: Self.self)
    )
    private init() {}
    
    static func getForegroundAppId(_ appIds: [String]) -> String {
        if appIds.isEmpty {
            logger.info("Empty installed apps found")
            return ""
        }
        
        return appIds.first { appId in
            let app = XCUIApplication(bundleIdentifier: appId)
            
            return app.state == .runningForeground
        } ?? RunningApp.springboardBundleId
    }
    
    // Bundle IDs that are structurally "foreground" in iPadOS 26 / Stage Manager
    // (they host or decorate the UI) but are never the user-meaningful app.
    private static let shellBundleIds: Set<String> = [
        "com.apple.springboard",
        "com.apple.HeadBoard",
        "com.apple.DocumentManager.DockFolderViewService",
    ]

    static func getForegroundApp() -> XCUIApplication? {
        // activeAppsInfo gives (pid, bundleId) pairs from the AX client. Bind by
        // PID via the helper, because plain XCUIApplication(bundleIdentifier:)
        // resolves through scene lookup, which in iPadOS 26 windowed / Stage
        // Manager modes can return a shell process (DockFolderViewService, etc.)
        // instead of the real foreground app. Overriding processID on the
        // XCUIApplication keeps .snapshot() targeted at the correct process.
        let runningApps = XCUIApplication.activeAppsInfo() ?? []
        let descriptions = runningApps.map { (info: [String: Any]) -> String in
            "\(info["bundleId"] ?? "?")[\(info["pid"] ?? "?")]"
        }
        NSLog("Detected running apps: \(descriptions)")

        // Under iPadOS 26 windowing, SpringBoard / DockFolderViewService /
        // HeadBoard frequently report .runningForeground because they host the
        // scene chrome. Prefer any non-shell app before considering them.
        let nonShell = runningApps.filter { info in
            guard let bundleId = info["bundleId"] as? String else { return false }
            return !shellBundleIds.contains(bundleId)
        }

        func toApp(_ info: [String: Any]) -> XCUIApplication? {
            guard let pid = (info["pid"] as? NSNumber)?.int32Value,
                  let bundleId = info["bundleId"] as? String else { return nil }
            return XCUIApplication.conductor_application(withBundleID: bundleId, processID: pid)
        }

        let nonShellApps = nonShell.compactMap(toApp)
        let stateDescriptions = nonShellApps.map { app -> String in
            "\(app.bundleID)=\(app.state.rawValue)"
        }
        NSLog("Non-shell apps: \(nonShellApps.count), states: \(stateDescriptions)")

        if let app = nonShellApps.first(where: { $0.state == .runningForeground }) {
            return app
        }
        if let first = nonShellApps.first {
            NSLog("No non-shell app is .runningForeground; returning first non-shell: \(first.bundleID)")
            return first
        }
        // No user app is active (home screen / transition) — fall back to any
        // foreground shell so callers have something to read.
        return runningApps.compactMap(toApp).first { $0.state == .runningForeground }
    }
    
}
