import Foundation
import UIKit

/// The app's persisted state: UserDefaults, Keychain, cookies, and the sandbox
/// file tree. Read (and, for defaults, write) — "why does this screen show stale
/// data" without a debugger.
extension IntrospectionBridge {

    static func defaultsAll() -> [String: Any] {
        onMain {
            let dict = UserDefaults.standard.dictionaryRepresentation()
            var out: [String: Any] = [:]
            for (k, v) in dict { out[k] = jsonValue(v) }
            return ["status": "ok", "count": out.count, "defaults": out]
        }
    }

    static func defaultsSet(key: String, value: String) -> [String: Any] {
        onMain {
            if key.isEmpty { return badValue("provide key=") }
            UserDefaults.standard.set(coerce(value), forKey: key)
            return ["status": "ok", "set": [key: value]]
        }
    }

    static func keychainAll() -> [String: Any] {
        onMain {
            var items: [[String: Any]] = []
            let classes: [(CFString, String)] = [
                (kSecClassGenericPassword, "generic"),
                (kSecClassInternetPassword, "internet"),
            ]
            for (secClass, name) in classes {
                let query: [CFString: Any] = [
                    kSecClass: secClass,
                    kSecReturnAttributes: true,
                    kSecReturnData: true,
                    kSecMatchLimit: kSecMatchLimitAll,
                ]
                var result: CFTypeRef?
                guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
                      let array = result as? [[CFString: Any]] else { continue }
                for entry in array {
                    var item: [String: Any] = ["class": name]
                    if let account = entry[kSecAttrAccount] as? String { item["account"] = account }
                    if let service = entry[kSecAttrService] as? String { item["service"] = service }
                    if let data = entry[kSecValueData] as? Data {
                        item["value"] = String(data: data, encoding: .utf8) ?? data.base64EncodedString()
                    }
                    items.append(item)
                }
            }
            return ["status": "ok", "count": items.count, "items": items]
        }
    }

    static func cookiesAll() -> [String: Any] {
        onMain {
            let cookies = HTTPCookieStorage.shared.cookies ?? []
            let out = cookies.map { c -> [String: Any] in
                ["name": c.name, "value": c.value, "domain": c.domain, "path": c.path, "secure": c.isSecure]
            }
            return ["status": "ok", "count": out.count, "cookies": out]
        }
    }

    /// List the app sandbox (or read a file if `path` points at one). Root defaults
    /// to the app container's parent so Documents/Library/tmp are all reachable.
    static func files(path: String?) -> [String: Any] {
        let fm = FileManager.default
        let root = fm.urls(for: .documentDirectory, in: .userDomainMask).first?.deletingLastPathComponent().path
            ?? NSHomeDirectory()
        let target = (path?.isEmpty == false) ? path! : root
        var isDir: ObjCBool = false
        guard fm.fileExists(atPath: target, isDirectory: &isDir) else {
            return ["status": "error", "message": "no such path: \(target)"]
        }
        if isDir.boolValue {
            let entries = (try? fm.contentsOfDirectory(atPath: target)) ?? []
            let listed = entries.prefix(500).map { name -> [String: Any] in
                let full = (target as NSString).appendingPathComponent(name)
                var d: ObjCBool = false
                fm.fileExists(atPath: full, isDirectory: &d)
                let attrs = try? fm.attributesOfItem(atPath: full)
                return ["name": name, "dir": d.boolValue, "size": (attrs?[.size] as? Int) ?? 0]
            }
            return ["status": "ok", "path": target, "dir": true, "entries": listed]
        } else {
            let attrs = try? fm.attributesOfItem(atPath: target)
            let size = (attrs?[.size] as? Int) ?? 0
            var out: [String: Any] = ["status": "ok", "path": target, "dir": false, "size": size]
            if size <= 512 * 1024, let data = fm.contents(atPath: target) {
                out["content"] = String(data: data, encoding: .utf8) ?? data.base64EncodedString()
            } else {
                out["note"] = "file too large to inline (\(size) bytes)"
            }
            return out
        }
    }
}
