import AppKit
import ApplicationServices
import ScreenCaptureKit

/// The app under test and its front window — the Mac stand-in for "the device
/// screen". Every coordinate exchanged with the CLI is relative to the window's
/// top-left, matching the screenshot.
struct Target {
    /// Set by /launchApp and /target. Without it we follow the frontmost app.
    static var bundleId: String?

    let pid: pid_t
    let bundleId: String
    let app: AXUIElement
    let windowID: CGWindowID?
    /// Global, top-left origin points (the AX / CGWindow coordinate space).
    let frame: CGRect
    let window: AXUIElement?

    static func resolve() throws -> Target {
        guard let bundleId = runningTarget() ?? frontmostBundleId(),
              let running = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first
        else { throw DriverError(.precondition, "no app to drive — launch one with `conductor launch-app <bundleId>`") }
        let pid = running.processIdentifier
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 2)

        // WindowServer knows which of the app's windows is really in front; AX
        // also lists offscreen and helper windows.
        if let front = visibleWindows().first(where: { $0.pid == pid }) {
            let axWindow = AX.children(app).first { el in
                AX.role(el) == kAXWindowRole && AX.frame(el).map { close($0, front.bounds) } == true
            }
            return Target(pid: pid, bundleId: bundleId, app: app, windowID: front.id,
                          frame: front.bounds, window: axWindow)
        }
        let display = CGDisplayBounds(CGMainDisplayID())
        return Target(pid: pid, bundleId: bundleId, app: app, windowID: nil, frame: display, window: nil)
    }

    static func runningTarget() -> String? {
        guard let id = bundleId, !NSRunningApplication.runningApplications(withBundleIdentifier: id).isEmpty
        else { return nil }
        return id
    }

    static func frontmostBundleId() -> String? {
        for w in visibleWindows() {
            if let id = NSRunningApplication(processIdentifier: w.pid)?.bundleIdentifier { return id }
        }
        return NSWorkspace.shared.frontmostApplication?.bundleIdentifier
    }

    /// Normal app windows on screen, front to back.
    static func visibleWindows() -> [(pid: pid_t, id: CGWindowID, bounds: CGRect)] {
        let own = ProcessInfo.processInfo.processIdentifier
        let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
            as? [[String: Any]] ?? []
        return list.compactMap { info in
            guard (info[kCGWindowLayer as String] as? Int) == 0,
                  (info[kCGWindowAlpha as String] as? Double ?? 1) > 0,
                  let dict = info[kCGWindowBounds as String] as? NSDictionary,
                  let bounds = CGRect(dictionaryRepresentation: dict),
                  bounds.width > 40, bounds.height > 40,
                  let pid = info[kCGWindowOwnerPID as String] as? pid_t, pid != own,
                  let id = info[kCGWindowNumber as String] as? CGWindowID
            else { return nil }
            return (pid, id, bounds)
        }
    }

    func toGlobal(_ p: CGPoint) -> CGPoint {
        CGPoint(x: frame.minX + p.x, y: frame.minY + p.y)
    }

    /// Pixels per point on the window's display.
    var scale: CGFloat {
        let primary = NSScreen.screens.first?.frame.height ?? 0
        let centre = CGPoint(x: frame.midX, y: primary - frame.midY)
        return (NSScreen.screens.first { $0.frame.contains(centre) } ?? NSScreen.main)?.backingScaleFactor ?? 2
    }

    /// PNG of the window. ScreenCaptureKit captures it even when covered or on
    /// another display, without bringing it forward.
    func screenshotPNG() throws -> Data {
        guard let windowID else { throw DriverError(.precondition, "\(bundleId) has no window on screen") }
        let image = try Capture.window(windowID)
        guard let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
            throw DriverError("could not encode the screenshot")
        }
        return png
    }
}

private func close(_ a: CGRect, _ b: CGRect) -> Bool {
    abs(a.minX - b.minX) < 2 && abs(a.minY - b.minY) < 2 && abs(a.width - b.width) < 2
        && abs(a.height - b.height) < 2
}

enum Capture {
    static func window(_ id: CGWindowID) throws -> CGImage {
        let done = DispatchSemaphore(value: 0)
        var result: Result<CGImage, Error> = .failure(DriverError(.timeout, "screenshot timed out"))
        Task {
            do {
                let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
                guard let window = content.windows.first(where: { $0.windowID == id }) else {
                    throw DriverError("window \(id) is no longer available")
                }
                let filter = SCContentFilter(desktopIndependentWindow: window)
                let config = SCStreamConfiguration()
                let scale = CGFloat(filter.pointPixelScale)
                config.width = Int(window.frame.width * scale)
                config.height = Int(window.frame.height * scale)
                config.showsCursor = false
                if #available(macOS 14.2, *) { config.ignoreShadowsSingleWindow = true }
                result = .success(try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config))
            } catch let error as DriverError {
                result = .failure(error)
            } catch {
                result = .failure(DriverError(
                    "screenshot failed (\(error.localizedDescription)) — allow ConductorAX in System Settings ▸ "
                        + "Privacy & Security ▸ Screen & System Audio Recording, then restart the driver"))
            }
            done.signal()
        }
        _ = done.wait(timeout: .now() + 10)
        return try result.get()
    }
}
