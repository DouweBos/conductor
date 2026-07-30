import Foundation

/// Dynamic Swift eval: the CLI compiles user Swift into a fresh dylib exporting
/// `conductor_eval`, drops it in the app's container, and this dlopen's it and
/// calls the entry on the main thread. The escape hatch when no fixed endpoint
/// fits — full access to UIKit, the ObjC runtime, and every loaded framework.
extension IntrospectionBridge {

    static func eval(dylibPath: String) -> [String: Any] {
        onMain {
            guard FileManager.default.fileExists(atPath: dylibPath) else {
                return ["status": "error", "message": "no dylib at \(dylibPath)"]
            }
            guard let handle = dlopen(dylibPath, RTLD_NOW | RTLD_LOCAL) else {
                let err = dlerror().map { String(cString: $0) } ?? "unknown"
                return ["status": "error", "message": "dlopen failed: \(err)"]
            }
            guard let symbol = dlsym(handle, "conductor_eval") else {
                let err = dlerror().map { String(cString: $0) } ?? "symbol not found"
                dlclose(handle)
                return ["status": "error", "message": "conductor_eval missing: \(err)"]
            }
            typealias EvalFn = @convention(c) () -> UnsafePointer<CChar>?
            let fn = unsafeBitCast(symbol, to: EvalFn.self)
            var errorMessage: NSString?
            let result = ConductorObjC.catching({
                fn().map { String(cString: $0) } ?? ""
            }, error: &errorMessage)
            // Intentionally do NOT dlclose: the returned image may still be
            // referenced, and each eval is a uniquely-named dylib anyway.
            if let message = errorMessage {
                return ["status": "error", "message": "eval threw: \(message)"]
            }
            return ["status": "ok", "result": result as? String ?? ""]
        }
    }
}
