import Foundation
import XCTest
import os
#if os(macOS)
import AppKit
#endif

struct RunningApp {
    
    static let springboardBundleId = "com.apple.springboard"
    /// Always-running shell app that stands in when nothing else is foreground.
    #if os(macOS)
    static let homeBundleId = "com.apple.finder"
    #else
    static let homeBundleId = springboardBundleId
    #endif
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
        } ?? RunningApp.homeBundleId
    }
    
    // Bundle IDs that are structurally "foreground" in iPadOS 26 / Stage Manager
    // (they host or decorate the UI) but are never the user-meaningful app.
    private static let shellBundleIds: Set<String> = [
        "com.apple.springboard",
        "com.apple.HeadBoard",
        "com.apple.DocumentManager.DockFolderViewService",
    ]

    #if os(macOS)
    /// The app owning the frontmost on-screen window. WindowServer is queried
    /// directly rather than NSWorkspace, whose frontmostApplication only updates
    /// when this process's run loop gets to process activation notifications.
    /// The app under test when one is set and running, else the frontmost app.
    static func getForegroundApp() -> XCUIApplication? {
        (MacTarget.runningBundleId() ?? foregroundBundleId()).map { XCUIApplication(bundleIdentifier: $0) }
    }

    /// Normal app windows on screen, front to back, in AX (top-left origin) coordinates.
    static func visibleWindows() -> [(pid: pid_t, bounds: CGRect)] {
        let ownPid = ProcessInfo.processInfo.processIdentifier
        let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        let windows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] ?? []
        return windows.compactMap { info in
            // Skip invisible and sliver-sized helper windows some apps keep on screen.
            guard (info[kCGWindowLayer as String] as? Int) == 0,
                  (info[kCGWindowAlpha as String] as? Double ?? 1) > 0,
                  let dict = info[kCGWindowBounds as String] as? NSDictionary,
                  let bounds = CGRect(dictionaryRepresentation: dict),
                  bounds.width > 40, bounds.height > 40,
                  let pid = info[kCGWindowOwnerPID as String] as? pid_t, pid != ownPid
            else { return nil }
            return (pid, bounds)
        }
    }

    /// The app owning the frontmost on-screen window.
    static func foregroundBundleId() -> String? {
        for window in visibleWindows() {
            if let id = NSRunningApplication(processIdentifier: window.pid)?.bundleIdentifier { return id }
        }
        return NSWorkspace.shared.frontmostApplication?.bundleIdentifier
    }
    #else
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
    #endif
    
}
