import Foundation
import UIKit

/// Interaction + tvOS focus + before/after screen diffing.
extension IntrospectionBridge {

    /// Trigger a control without HID by invoking its accessibility action.
    static func activate(id: String) -> [String: Any] {
        onMain {
            guard let v = viewForId(id) else { return notFound(id) }
            let ok = v.accessibilityActivate()
            return ["status": "ok", "id": id, "activated": ok]
        }
    }

    /// The tvOS/iOS focus engine's currently focused item per window.
    static func focusState() -> [String: Any] {
        onMain {
            var out: [[String: Any]] = []
            for window in allWindows(includeHidden: false) {
                guard let system = UIFocusSystem.focusSystem(for: window),
                      let item = system.focusedItem else { continue }
                var entry: [String: Any] = ["type": String(describing: type(of: item))]
                if let view = item as? UIView {
                    entry["id"] = idFor(view)
                    if let w = view.window { entry["absFrame"] = rect(view.convert(view.bounds, to: w)) }
                    if let t = textOf(view) { entry["text"] = t }
                }
                out.append(entry)
            }
            return ["status": "ok", "focus": out]
        }
    }

    // MARK: Screen diffing

    private static var baselines: [String: [String: String]] = [:]

    static func diffSave(name: String) -> [String: Any] {
        onMain {
            let sig = signature()
            baselines[name] = sig
            return ["status": "ok", "name": name, "nodeCount": sig.count]
        }
    }

    static func diffCompare(name: String) -> [String: Any] {
        onMain {
            guard let before = baselines[name] else {
                return ["status": "error", "message": "no baseline '\(name)' — save one first"]
            }
            let after = signature()
            let beforeIds = Set(before.keys)
            let afterIds = Set(after.keys)
            let added = afterIds.subtracting(beforeIds)
            let removed = beforeIds.subtracting(afterIds)
            var changed: [[String: Any]] = []
            for id in beforeIds.intersection(afterIds) where before[id] != after[id] {
                changed.append(["id": id, "before": before[id] ?? "", "after": after[id] ?? ""])
            }
            return [
                "status": "ok",
                "name": name,
                "added": Array(added.prefix(200)),
                "removed": Array(removed.prefix(200)),
                "changed": Array(changed.prefix(200)),
            ]
        }
    }

    /// id → compact signature (class|absFrame|text|bg) for cheap structural diffing.
    private static func signature() -> [String: String] {
        var map: [String: String] = [:]
        func visit(_ v: UIView) {
            let cls = String(describing: type(of: v))
            let frame = v.window.map { v.convert(v.bounds, to: $0) } ?? v.frame
            let f = "\(Int(frame.minX)),\(Int(frame.minY)),\(Int(frame.width)),\(Int(frame.height))"
            let text = textOf(v) ?? ""
            let bg = hex(v.backgroundColor) ?? ""
            map[idFor(v)] = "\(cls)|\(f)|\(text)|\(bg)|hidden=\(v.isHidden)"
            v.subviews.forEach(visit)
        }
        allWindows(includeHidden: true).forEach(visit)
        return map
    }
}
