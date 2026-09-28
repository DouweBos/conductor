#if os(macOS)
import AppKit
import FlyingFox
import XCTest

/// The app under test, set by /launchApp and /target. Without it the driver
/// follows the frontmost app — which is often the IDE the user is typing in.
enum MacTarget {
    static var bundleId: String?

    static func runningBundleId() -> String? {
        guard let id = bundleId, !NSRunningApplication.runningApplications(withBundleIdentifier: id).isEmpty
        else { return nil }
        return id
    }
}

/// The Mac stand-in for "the device screen": the target app's front window.
/// Screenshots, the view hierarchy, device info and every input coordinate are
/// relative to this window's top-left, so the CLI's screen-shaped assumptions
/// (hierarchy origin == screenshot origin) hold unchanged.
struct MacScreen {
    let app: XCUIApplication?
    let window: XCUIElement?
    /// Screen-global points, top-left origin (the AX coordinate space).
    let frame: CGRect

    static func current() -> MacScreen {
        guard let bundleId = MacTarget.runningBundleId() ?? RunningApp.foregroundBundleId() else {
            return MacScreen(app: nil, window: nil, frame: mainDisplayFrame())
        }
        let app = XCUIApplication(bundleIdentifier: bundleId)
        let pids = Set(NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).map(\.processIdentifier))
        // WindowServer knows which window is really in front; AX also lists
        // offscreen and sliver helper windows, so match its window by frame.
        if let bounds = RunningApp.visibleWindows().first(where: { pids.contains($0.pid) })?.bounds {
            let window = app.windows.allElementsBoundByIndex.first { el in
                let f = el.frame
                return abs(f.minX - bounds.minX) < 2 && abs(f.minY - bounds.minY) < 2
                    && abs(f.width - bounds.width) < 2 && abs(f.height - bounds.height) < 2
            }
            return MacScreen(app: app, window: window, frame: window?.frame ?? bounds)
        }
        // Windowless apps (menu bar extras, agents) fall back to the whole display.
        return MacScreen(app: app, window: nil, frame: mainDisplayFrame())
    }

    /// Bring the target forward so input reaches it; read-only calls skip this.
    static func forInput() -> MacScreen {
        if let id = MacTarget.runningBundleId(), RunningApp.foregroundBundleId() != id {
            XCUIApplication(bundleIdentifier: id).activate()
        }
        return current()
    }

    static func mainDisplayFrame() -> CGRect {
        CGDisplayBounds(CGMainDisplayID())
    }

    /// Backing scale of the display the window sits on.
    var scale: CGFloat {
        let displayHeight = NSScreen.screens.first?.frame.height ?? 0
        // NSScreen frames are bottom-left origin; flip the window centre to match.
        let centre = CGPoint(x: frame.midX, y: displayHeight - frame.midY)
        let screen = NSScreen.screens.first { $0.frame.contains(centre) } ?? NSScreen.main
        return screen?.backingScaleFactor ?? 2
    }

    func toGlobal(_ point: CGPoint) -> CGPoint {
        CGPoint(x: frame.minX + point.x, y: frame.minY + point.y)
    }

    /// Coordinate for a window-relative point. Anchored to an element that always
    /// exists (the app, else Finder) and offset from its resolved origin, so any
    /// on-screen point is reachable — including the menu bar and other apps.
    func coordinate(_ point: CGPoint) -> XCUICoordinate {
        // The window's frame is exact; an application element's is not on macOS.
        if let window {
            return window.coordinate(withNormalizedOffset: .zero)
                .withOffset(CGVector(dx: point.x, dy: point.y))
        }
        let anchor = app ?? XCUIApplication(bundleIdentifier: "com.apple.finder")
        let origin = anchor.coordinate(withNormalizedOffset: .zero)
        let global = toGlobal(point)
        let base = origin.screenPoint
        return origin.withOffset(CGVector(dx: global.x - base.x, dy: global.y - base.y))
    }

    /// PNG of the window. XCUIElement.screenshot() mis-crops windows on
    /// secondary displays, so capture the display holding it and crop here.
    func screenshotPNG() -> Data {
        guard let display = displayID(containing: frame),
              let screen = XCUIScreen.screens.first(where: { screenDisplayID($0) == display })
        else { return XCUIScreen.main.screenshot().pngRepresentation }
        let shot = screen.screenshot()
        let bounds = CGDisplayBounds(display)
        guard let image = NSBitmapImageRep(data: shot.pngRepresentation)?.cgImage, bounds.width > 0 else {
            return shot.pngRepresentation
        }
        let px = CGFloat(image.width) / bounds.width
        let crop = CGRect(
            x: (frame.minX - bounds.minX) * px, y: (frame.minY - bounds.minY) * px,
            width: frame.width * px, height: frame.height * px
        ).integral.intersection(CGRect(x: 0, y: 0, width: image.width, height: image.height))
        guard let cropped = image.cropping(to: crop),
              let png = NSBitmapImageRep(cgImage: cropped).representation(using: .png, properties: [:])
        else { return shot.pngRepresentation }
        return png
    }

    /// The display showing most of `rect` (global, top-left origin — as CG uses).
    private func displayID(containing rect: CGRect) -> CGDirectDisplayID? {
        var ids = [CGDirectDisplayID](repeating: 0, count: 16)
        var count: UInt32 = 0
        guard CGGetDisplaysWithRect(rect, 16, &ids, &count) == .success, count > 0 else { return nil }
        return ids.prefix(Int(count)).max { a, b in
            let ia = CGDisplayBounds(a).intersection(rect), ib = CGDisplayBounds(b).intersection(rect)
            return ia.width * ia.height < ib.width * ib.height
        }
    }

    private func screenDisplayID(_ screen: XCUIScreen) -> CGDirectDisplayID? {
        (screen.value(forKey: "displayID") as? NSNumber).map { CGDirectDisplayID($0.uint32Value) }
    }

    /// The element keystrokes go to; typing into the app routes to its key window.
    var keyTarget: XCUIElement {
        app ?? XCUIApplication(bundleIdentifier: "com.apple.finder")
    }
}

enum MacKeys {
    static func modifiers(_ names: [String]?) -> XCUIElement.KeyModifierFlags {
        var flags: XCUIElement.KeyModifierFlags = []
        for name in names ?? [] {
            switch name.lowercased() {
            case "cmd", "command", "meta": flags.insert(.command)
            case "shift": flags.insert(.shift)
            case "alt", "option", "opt": flags.insert(.option)
            case "ctrl", "control": flags.insert(.control)
            case "fn", "function": flags.insert(.function)
            case "capslock": flags.insert(.capsLock)
            default: break
            }
        }
        return flags
    }

    /// Named keys map to XCUIKeyboardKey; anything else of length 1 is typed as-is.
    static func key(_ name: String) -> String? {
        switch name.lowercased() {
        case "delete", "backspace": return XCUIKeyboardKey.delete.rawValue
        case "forwarddelete": return XCUIKeyboardKey.forwardDelete.rawValue
        case "return": return XCUIKeyboardKey.return.rawValue
        case "enter": return XCUIKeyboardKey.enter.rawValue
        case "tab": return XCUIKeyboardKey.tab.rawValue
        case "space": return XCUIKeyboardKey.space.rawValue
        case "escape", "esc": return XCUIKeyboardKey.escape.rawValue
        case "up", "uparrow": return XCUIKeyboardKey.upArrow.rawValue
        case "down", "downarrow": return XCUIKeyboardKey.downArrow.rawValue
        case "left", "leftarrow": return XCUIKeyboardKey.leftArrow.rawValue
        case "right", "rightarrow": return XCUIKeyboardKey.rightArrow.rawValue
        case "home": return XCUIKeyboardKey.home.rawValue
        case "end": return XCUIKeyboardKey.end.rawValue
        case "pageup": return XCUIKeyboardKey.pageUp.rawValue
        case "pagedown": return XCUIKeyboardKey.pageDown.rawValue
        case "f1": return XCUIKeyboardKey.F1.rawValue
        case "f2": return XCUIKeyboardKey.F2.rawValue
        case "f3": return XCUIKeyboardKey.F3.rawValue
        case "f4": return XCUIKeyboardKey.F4.rawValue
        case "f5": return XCUIKeyboardKey.F5.rawValue
        case "f6": return XCUIKeyboardKey.F6.rawValue
        case "f7": return XCUIKeyboardKey.F7.rawValue
        case "f8": return XCUIKeyboardKey.F8.rawValue
        case "f9": return XCUIKeyboardKey.F9.rawValue
        case "f10": return XCUIKeyboardKey.F10.rawValue
        case "f11": return XCUIKeyboardKey.F11.rawValue
        case "f12": return XCUIKeyboardKey.F12.rawValue
        default: return name.count == 1 ? name.lowercased() : nil
        }
    }
}

// MARK: - Mac-only routes

struct PointerRequest: Codable {
    let x: Double
    let y: Double
    let modifiers: [String]?
}

struct ScrollRequest: Codable {
    let x: Double
    let y: Double
    let deltaX: Double
    let deltaY: Double
}

struct DragRequest: Codable {
    let startX: Double
    let startY: Double
    let endX: Double
    let endY: Double
    let duration: TimeInterval?
}

struct TargetRequest: Codable {
    /// Empty to go back to following the frontmost app.
    let bundleId: String
}

@MainActor
struct TargetHandler: HTTPHandler {
    func handleRequest(_ request: HTTPRequest) async throws -> HTTPResponse {
        guard let body = try? await JSONDecoder().decode(TargetRequest.self, from: request.bodyData) else {
            return AppError(type: .precondition, message: "incorrect request body for target").httpResponse
        }
        MacTarget.bundleId = body.bundleId.isEmpty ? nil : body.bundleId
        return HTTPResponse(statusCode: .ok)
    }
}

struct MenuRequest: Codable {
    /// Menu-bar path, e.g. ["File", "Export", "PDF…"].
    let path: [String]
}

@MainActor
struct RightClickHandler: HTTPHandler {
    func handleRequest(_ request: HTTPRequest) async throws -> HTTPResponse {
        guard let body = try? await JSONDecoder().decode(PointerRequest.self, from: request.bodyData) else {
            return AppError(type: .precondition, message: "incorrect request body for rightClick").httpResponse
        }
        let target = MacScreen.forInput().coordinate(CGPoint(x: body.x, y: body.y))
        XCUIElement.perform(withKeyModifiers: MacKeys.modifiers(body.modifiers)) {
            target.rightClick()
        }
        return HTTPResponse(statusCode: .ok)
    }
}

@MainActor
struct HoverHandler: HTTPHandler {
    func handleRequest(_ request: HTTPRequest) async throws -> HTTPResponse {
        guard let body = try? await JSONDecoder().decode(PointerRequest.self, from: request.bodyData) else {
            return AppError(type: .precondition, message: "incorrect request body for hover").httpResponse
        }
        MacScreen.forInput().coordinate(CGPoint(x: body.x, y: body.y)).hover()
        return HTTPResponse(statusCode: .ok)
    }
}

@MainActor
struct ScrollHandler: HTTPHandler {
    func handleRequest(_ request: HTTPRequest) async throws -> HTTPResponse {
        guard let body = try? await JSONDecoder().decode(ScrollRequest.self, from: request.bodyData) else {
            return AppError(type: .precondition, message: "incorrect request body for scroll").httpResponse
        }
        MacScreen.forInput()
            .coordinate(CGPoint(x: body.x, y: body.y))
            .scroll(byDeltaX: CGFloat(body.deltaX), deltaY: CGFloat(body.deltaY))
        return HTTPResponse(statusCode: .ok)
    }
}

@MainActor
struct DragHandler: HTTPHandler {
    func handleRequest(_ request: HTTPRequest) async throws -> HTTPResponse {
        guard let body = try? await JSONDecoder().decode(DragRequest.self, from: request.bodyData) else {
            return AppError(type: .precondition, message: "incorrect request body for drag").httpResponse
        }
        let screen = MacScreen.forInput()
        let start = screen.coordinate(CGPoint(x: body.startX, y: body.startY))
        let end = screen.coordinate(CGPoint(x: body.endX, y: body.endY))
        start.click(forDuration: max(body.duration ?? 0.3, 0.1), thenDragTo: end)
        return HTTPResponse(statusCode: .ok)
    }
}

@MainActor
struct MenuHandler: HTTPHandler {
    func handleRequest(_ request: HTTPRequest) async throws -> HTTPResponse {
        guard let body = try? await JSONDecoder().decode(MenuRequest.self, from: request.bodyData),
              let top = body.path.first else {
            return AppError(type: .precondition, message: "menu needs a non-empty path").httpResponse
        }
        guard let app = MacScreen.forInput().app else {
            return AppError(type: .precondition, message: "no frontmost app to open a menu in").httpResponse
        }
        let barItem = app.menuBars.menuBarItems[top]
        guard barItem.waitForExistence(timeout: 2) else {
            return AppError(type: .precondition, message: "menu bar item \"\(top)\" not found").httpResponse
        }
        barItem.click()
        for title in body.path.dropFirst() {
            let item = app.menuBars.menuItems[title]
            guard item.waitForExistence(timeout: 2) else {
                // Leave no menu dangling open when the path is wrong.
                app.typeKey(XCUIKeyboardKey.escape.rawValue, modifierFlags: [])
                return AppError(type: .precondition, message: "menu item \"\(title)\" not found").httpResponse
            }
            item.click()
        }
        return HTTPResponse(statusCode: .ok)
    }
}
#endif
