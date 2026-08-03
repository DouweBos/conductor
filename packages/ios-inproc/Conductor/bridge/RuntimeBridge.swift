import Foundation
import ObjectiveC.runtime
import UIKit

/// ObjC-runtime inspection: read any property, dump a class's declared members,
/// walk the responder chain, list gesture recognizers and control target-actions.
extension IntrospectionBridge {

    /// Read an arbitrary KVC key path off a view (safe: ObjC exceptions caught).
    static func getKeyPath(id: String, keyPath: String) -> [String: Any] {
        onMain {
            guard let v = viewForId(id) else { return notFound(id) }
            if keyPath.isEmpty { return badValue("provide keyPath=") }
            var errorMessage: NSString?
            let result = ConductorObjC.catching({ v.value(forKeyPath: keyPath) }, error: &errorMessage)
            if let message = errorMessage {
                return ["status": "error", "message": "keyPath '\(keyPath)': \(message)"]
            }
            return [
                "status": "ok",
                "id": id,
                "keyPath": keyPath,
                "value": jsonValue(result),
                "type": result.map { String(describing: type(of: $0)) } ?? "nil",
            ]
        }
    }

    /// Declared properties, ivars, and methods of a view's class — so an inspector
    /// can show every key available to read/edit, not just a fixed set.
    static func classMeta(id: String) -> [String: Any] {
        onMain {
            guard let v = viewForId(id) else { return notFound(id) }
            let cls: AnyClass = type(of: v)
            return [
                "status": "ok",
                "id": id,
                "class": String(describing: cls),
                "classHierarchy": classChain(v),
                "properties": propertyNames(cls),
                "ivars": ivarNames(cls),
                "methods": methodNames(cls),
            ]
        }
    }

    /// Responder chain from a view up to the app, flagging the first responder.
    static func responders(id: String) -> [String: Any] {
        onMain {
            guard let v = viewForId(id) else { return notFound(id) }
            var chain: [[String: Any]] = []
            var responder: UIResponder? = v
            var depth = 0
            while let current = responder, depth < 40 {
                var entry: [String: Any] = ["class": String(describing: type(of: current))]
                if let view = current as? UIView { entry["id"] = idFor(view) }
                if current.isFirstResponder { entry["firstResponder"] = true }
                chain.append(entry)
                responder = current.next
                depth += 1
            }
            return ["status": "ok", "id": id, "chain": chain]
        }
    }

    /// Gesture recognizers attached to a view (state, enabled, config).
    static func gestures(id: String) -> [String: Any] {
        onMain {
            guard let v = viewForId(id) else { return notFound(id) }
            let recognizers = (v.gestureRecognizers ?? []).map { gr -> [String: Any] in
                var d: [String: Any] = [
                    "class": String(describing: type(of: gr)),
                    "enabled": gr.isEnabled,
                    "state": gestureStateName(gr.state),
                    "numberOfTouches": gr.numberOfTouches,
                ]
                if let tap = gr as? UITapGestureRecognizer {
                    d["numberOfTapsRequired"] = tap.numberOfTapsRequired
                }
                return d
            }
            return ["status": "ok", "id": id, "gestureRecognizers": recognizers]
        }
    }

    /// UIControl target-action wiring ("which method fires on which event").
    static func targetActions(id: String) -> [String: Any] {
        onMain {
            guard let v = viewForId(id) else { return notFound(id) }
            guard let control = v as? UIControl else {
                return ["status": "error", "message": "\(type(of: v)) is not a UIControl"]
            }
            var out: [[String: Any]] = []
            for target in control.allTargets {
                for (event, name) in controlEvents {
                    if let actions = control.actions(forTarget: target, forControlEvent: event), !actions.isEmpty {
                        out.append([
                            "target": String(describing: type(of: target)),
                            "event": name,
                            "actions": actions,
                        ])
                    }
                }
            }
            return ["status": "ok", "id": id, "targetActions": out]
        }
    }

    // MARK: helpers

    static func jsonValue(_ value: Any?) -> Any {
        guard let value else { return NSNull() }
        switch value {
        case let color as UIColor: return hex(color) ?? String(describing: color)
        case let number as NSNumber: return number
        case let string as String: return string
        case let font as UIFont: return font.fontName + " \(font.pointSize)"
        default: return String(describing: value)
        }
    }

    private static func propertyNames(_ cls: AnyClass) -> [String] {
        var count: UInt32 = 0
        guard let list = class_copyPropertyList(cls, &count) else { return [] }
        defer { free(list) }
        return (0..<Int(count)).map { String(cString: property_getName(list[$0])) }
    }

    private static func ivarNames(_ cls: AnyClass) -> [String] {
        var count: UInt32 = 0
        guard let list = class_copyIvarList(cls, &count) else { return [] }
        defer { free(list) }
        return (0..<Int(count)).compactMap { ivar_getName(list[$0]).map { String(cString: $0) } }
    }

    private static func methodNames(_ cls: AnyClass) -> [String] {
        var count: UInt32 = 0
        guard let list = class_copyMethodList(cls, &count) else { return [] }
        defer { free(list) }
        return (0..<Int(count)).map { String(cString: sel_getName(method_getName(list[$0]))) }
    }

    private static func gestureStateName(_ state: UIGestureRecognizer.State) -> String {
        switch state {
        case .possible: return "possible"
        case .began: return "began"
        case .changed: return "changed"
        case .ended: return "ended"
        case .cancelled: return "cancelled"
        case .failed: return "failed"
        @unknown default: return "unknown"
        }
    }

    private static var controlEvents: [(UIControl.Event, String)] {
        [
            (.touchUpInside, "touchUpInside"),
            (.touchDown, "touchDown"),
            (.valueChanged, "valueChanged"),
            (.primaryActionTriggered, "primaryActionTriggered"),
            (.editingChanged, "editingChanged"),
            (.editingDidBegin, "editingDidBegin"),
            (.editingDidEnd, "editingDidEnd"),
        ]
    }
}
