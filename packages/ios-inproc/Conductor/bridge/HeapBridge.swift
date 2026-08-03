import Foundation
import ObjectiveC.runtime
import UIKit

/// Live-object browsing: list classes, find live instances via a malloc-zone
/// scan (HeapScan.c), and read properties off a specific instance by address.
/// Lets you inspect view *models*, not just views.
extension IntrospectionBridge {

    /// Registered classes whose name contains `pattern` (case-insensitive). Done
    /// in C — Swift touching arbitrary class objects can trap (CloudKit et al).
    static func heapClasses(pattern: String) -> [String: Any] {
        var buffer = [CChar](repeating: 0, count: 512 * 1024)
        let matched = pattern.withCString { p in
            conductor_class_names(p, &buffer, Int32(buffer.count))
        }
        let names = String(cString: buffer).split(separator: "\n").map(String.init).sorted()
        return ["status": "ok", "count": Int(matched), "classes": Array(names.prefix(1000))]
    }

    /// Addresses of live instances of `className` (or a subclass).
    static func heapInstances(className: String, limit: Int = 200) -> [String: Any] {
        guard let cls = NSClassFromString(className) else {
            return ["status": "error", "message": "unknown class \(className)"]
        }
        let cap = max(1, min(limit, 2000))
        var buffer = [UnsafeMutableRawPointer?](repeating: nil, count: cap)
        let found = buffer.withUnsafeMutableBufferPointer {
            conductor_heap_find_instances(cls, $0.baseAddress, UInt32(cap))
        }
        let addresses = (0..<Int(found)).compactMap { buffer[$0] }.map {
            String(format: "0x%llx", UInt(bitPattern: $0))
        }
        return ["status": "ok", "class": className, "count": addresses.count, "instances": addresses]
    }

    /// Read a property (or Mirror-dump) off a live instance by its address.
    static func heapRead(address: String, keyPath: String?) -> [String: Any] {
        let hex = address.hasPrefix("0x") ? String(address.dropFirst(2)) : address
        guard let addr = UInt(hex, radix: 16), addr != 0,
              let raw = UnsafeRawPointer(bitPattern: addr) else {
            return ["status": "error", "message": "bad address \(address)"]
        }
        let object = Unmanaged<AnyObject>.fromOpaque(raw).takeUnretainedValue()
        let className = String(cString: object_getClassName(object))

        if let keyPath, !keyPath.isEmpty {
            guard let ns = object as? NSObject else {
                return ["status": "error", "message": "\(className) is not KVC-compliant"]
            }
            var errorMessage: NSString?
            let value = ConductorObjC.catching({ ns.value(forKeyPath: keyPath) }, error: &errorMessage)
            if let message = errorMessage {
                return ["status": "error", "message": "keyPath '\(keyPath)': \(message)"]
            }
            return ["status": "ok", "address": address, "class": className, "keyPath": keyPath, "value": jsonValue(value)]
        }

        // No keyPath: shallow Mirror dump of properties.
        var props: [String: Any] = [:]
        for child in Mirror(reflecting: object).children.prefix(80) {
            if let label = child.label { props[label] = jsonValue(child.value) }
        }
        return ["status": "ok", "address": address, "class": className, "properties": props]
    }
}
