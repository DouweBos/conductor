import AppKit
import ApplicationServices

/// Input without taking over the Mac: every action goes through an element's
/// accessibility interface, or as key events posted to the target process only.
enum Actions {
    /// The deepest element of the target app at a window-relative point. The hit
    /// test runs inside the app, so windows of other apps covering it don't matter.
    static func element(at point: CGPoint, in target: Target) throws -> AXUIElement {
        let g = target.toGlobal(point)
        // Chromium answers hit tests asynchronously: the first query at a point
        // can return a coarse container, so repeat until the answer settles.
        var last: AXUIElement?
        for attempt in 0..<6 {
            var hit: AXUIElement?
            guard AXUIElementCopyElementAtPosition(target.app, Float(g.x), Float(g.y), &hit) == .success, let hit
            else { break }
            if let last, CFEqual(last, hit) { return hit }
            last = hit
            if attempt < 5 { Thread.sleep(forTimeInterval: 0.04) }
        }
        guard let last else {
            throw DriverError(.precondition, "no element of \(target.bundleId) at (\(Int(point.x)), \(Int(point.y)))")
        }
        return last
    }

    /// Self and ancestors up to (not past) the window.
    static func lineage(_ el: AXUIElement, limit: Int = 8) -> [AXUIElement] {
        var chain = [el]
        var cur = el
        while chain.count < limit, AX.role(cur) != kAXWindowRole, let p = AX.parent(cur) {
            chain.append(p)
            cur = p
        }
        return chain
    }

    static func click(_ point: CGPoint, count: Int, in target: Target) throws {
        let hit = try element(at: point, in: target)
        for el in lineage(hit) {
            let role = AX.role(el)
            if role == kAXTextFieldRole || role == kAXTextAreaRole || role == kAXComboBoxRole {
                AX.set(el, kAXFocusedAttribute, kCFBooleanTrue)
                return
            }
            if AX.actions(el).contains(kAXPressAction) {
                for _ in 0..<max(count, 1) { AX.perform(el, kAXPressAction) }
                return
            }
            // Table and outline rows select rather than press.
            if role == kAXRowRole, AX.isSettable(el, kAXSelectedAttribute) {
                AX.set(el, kAXSelectedAttribute, kCFBooleanTrue)
                return
            }
        }
        throw DriverError(.precondition, "\(AX.describe(hit)) has no accessibility action to click — "
            + "set CONDUCTOR_MACOS_FOREGROUND=1 to drive it with the real pointer")
    }

    static func rightClick(_ point: CGPoint, in target: Target) throws {
        let hit = try element(at: point, in: target)
        guard let el = lineage(hit).first(where: { AX.actions($0).contains(kAXShowMenuAction) }) else {
            throw DriverError(.precondition, "\(AX.describe(hit)) has no context menu")
        }
        AX.perform(el, kAXShowMenuAction)
    }

    /// Scroll the scroll area under the point by moving its scroll bars. Deltas
    /// follow touch semantics: negative dy reveals content further down.
    static func scroll(_ point: CGPoint, dx: CGFloat, dy: CGFloat, in target: Target) throws {
        let hit = try element(at: point, in: target)
        guard let area = lineage(hit, limit: 20).first(where: { AX.role($0) == kAXScrollAreaRole }),
              let visible = AX.frame(area) else {
            throw DriverError(.precondition, "nothing scrollable at (\(Int(point.x)), \(Int(point.y)))")
        }
        let contents: [AXUIElement] = AX.attr(area, kAXContentsAttribute) ?? AX.children(area)
        let content = contents.compactMap(AX.frame).reduce(CGRect.null) { $0.union($1) }
        func move(_ barAttr: String, _ delta: CGFloat, _ contentLen: CGFloat, _ visibleLen: CGFloat) {
            guard delta != 0, let bar: AXUIElement = AX.attr(area, barAttr),
                  let value: NSNumber = AX.attr(bar, kAXValueAttribute) else { return }
            let range = contentLen - visibleLen
            guard range > 0 else { return }
            let next = min(1, max(0, value.doubleValue - Double(delta / range)))
            AX.set(bar, kAXValueAttribute, NSNumber(value: next))
        }
        move(kAXVerticalScrollBarAttribute, dy, content.height, visible.height)
        move(kAXHorizontalScrollBarAttribute, dx, content.width, visible.width)
    }

    static func focused(in target: Target) -> AXUIElement? {
        AX.attr(target.app, kAXFocusedUIElementAttribute)
    }

    static func inputText(_ text: String, in target: Target) {
        if let el = focused(in: target), AX.isSettable(el, kAXSelectedTextAttribute) {
            let before = AX.string(el, kAXValueAttribute)
            // Chromium accepts the insert but ignores it, so check it landed.
            if AX.set(el, kAXSelectedTextAttribute, text as CFString) {
                Thread.sleep(forTimeInterval: 0.05)
                if AX.string(el, kAXValueAttribute) != before { return }
            }
        }
        Keys.type(text, pid: target.pid)
    }

    static func eraseText(_ count: Int, in target: Target) {
        guard count > 0 else { return }
        if let el = focused(in: target), let rangeValue: AXValue = AX.attr(el, kAXSelectedTextRangeAttribute),
           AX.isSettable(el, kAXSelectedTextRangeAttribute) {
            var range = CFRange()
            if AXValueGetValue(rangeValue, .cfRange, &range) {
                let start = max(0, range.location - count)
                var erase = CFRange(location: start, length: range.location - start + range.length)
                let before = AX.string(el, kAXValueAttribute)
                if let newRange = AXValueCreate(.cfRange, &erase),
                   AX.set(el, kAXSelectedTextRangeAttribute, newRange),
                   AX.set(el, kAXSelectedTextAttribute, "" as CFString) {
                    Thread.sleep(forTimeInterval: 0.05)
                    if AX.string(el, kAXValueAttribute) != before { return }
                }
            }
        }
        for _ in 0..<count { Keys.press("delete", modifiers: [], pid: target.pid) }
    }

    /// Press a menu item by its path from the menu bar, without opening menus.
    static func menu(_ path: [String], in target: Target) throws {
        guard let bar: AXUIElement = AX.attr(target.app, kAXMenuBarAttribute) else {
            throw DriverError(.precondition, "\(target.bundleId) has no menu bar")
        }
        var container = bar
        for (i, title) in path.enumerated() {
            let items = AX.children(container)
            guard let item = items.first(where: {
                (AX.string($0, kAXTitleAttribute) ?? "").compare(title, options: .caseInsensitive) == .orderedSame
            }) else {
                throw DriverError(.precondition, "menu item \"\(title)\" not found")
            }
            if i == path.count - 1 {
                if path.count == 1 {
                    throw DriverError(.precondition, "give a full path to an item, e.g. \"\(title) > …\"")
                }
                AX.perform(item, kAXPressAction)
                return
            }
            // A menu bar item or submenu item holds its AXMenu as the only child.
            guard let menu = AX.children(item).first else {
                throw DriverError(.precondition, "\"\(title)\" has no submenu")
            }
            container = menu
        }
    }

    static func launch(_ bundleId: String) throws {
        Target.bundleId = bundleId
        if !NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).isEmpty { return }
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) else {
            throw DriverError(.precondition, "no app with bundle id \(bundleId) is installed")
        }
        let config = NSWorkspace.OpenConfiguration()
        config.activates = false
        let done = DispatchSemaphore(value: 0)
        var failure: Error?
        NSWorkspace.shared.openApplication(at: url, configuration: config) { _, error in
            failure = error
            done.signal()
        }
        _ = done.wait(timeout: .now() + 30)
        if let failure { throw DriverError("launching \(bundleId) failed: \(failure.localizedDescription)") }
        // Give the app a moment to put its first window up.
        for _ in 0..<50 where !Target.visibleWindows().contains(where: {
            NSRunningApplication(processIdentifier: $0.pid)?.bundleIdentifier == bundleId
        }) {
            Thread.sleep(forTimeInterval: 0.1)
        }
    }

    static func terminate(_ bundleId: String) {
        for app in NSRunningApplication.runningApplications(withBundleIdentifier: bundleId) {
            app.terminate()
        }
    }
}

/// Keyboard events posted straight to one process. They never enter the system
/// HID stream, so they can't reach other apps or leave a key stuck down.
enum Keys {
    private static let source = CGEventSource(stateID: .privateState)

    private static let codes: [String: CGKeyCode] = [
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11,
        "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21,
        "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31,
        "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41,
        "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "`": 50,
        "return": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51, "escape": 53, "esc": 53,
        "enter": 76, "forwarddelete": 117, "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
        "left": 123, "right": 124, "down": 125, "up": 126,
        "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100,
        "f9": 101, "f10": 109, "f11": 103, "f12": 111,
    ]

    static func flags(_ names: [String]) -> CGEventFlags {
        var flags: CGEventFlags = []
        for name in names {
            switch name.lowercased() {
            case "cmd", "command", "meta": flags.insert(.maskCommand)
            case "shift": flags.insert(.maskShift)
            case "alt", "option", "opt": flags.insert(.maskAlternate)
            case "ctrl", "control": flags.insert(.maskControl)
            case "fn", "function": flags.insert(.maskSecondaryFn)
            default: break
            }
        }
        return flags
    }

    static func isKnown(_ key: String) -> Bool {
        codes[key.lowercased()] != nil || key == "+"
    }

    static func press(_ key: String, modifiers: [String], pid: pid_t) {
        var name = key.lowercased()
        var mods = flags(modifiers)
        if name == "+" {
            name = "="
            mods.insert(.maskShift)
        }
        guard let code = codes[name] else { return }
        post(code: code, flags: mods, pid: pid)
    }

    /// Type arbitrary text as unicode key events.
    static func type(_ text: String, pid: pid_t) {
        for ch in text {
            let utf16 = Array(String(ch).utf16)
            for down in [true, false] {
                guard let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down) else { continue }
                event.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
                event.postToPid(pid)
            }
        }
    }

    private static func post(code: CGKeyCode, flags: CGEventFlags, pid: pid_t) {
        for down in [true, false] {
            guard let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down) else { continue }
            event.flags = flags
            event.postToPid(pid)
        }
    }
}
