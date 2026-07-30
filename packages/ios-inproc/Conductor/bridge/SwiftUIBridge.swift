import Foundation
import UIKit

/// SwiftUI structure that the UIView tree flattens away. Reflects each
/// `UIHostingController`'s `rootView` with Mirror to reveal the SwiftUI view
/// composition (VStack, Text, modifiers, …) by type — safe, no private decode.
extension IntrospectionBridge {

    static func swiftUITree(maxDepth: Int = 6) -> [String: Any] {
        onMain {
            var hosts: [[String: Any]] = []
            func visit(_ vc: UIViewController) {
                let name = String(describing: type(of: vc))
                if name.contains("HostingController") || name.contains("HostingView") {
                    var errorMessage: NSString?
                    let root = ConductorObjC.catching({
                        (vc as NSObject).value(forKey: "rootView") ?? NSNull()
                    }, error: &errorMessage)
                    var entry: [String: Any] = ["controller": name]
                    if let root, !(root is NSNull) {
                        entry["tree"] = mirrorTree(root, depth: 0, maxDepth: maxDepth)
                    }
                    hosts.append(entry)
                }
                vc.children.forEach(visit)
                if let presented = vc.presentedViewController { visit(presented) }
            }
            allWindows(includeHidden: true).compactMap { $0.rootViewController }.forEach(visit)
            return ["status": "ok", "hostingControllers": hosts]
        }
    }

    /// Reflect any value into a compact type/label tree.
    private static func mirrorTree(_ value: Any, depth: Int, maxDepth: Int) -> [String: Any] {
        let mirror = Mirror(reflecting: value)
        var node: [String: Any] = ["type": String(describing: mirror.subjectType)]
        if depth >= maxDepth { return node }
        var children: [[String: Any]] = []
        for child in mirror.children.prefix(40) {
            // Skip noisy storage-only labels but keep meaningful ones.
            var c = mirrorTree(child.value, depth: depth + 1, maxDepth: maxDepth)
            if let label = child.label { c["label"] = label }
            children.append(c)
        }
        if !children.isEmpty { node["children"] = children }
        return node
    }
}
