import ApplicationServices
import Foundation

/// Thin, failure-tolerant wrappers over the AX C API.
enum AX {
    static func attr<T>(_ el: AXUIElement, _ name: String) -> T? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, name as CFString, &value) == .success else { return nil }
        return value as? T
    }

    static func children(_ el: AXUIElement) -> [AXUIElement] {
        attr(el, kAXChildrenAttribute) ?? []
    }

    static func parent(_ el: AXUIElement) -> AXUIElement? {
        attr(el, kAXParentAttribute)
    }

    static func role(_ el: AXUIElement) -> String {
        attr(el, kAXRoleAttribute) ?? ""
    }

    static func string(_ el: AXUIElement, _ name: String) -> String? {
        attr(el, name)
    }

    static func frame(_ el: AXUIElement) -> CGRect? {
        guard let pos: AXValue = attr(el, kAXPositionAttribute),
              let size: AXValue = attr(el, kAXSizeAttribute) else { return nil }
        var p = CGPoint.zero, s = CGSize.zero
        guard AXValueGetValue(pos, .cgPoint, &p), AXValueGetValue(size, .cgSize, &s) else { return nil }
        return CGRect(origin: p, size: s)
    }

    static func actions(_ el: AXUIElement) -> [String] {
        var names: CFArray?
        guard AXUIElementCopyActionNames(el, &names) == .success else { return [] }
        return names as? [String] ?? []
    }

    static func isSettable(_ el: AXUIElement, _ name: String) -> Bool {
        var settable = DarwinBoolean(false)
        return AXUIElementIsAttributeSettable(el, name as CFString, &settable) == .success && settable.boolValue
    }

    @discardableResult
    static func set(_ el: AXUIElement, _ name: String, _ value: CFTypeRef) -> Bool {
        AXUIElementSetAttributeValue(el, name as CFString, value) == .success
    }

    @discardableResult
    static func perform(_ el: AXUIElement, _ action: String) -> Bool {
        AXUIElementPerformAction(el, action as CFString) == .success
    }

    static func describe(_ el: AXUIElement) -> String {
        let label = string(el, kAXTitleAttribute) ?? string(el, kAXDescriptionAttribute) ?? ""
        return label.isEmpty ? role(el) : "\(role(el)) \"\(label)\""
    }
}

/// Snapshot of an AX subtree in the XCUITest driver's AXElement JSON shape, so
/// the CLI's selector matching and inspect output work unchanged.
struct AXSnapshot {
    private static let names = [
        kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute,
        kAXValueAttribute, kAXIdentifierAttribute, kAXPositionAttribute, kAXSizeAttribute,
        kAXEnabledAttribute, kAXSelectedAttribute, kAXFocusedAttribute,
        kAXPlaceholderValueAttribute, kAXChildrenAttribute,
    ] as CFArray

    let origin: CGPoint
    let maxDepth = 60
    let maxNodes = 8000
    private var nodes = 0

    init(origin: CGPoint) {
        self.origin = origin
    }

    mutating func node(_ el: AXUIElement, depth: Int = 0, descend: (AXUIElement, String) -> Bool = { _, _ in true })
        -> [String: Any]
    {
        nodes += 1
        var values: CFArray?
        AXUIElementCopyMultipleAttributeValues(el, Self.names, AXCopyMultipleAttributeOptions(rawValue: 0), &values)
        let v = (values as? [Any]) ?? []
        func at(_ i: Int) -> Any? {
            guard i < v.count else { return nil }
            let item = v[i] as CFTypeRef
            // Missing attributes come back as an AXValue wrapping an error.
            if CFGetTypeID(item) == AXValueGetTypeID(), AXValueGetType(item as! AXValue) == .axError { return nil }
            return v[i]
        }
        let role = at(0) as? String ?? ""
        let subrole = at(1) as? String ?? ""
        var frame: [String: Double] = ["X": 0, "Y": 0, "Width": 0, "Height": 0]
        if let pos = at(6), let size = at(7) {
            var p = CGPoint.zero, s = CGSize.zero
            if AXValueGetValue(pos as! AXValue, .cgPoint, &p), AXValueGetValue(size as! AXValue, .cgSize, &s) {
                frame = ["X": p.x - origin.x, "Y": p.y - origin.y, "Width": s.width, "Height": s.height]
            }
        }
        var dict: [String: Any] = [
            "identifier": at(5) as? String ?? "",
            "frame": frame,
            "label": at(3) as? String ?? "",
            "elementType": ElementType.of(role: role, subrole: subrole),
            "enabled": (at(8) as? Bool) ?? true,
            "selected": (at(9) as? Bool) ?? false,
            "hasFocus": (at(10) as? Bool) ?? false,
        ]
        if let title = at(2) as? String, !title.isEmpty { dict["title"] = title }
        if let value = Self.stringValue(at(4)) { dict["value"] = value }
        if let placeholder = at(11) as? String { dict["placeholderValue"] = placeholder }

        var children: [[String: Any]] = []
        if depth < maxDepth, descend(el, role), let kids = at(12) as? [AXUIElement] {
            for kid in kids where nodes < maxNodes {
                children.append(node(kid, depth: depth + 1, descend: descend))
            }
        }
        dict["children"] = children
        return dict
    }

    private static func stringValue(_ value: Any?) -> String? {
        switch value {
        case let s as String: return s
        case let n as NSNumber: return n.stringValue
        default: return nil
        }
    }
}

/// AX roles → XCUIElement.ElementType raw values, which is what the CLI's
/// iOS-derived resolver and a11y output expect in `elementType`.
enum ElementType {
    private static let byRole: [String: Int] = [
        "AXApplication": 2, "AXGroup": 3, "AXWindow": 4, "AXSheet": 5, "AXDrawer": 6,
        "AXButton": 9, "AXRadioButton": 10, "AXRadioGroup": 11, "AXCheckBox": 12,
        "AXDisclosureTriangle": 13, "AXPopUpButton": 14, "AXComboBox": 15, "AXMenuButton": 16,
        "AXPopover": 18, "AXTabGroup": 23, "AXToolbar": 24, "AXTable": 26, "AXRow": 27,
        "AXColumn": 28, "AXOutline": 29, "AXBrowser": 31, "AXList": 32, "AXSlider": 33,
        "AXProgressIndicator": 35, "AXBusyIndicator": 36, "AXLink": 42, "AXImage": 43,
        "AXTextField": 49, "AXScrollArea": 46, "AXScrollBar": 47, "AXStaticText": 48,
        "AXDateField": 51, "AXTextArea": 52, "AXMenu": 53, "AXMenuItem": 54, "AXMenuBar": 55,
        "AXMenuBarItem": 56, "AXWebArea": 58, "AXValueIndicator": 63, "AXSplitGroup": 64,
        "AXSplitter": 65, "AXColorWell": 67, "AXHelpTag": 68, "AXMatte": 69, "AXDockItem": 70,
        "AXRuler": 71, "AXRulerMarker": 72, "AXGrid": 73, "AXLevelIndicator": 74, "AXCell": 75,
        "AXLayoutArea": 76, "AXLayoutItem": 77, "AXHandle": 78, "AXIncrementor": 79,
    ]

    static func of(role: String, subrole: String) -> Int {
        switch subrole {
        case "AXSearchField": return 45
        case "AXSecureTextField": return 50
        case "AXSwitch": return 40
        case "AXToggle": return 41
        case "AXOutlineRow": return 30
        case "AXDialog", "AXSystemDialog": return 8
        case "AXTabButton": return 80
        default: return byRole[role] ?? 1
        }
    }
}
