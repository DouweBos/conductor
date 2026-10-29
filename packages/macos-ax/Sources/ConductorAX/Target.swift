import AppKit
import ApplicationServices
import ScreenCaptureKit

/// The app under test and its front window — the Mac stand-in for "the device
/// screen". Every coordinate exchanged with the CLI is relative to the window's
/// top-left, matching the screenshot.
struct Target {
    /// Set by /launchApp and /target. Without it we follow the frontmost app.
    static var bundleId: String? {
        didSet { if oldValue != bundleId { windowTitle = nil } }
    }
    /// Set by `window focus`: drive this window instead of the app's front one.
    static var windowTitle: String?

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
        let onScreen = visibleWindows().filter { $0.pid == pid }
        if let title = windowTitle, let chosen = window(titled: title, in: app),
           let frame = AX.frame(chosen), let cg = onScreen.first(where: { close($0.bounds, frame) }) {
            return Target(pid: pid, bundleId: bundleId, app: app, windowID: cg.id, frame: cg.bounds, window: chosen)
        }
        // The main window, else the frontmost standard one: a hover card or menu
        // panel in front must not become the coordinate origin.
        let axWindows = windows(of: app)
        let main: AXUIElement? = AX.attr(app, kAXMainWindowAttribute)
        let standard = axWindows.filter { AX.string($0, kAXSubroleAttribute) == kAXStandardWindowSubrole }
        for candidates in [main.map { [$0] } ?? [], standard, axWindows] {
            for cg in onScreen {
                if let el = candidates.first(where: { AX.frame($0).map { close($0, cg.bounds) } == true }) {
                    return Target(pid: pid, bundleId: bundleId, app: app, windowID: cg.id, frame: cg.bounds, window: el)
                }
            }
        }
        if let front = onScreen.first {
            return Target(pid: pid, bundleId: bundleId, app: app, windowID: front.id, frame: front.bounds, window: nil)
        }
        let display = CGDisplayBounds(CGMainDisplayID())
        return Target(pid: pid, bundleId: bundleId, app: app, windowID: nil, frame: display, window: nil)
    }

    static func windows(of app: AXUIElement) -> [AXUIElement] {
        AX.children(app).filter { AX.role($0) == kAXWindowRole }
    }

    /// Exact title first, then the first title containing it (both case-insensitive).
    static func window(titled title: String, in app: AXUIElement) -> AXUIElement? {
        let all = windows(of: app)
        let t = { (el: AXUIElement) in AX.string(el, kAXTitleAttribute) ?? "" }
        return all.first { t($0).compare(title, options: .caseInsensitive) == .orderedSame }
            ?? all.first { t($0).range(of: title, options: .caseInsensitive) != nil }
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

    /// The app's other on-screen windows in front of the driven one and overlapping
    /// it — child panels, hover cards, popovers, open menus — front to back.
    func overlays() -> [(id: CGWindowID, bounds: CGRect)] {
        guard let windowID else { return [] }
        let list = CGWindowListCopyWindowInfo([.optionOnScreenAboveWindow], windowID) as? [[String: Any]] ?? []
        return list.compactMap { info in
            guard (info[kCGWindowOwnerPID as String] as? pid_t) == pid,
                  (info[kCGWindowAlpha as String] as? Double ?? 1) > 0,
                  let dict = info[kCGWindowBounds as String] as? NSDictionary,
                  let bounds = CGRect(dictionaryRepresentation: dict), bounds.intersects(frame),
                  let id = info[kCGWindowNumber as String] as? CGWindowID
            else { return nil }
            return (id, bounds)
        }
    }

    /// AX windows of the app backing `overlays()`.
    func overlayElements() -> [AXUIElement] {
        let bounds = overlays().map(\.bounds)
        guard !bounds.isEmpty else { return [] }
        return Target.windows(of: app).filter { el in
            if let window, CFEqual(el, window) { return false }
            guard let f = AX.frame(el) else { return false }
            return bounds.contains { close($0, f) }
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
        let above = overlays()
        let image = above.isEmpty
            ? try Capture.window(windowID)
            : try Capture.composite([windowID] + above.map(\.id), crop: frame)
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

    /// The given windows composited as on screen, cropped to `crop` (global
    /// points). Windows of other apps are left out, so covering ones don't show.
    static func composite(_ ids: [CGWindowID], crop: CGRect) throws -> CGImage {
        let done = DispatchSemaphore(value: 0)
        var result: Result<CGImage, Error> = .failure(DriverError(.timeout, "screenshot timed out"))
        Task {
            do {
                let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
                let windows = content.windows.filter { ids.contains($0.windowID) }
                let centre = CGPoint(x: crop.midX, y: crop.midY)
                guard !windows.isEmpty,
                      let display = content.displays.first(where: { $0.frame.contains(centre) }) ?? content.displays.first
                else { throw DriverError("window \(ids[0]) is no longer available") }
                let filter = SCContentFilter(display: display, including: windows)
                let config = SCStreamConfiguration()
                let scale = CGFloat(filter.pointPixelScale)
                config.sourceRect = crop.offsetBy(dx: -display.frame.minX, dy: -display.frame.minY)
                config.width = Int(crop.width * scale)
                config.height = Int(crop.height * scale)
                config.showsCursor = false
                result = .success(try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config))
            } catch let error as DriverError {
                result = .failure(error)
            } catch {
                result = .failure(DriverError("screenshot failed (\(error.localizedDescription))"))
            }
            done.signal()
        }
        _ = done.wait(timeout: .now() + 10)
        return try result.get()
    }
}
