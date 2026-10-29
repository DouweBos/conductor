import AppKit
import ApplicationServices
import CryptoKit

// Background macOS driver: serves the XCUITest driver's HTTP contract on
// loopback, but drives the target app through Accessibility so it never takes
// over the user's pointer or keyboard.

func body<T: Decodable>(_ req: HTTPRequest, _: T.Type) throws -> T {
    do { return try JSONDecoder().decode(T.self, from: req.body) } catch {
        throw DriverError(.precondition, "incorrect request body for \(req.path)")
    }
}

struct Point: Decodable { let x: Double; let y: Double; let duration: Double?; let modifiers: [String]?; let count: Int? }
struct Swipe: Decodable { let startX: Double; let startY: Double; let endX: Double; let endY: Double }
struct ScrollBy: Decodable { let x: Double; let y: Double; let deltaX: Double; let deltaY: Double }
struct Text: Decodable { let text: String }
struct Erase: Decodable { let charactersToErase: Int }
struct Key: Decodable { let key: String; let modifiers: [String]? }
struct Bundle: Decodable { let bundleId: String }
struct AppId: Decodable { let appId: String }
struct MenuPath: Decodable { let path: [String] }
struct OutputPath: Decodable { let path: String }
struct WindowChange: Decodable { let title: String?; let width: Double?; let height: Double?; let x: Double?; let y: Double? }

let needsForeground = "needs the real pointer — set CONDUCTOR_MACOS_FOREGROUND=1 to use the foreground driver"

func hierarchy() throws -> [String: Any] {
    let target = try Target.resolve()
    var snap = AXSnapshot(origin: target.frame.origin)
    var appNode = snap.node(target.app, descend: { _, _ in false })
    // The app's label is its name; leaving it would make it match a same-named row.
    appNode["label"] = ""
    appNode.removeValue(forKey: "title")
    var kids: [[String: Any]] = []
    // Child panels, popovers and hover cards over the window show in the
    // screenshot too, so they belong in the tree.
    let overlays = target.overlayElements()
    for kid in AX.children(target.app) {
        if overlays.contains(where: { CFEqual($0, kid) }) { continue }
        // Only the front window: the others sit behind what the screenshot shows.
        if AX.role(kid) == kAXWindowRole, let front = target.window, !CFEqual(kid, front) { continue }
        kids.append(snap.node(kid, depth: 1, descend: { el, role in
            // Closed menus are huge and invisible; only walk into the open one.
            role != kAXMenuBarItemRole || (AX.attr(el, kAXSelectedAttribute) as Bool?) == true
        }))
    }
    kids += overlays.map { snap.node($0, depth: 1) }
    appNode["children"] = kids
    let root: [String: Any] = [
        "identifier": "", "label": "", "elementType": 0, "enabled": true, "selected": false,
        "hasFocus": false, "frame": ["X": 0, "Y": 0, "Width": 0, "Height": 0], "children": [appNode],
    ]
    func depth(_ n: [String: Any]) -> Int {
        1 + ((n["children"] as? [[String: Any]])?.map(depth).max() ?? 0)
    }
    return ["axElement": root, "depth": depth(root)]
}

enum Windows {
    /// Focus a window by title and/or move and resize the target window. Sizes
    /// and positions are in points; x/y are global screen coordinates.
    static func change(_ c: WindowChange) throws -> [String: Any] {
        var target = try Target.resolve()
        if let title = c.title {
            if title.isEmpty {
                Target.windowTitle = nil
            } else {
                guard let el = Target.window(titled: title, in: target.app) else {
                    let titles = Target.windows(of: target.app).map { AX.string($0, kAXTitleAttribute) ?? "" }
                    throw DriverError(.precondition, "\(target.bundleId) has no window titled \"\(title)\" "
                        + "(windows: \(titles.map { "\"\($0)\"" }.joined(separator: ", ")))")
                }
                if (AX.attr(el, kAXMinimizedAttribute) as Bool?) == true { AX.set(el, kAXMinimizedAttribute, kCFBooleanFalse) }
                AX.perform(el, kAXRaiseAction)
                Target.windowTitle = AX.string(el, kAXTitleAttribute) ?? title
                Thread.sleep(forTimeInterval: 0.2)
            }
            target = try Target.resolve()
            WindowCapture.shared.retarget(target)
        }
        if c.width != nil || c.height != nil || c.x != nil || c.y != nil {
            guard let el = target.window, let frame = AX.frame(el) else {
                throw DriverError(.precondition, "\(target.bundleId) has no window on screen")
            }
            if c.x != nil || c.y != nil {
                var origin = CGPoint(x: c.x ?? frame.minX, y: c.y ?? frame.minY)
                guard let v = AXValueCreate(.cgPoint, &origin), AX.set(el, kAXPositionAttribute, v) else {
                    throw DriverError(.precondition, "the window can't be moved")
                }
            }
            if c.width != nil || c.height != nil {
                var size = CGSize(width: c.width ?? frame.width, height: c.height ?? frame.height)
                guard AX.isSettable(el, kAXSizeAttribute), let v = AXValueCreate(.cgSize, &size),
                      AX.set(el, kAXSizeAttribute, v) else {
                    throw DriverError(.precondition, "the window can't be resized")
                }
            }
            Thread.sleep(forTimeInterval: 0.2)
            target = try Target.resolve()
        }
        let f = target.window.flatMap(AX.frame) ?? target.frame
        return [
            "title": target.window.flatMap { AX.string($0, kAXTitleAttribute) } ?? "",
            "frame": ["x": f.minX, "y": f.minY, "width": f.width, "height": f.height],
        ]
    }
}

func handle(_ req: HTTPRequest) throws -> HTTPResponse {
    switch req.path {
    case "status":
        return .json([
            "status": "ok", "mode": "background",
            "accessibility": AXIsProcessTrusted(), "screenRecording": CGPreflightScreenCaptureAccess(),
            "pid": Int(ProcessInfo.processInfo.processIdentifier),
            "executable": executable.path, "built": executable.built,
        ])
    case "deviceInfo":
        let t = try Target.resolve()
        return .json([
            "widthPoints": Int(t.frame.width), "heightPoints": Int(t.frame.height),
            "widthPixels": Int(t.frame.width * t.scale), "heightPixels": Int(t.frame.height * t.scale),
            "platform": "MACOS",
        ])
    case "viewHierarchy":
        return .json(try hierarchy())
    case "queryElement":
        // No fast path: the CLI falls back to matching against the hierarchy.
        return .json(["found": false, "matchCount": 0])
    case "screenshot":
        let png = try Target.resolve().screenshotPNG()
        if req.query["compressed"] == "true",
           let jpeg = NSBitmapImageRep(data: png)?.representation(using: .jpeg, properties: [.compressionFactor: 0.5]) {
            return HTTPResponse(contentType: "image/jpeg", body: jpeg)
        }
        return HTTPResponse(contentType: "image/png", body: png)
    case "isScreenStatic":
        let t = try Target.resolve()
        let a = SHA256.hash(data: try t.screenshotPNG()), b = SHA256.hash(data: try t.screenshotPNG())
        return .json(["isScreenStatic": a == b])
    case "touch":
        let p = try body(req, Point.self)
        if p.duration != nil { throw DriverError(.precondition, "long press \(needsForeground)") }
        if !(p.modifiers ?? []).isEmpty { throw DriverError(.precondition, "modifier clicks \(needsForeground)") }
        try Actions.click(CGPoint(x: p.x, y: p.y), count: p.count ?? 1, in: try Target.resolve())
    case "rightClick":
        let p = try body(req, Point.self)
        try Actions.rightClick(CGPoint(x: p.x, y: p.y), in: try Target.resolve())
    case "swipe":
        // A swipe on a Mac means scrolling the content the way a finger would.
        let s = try body(req, Swipe.self)
        try Actions.scroll(CGPoint(x: s.startX, y: s.startY), dx: s.endX - s.startX, dy: s.endY - s.startY,
                           in: try Target.resolve())
    case "scroll":
        let s = try body(req, ScrollBy.self)
        try Actions.scroll(CGPoint(x: s.x, y: s.y), dx: s.deltaX, dy: s.deltaY, in: try Target.resolve())
    case "inputText":
        Actions.inputText(try body(req, Text.self).text, in: try Target.resolve())
    case "replaceText":
        try Actions.replaceText(try body(req, Text.self).text, in: try Target.resolve())
    case "eraseText":
        Actions.eraseText(try body(req, Erase.self).charactersToErase, in: try Target.resolve())
    case "pressKey":
        let k = try body(req, Key.self)
        guard Keys.isKnown(k.key) else { throw DriverError(.precondition, "Unknown key \(k.key)") }
        Keys.press(k.key, modifiers: k.modifiers ?? [], pid: try Target.resolve().pid)
    case "keyboard":
        return .json(["isKeyboardVisible": false])
    case "launchApp":
        try Actions.launch(try body(req, Bundle.self).bundleId)
    case "terminateApp":
        Actions.terminate(try body(req, AppId.self).appId)
    case "runningApp":
        return .json(["runningAppBundleId": Target.runningTarget() ?? Target.frontmostBundleId() ?? ""])
    case "target":
        let id = try body(req, Bundle.self).bundleId
        Target.bundleId = id.isEmpty ? nil : id
    case "menu":
        try Actions.menu(try body(req, MenuPath.self).path, in: try Target.resolve())
    case "restoreFocus":
        return .json(["restoredBundleId": ""])
    case "setPermissions":
        break
    case "recording/start":
        try WindowCapture.shared.startRecording(to: try body(req, OutputPath.self).path, target: try Target.resolve())
    case "recording/stop":
        return .json(["path": try WindowCapture.shared.stopRecording()])
    case "stream/start":
        return .json(["port": Int(try WindowCapture.shared.startStreaming(target: try Target.resolve()))])
    case "stream/stop":
        WindowCapture.shared.stopStreaming()
    case "windows":
        let t = try Target.resolve()
        let overlays = t.overlayElements()
        return .json(["windows": Target.windows(of: t.app).map { el -> [String: Any] in
            let f = AX.frame(el) ?? .zero
            return [
                "title": AX.string(el, kAXTitleAttribute) ?? "",
                "subrole": AX.string(el, kAXSubroleAttribute) ?? "",
                "overlay": overlays.contains { CFEqual($0, el) },
                "frame": ["x": f.minX, "y": f.minY, "width": f.width, "height": f.height],
                "focused": t.window.map { CFEqual($0, el) } ?? false,
                "minimized": (AX.attr(el, kAXMinimizedAttribute) as Bool?) ?? false,
            ]
        }])
    case "window":
        return .json(try Windows.change(try body(req, WindowChange.self)))
    case "hover":
        // Tracking areas (SwiftUI .onHover, tooltips) are fed by the WindowServer
        // from the real cursor; pointer events posted to the app don't reach them.
        throw DriverError(.precondition, "hover can't run in the background: .onHover and tracking areas only "
            + "follow the real pointer — set CONDUCTOR_MACOS_FOREGROUND=1 to use the foreground driver")
    case "drag", "gesturePath":
        throw DriverError(.precondition, "\(req.path) \(needsForeground)")
    case "pressButton", "setOrientation":
        throw DriverError(.precondition, "\(req.path) is not supported on macOS")
    default:
        return .json(["error": "not found"], status: 404)
    }
    return .ok
}

/// Lets the CLI spot a helper left running from an older or rebuilt binary.
let executable: (path: String, built: Double) = {
    let path = Foundation.Bundle.main.executablePath ?? CommandLine.arguments[0]
    let date = (try? FileManager.default.attributesOfItem(atPath: path)[.modificationDate]) as? Date
    return (path, date?.timeIntervalSince1970 ?? 0)
}()

var port: UInt16 = 6075
let args = CommandLine.arguments
if let i = args.firstIndex(of: "--port"), i + 1 < args.count, let p = UInt16(args[i + 1]) { port = p }

// Ask once up front so the system prompts appear when the driver starts, not
// halfway through a command.
_ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue(): true] as CFDictionary)
if !CGPreflightScreenCaptureAccess() { _ = CGRequestScreenCaptureAccess() }

let server = try HTTPServer(port: port) { req in
    do { return try handle(req) } catch let error as DriverError { return error.response } catch {
        return DriverError(error.localizedDescription).response
    }
}
server.start()

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
app.run()
