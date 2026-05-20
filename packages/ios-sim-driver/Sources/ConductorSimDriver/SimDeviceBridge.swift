//
// SimDeviceBridge.swift
//
// Talks to CoreSimulator.framework through the Objective-C runtime — every
// class lookup goes through NSClassFromString, every method call through
// dynamic-dispatch perform/Selector. The framework is *not* imported as a
// module: it's loaded by dyld via Package.swift's linkerSettings (the
// -F /Library/Developer/PrivateFrameworks + -framework CoreSimulator flag),
// and we discover its types at runtime.
//
// Why dynamic: CoreSimulator is private. Its public ObjC headers are not on
// the macOS SDK search path, so a static `import CoreSimulator` doesn't work.
// Even when it does (some Xcode versions), the headers are not stable across
// releases. Runtime discovery lets us absorb minor selector renames without
// re-compiling.
//
// References for the selectors we call (all observable via `nm` /
// `class-dump` on the framework binary; both WebDriverAgent and idb use
// the same names):
//
//   +[SimServiceContext sharedServiceContextForDeveloperDir:error:]
//   -[SimServiceContext defaultDeviceSetWithError:]
//   -[SimDeviceSet devicesByUDID]
//   -[SimDevice io]                  (returns SimDeviceIOClient)
//   -[SimDevice state]
//   -[SimDeviceIOClient performIO:]
//
// If any of these disappear in a future Xcode, /status surfaces the failure
// and routes return 500. The CLI's IOSDriver then falls back to XCUITest
// automatically.
//
import Foundation
import ObjectiveC.runtime
import CCoreSimulator

enum SimBridgeError: Error, CustomStringConvertible {
    case classMissing(String)
    case selectorMissing(String, onClass: String)
    case noDeveloperDir
    case contextFailed(String)
    case deviceSetFailed(String)
    case udidNotFound(String)
    case noIOClient
    case iohidUnavailable(String)

    var description: String {
        switch self {
        case .classMissing(let name): return "Objective-C class not found: \(name)"
        case .selectorMissing(let sel, let cls): return "Selector \(sel) missing on \(cls)"
        case .noDeveloperDir: return "xcode-select developer dir is empty"
        case .contextFailed(let msg): return "SimServiceContext failed: \(msg)"
        case .deviceSetFailed(let msg): return "SimDeviceSet failed: \(msg)"
        case .udidNotFound(let u): return "SimDevice with UDID \(u) not found in default device set"
        case .noIOClient: return "SimDevice has no IO client"
        case .iohidUnavailable(let msg): return "IOHIDEvent SPI unavailable: \(msg)"
        }
    }
}

final class SimDeviceBridge {
    /// True when `resolve(udid:)` has succeeded. Routes guard on this.
    private(set) var isReady: Bool = false
    /// Developer dir reported by xcode-select (`xcrun --show-developer-dir`).
    private(set) var developerDir: String = ""
    /// Best-effort error captured at startup. Surfaced via /status so the
    /// human can see what went wrong without grepping stderr.
    private(set) var lastError: String?

    /// Strong references to keep the resolved objects alive. The IO client is
    /// what every digitizer / keyboard event ultimately gets dispatched
    /// through.
    private var device: NSObject?
    private var ioClient: NSObject?
    /// Pinned HID-consumer port discovered during resolve. The IOClient hosts
    /// multiple ports (display, location, HID, …); we probe them all for
    /// `enqueueIOHIDEvent:` and remember the one that implements it.
    private var hidPort: NSObject?

    func resolve(udid: String) throws {
        do {
            try self.resolveImpl(udid: udid)
            self.isReady = true
        } catch {
            self.lastError = String(describing: error)
            throw error
        }
    }

    private func resolveImpl(udid: String) throws {
        // Trace each step into the dump file so we can see how far we got
        // independently of stderr buffering quirks.
        let dumpPath = "/tmp/conductor-sim-driver-methods.log"
        FileManager.default.createFile(atPath: dumpPath, contents: nil)
        let trace = FileHandle(forWritingAtPath: dumpPath)
        defer { trace?.closeFile() }
        func t(_ s: String) {
            trace?.write(Data("[trace] \(s)\n".utf8))
        }
        t("resolveImpl start, udid=\(udid)")

        // Step 1: get developer dir from xcode-select.
        let devDir = try shell("xcode-select", ["-p"])
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !devDir.isEmpty else { throw SimBridgeError.noDeveloperDir }
        self.developerDir = devDir

        // Step 2: SimServiceContext class.
        guard let ctxClass = NSClassFromString("SimServiceContext") as? NSObject.Type else {
            throw SimBridgeError.classMissing("SimServiceContext")
        }

        // Try shared* first, then non-shared. Xcode 15+ ships both; older
        // toolchains only have one.
        let sharedSel = Selector(("sharedServiceContextForDeveloperDir:error:"))
        let nonSharedSel = Selector(("serviceContextForDeveloperDir:error:"))

        var errObj: NSError?
        var context: NSObject?
        if class_respondsToSelector(object_getClass(ctxClass), sharedSel) {
            context = invokeReturningObject(
                target: ctxClass,
                selector: sharedSel,
                arg1: devDir as NSString,
                errPtr: &errObj)
        } else if class_respondsToSelector(object_getClass(ctxClass), nonSharedSel) {
            context = invokeReturningObject(
                target: ctxClass,
                selector: nonSharedSel,
                arg1: devDir as NSString,
                errPtr: &errObj)
        } else {
            throw SimBridgeError.selectorMissing("sharedServiceContextForDeveloperDir:error:", onClass: "SimServiceContext")
        }
        guard let context = context else {
            throw SimBridgeError.contextFailed(errObj?.localizedDescription ?? "<nil>")
        }

        // Step 3: defaultDeviceSetWithError:
        let deviceSetSel = Selector(("defaultDeviceSetWithError:"))
        guard context.responds(to: deviceSetSel) else {
            throw SimBridgeError.selectorMissing("defaultDeviceSetWithError:", onClass: "SimServiceContext")
        }
        var devSetErr: NSError?
        guard let deviceSet = invokeReturningObject(
            target: context,
            selector: deviceSetSel,
            errPtr: &devSetErr) as NSObject?
        else {
            throw SimBridgeError.deviceSetFailed(devSetErr?.localizedDescription ?? "<nil>")
        }

        // Step 4: devicesByUDID → NSDictionary<NSUUID, SimDevice>
        let devicesByUDIDSel = Selector(("devicesByUDID"))
        guard deviceSet.responds(to: devicesByUDIDSel) else {
            throw SimBridgeError.selectorMissing("devicesByUDID", onClass: "SimDeviceSet")
        }
        let devicesByUDIDAny = deviceSet.perform(devicesByUDIDSel)?.takeUnretainedValue()
        guard let devicesByUDID = devicesByUDIDAny as? NSDictionary else {
            throw SimBridgeError.deviceSetFailed("devicesByUDID returned non-dict")
        }

        // The keys are NSUUIDs. Convert our input string to NSUUID for lookup.
        guard let nsuuid = NSUUID(uuidString: udid) else {
            throw SimBridgeError.udidNotFound(udid)
        }
        guard let device = devicesByUDID.object(forKey: nsuuid) as? NSObject else {
            throw SimBridgeError.udidNotFound(udid)
        }
        self.device = device

        // Step 5: SimDevice.io — accessor varies by Xcode. Try the common ones.
        let ioCandidates: [String] = ["io", "deviceIOClient", "ioClient"]
        var ioClient: NSObject?
        for name in ioCandidates {
            let sel = Selector((name))
            if device.responds(to: sel) {
                if let v = device.perform(sel)?.takeUnretainedValue() as? NSObject {
                    ioClient = v
                    break
                }
            }
        }
        guard let resolvedIO = ioClient else { throw SimBridgeError.noIOClient }
        self.ioClient = resolvedIO

        // Step 6: resolve IOHIDEvent SPI. Lazy, but do it at startup so /status
        // reports the failure cleanly.
        if csd_resolve_iohid() != 0 {
            let msg = csd_iohid_resolve_error().map { String(cString: $0) } ?? "<unknown>"
            throw SimBridgeError.iohidUnavailable(msg)
        }

        // Find the HID-consumer port. The ports are ROCKRemoteProxy objects —
        // they forward selectors to a remote service, so `respondsToSelector:`
        // returns false on the proxy. But the proxy implements
        // `methodSignatureForSelector:` to look up the signature against the
        // service's interface; non-nil signature means the remote implements
        // that selector. Probe each port for `enqueueIOHIDEvent:` and pin
        // the first match as our HID port.
        t("step 6 done; finding HID port")
        let ioPortsSel = Selector(("ioPorts"))
        let enqueueSel = Selector(("enqueueIOHIDEvent:"))
        let methodSigSel = Selector(("methodSignatureForSelector:"))
        if resolvedIO.responds(to: ioPortsSel),
           let ports = resolvedIO.perform(ioPortsSel)?.takeUnretainedValue() as? [NSObject]
        {
            trace?.write(Data("ioPorts count = \(ports.count)\n".utf8))
            for (i, p) in ports.enumerated() {
                let descr = (p.perform(Selector(("description")))?.takeUnretainedValue() as? String) ?? "<no description>"
                // Probe via methodSignatureForSelector:
                var implements = false
                if p.responds(to: methodSigSel) {
                    typealias FnT = @convention(c) (AnyObject, Selector, Selector) -> AnyObject?
                    let imp = class_getMethodImplementation(object_getClass(p), methodSigSel)
                    if let imp = imp {
                        let fn = unsafeBitCast(imp, to: FnT.self)
                        let sig = fn(p, methodSigSel, enqueueSel)
                        implements = (sig != nil)
                    }
                }
                trace?.write(Data("ioPort[\(i)] implements enqueueIOHIDEvent:=\(implements)\n  description=\(descr.prefix(200))\n".utf8))
                if implements && hidPort == nil {
                    self.hidPort = p
                    trace?.write(Data("  → using as HID port\n".utf8))
                }
            }
        }
        t("resolveImpl done; hidPort=\(self.hidPort.map { String(describing: type(of: $0)) } ?? "nil")")
    }

    private func dumpMethods(of obj: NSObject, label: String, to handle: FileHandle?) {
        // Walk class + superclasses so we catch inherited methods too.
        var allNames: [String] = []
        var cls: AnyClass? = object_getClass(obj)
        while let c = cls {
            var count: UInt32 = 0
            if let methodList = class_copyMethodList(c, &count) {
                for i in 0..<Int(count) {
                    allNames.append(NSStringFromSelector(method_getName(methodList[i])))
                }
                free(methodList)
            }
            cls = class_getSuperclass(c)
            if cls == NSObject.self { break }
        }
        allNames.sort()
        let interesting = allNames.filter {
            $0.contains("HID") || $0.contains("hid")
                || $0.contains("enqueue") || $0.contains("Event") || $0.contains("event")
                || $0.contains("indigo") || $0.contains("Indigo")
        }
        handle?.write(Data(
            "\(label) cls=\(String(describing: object_getClass(obj)))\n  interesting: \(interesting.joined(separator: ", "))\n  ALL: \(allNames.joined(separator: ", "))\n\n".utf8))
    }

    /// Send a HID event into the simulator. Returns false if the bridge isn't
    /// ready or the IO client can't accept the event. The IOHIDEvent ref is
    /// always released by this method.
    ///
    /// Selector strategy:
    ///   1. `-[SimDeviceIOClient enqueueIOHIDEvent:]` — the explicit HID-event
    ///      dispatch path used by FBSimulatorControl / WebDriverAgent. This is
    ///      what we want when it's present.
    ///   2. Find a HID-consumer port in `ioPorts` and call `enqueueIOHIDEvent:`
    ///      on it. Newer CoreSimulator versions expose HID through a port
    ///      conforming to a private SimDeviceIOPortConsumer protocol.
    ///   3. `-[SimDeviceIOClient performIO:]` is **not** for HID — it's a
    ///      block-based generic dispatcher. Don't fall back to it.
    @discardableResult
    func dispatch(event: IOHIDEventRef) -> Bool {
        defer { csd_release_event(event) }
        guard let port = self.hidPort else {
            FileHandle.standardError.write(Data("sim-driver: dispatch: no pinned HID port\n".utf8))
            return false
        }
        // `perform(_:with:)` invokes through objc_msgSend, which honors the
        // proxy's forwardInvocation: / methodSignatureForSelector: dynamic
        // dispatch. The proxy's responds(to:) returns false for forwarded
        // selectors, which is why we pinned the port at resolve time via
        // methodSignatureForSelector: instead.
        let enqueueSel = Selector(("enqueueIOHIDEvent:"))
        _ = port.perform(enqueueSel, with: event)
        return true
    }

    // MARK: - Helpers

    /// Wrap perform-with-error-pointer because Swift can't call ObjC methods
    /// whose last param is `NSError **` through `.perform(_:with:)`. We use
    /// objc_msgSend through `unsafeBitCast` to a typed function pointer.
    private func invokeReturningObject(
        target: AnyObject,
        selector: Selector,
        errPtr: inout NSError?
    ) -> NSObject? {
        typealias FnT = @convention(c) (AnyObject, Selector, UnsafeMutablePointer<NSError?>) -> NSObject?
        let imp: IMP = (target as? NSObject.Type).map { class_getMethodImplementation(object_getClass($0), selector)! }
            ?? class_getMethodImplementation(object_getClass(target), selector)!
        let fn = unsafeBitCast(imp, to: FnT.self)
        return fn(target, selector, &errPtr)
    }

    private func invokeReturningObject(
        target: AnyObject,
        selector: Selector,
        arg1: AnyObject,
        errPtr: inout NSError?
    ) -> NSObject? {
        typealias FnT = @convention(c) (AnyObject, Selector, AnyObject, UnsafeMutablePointer<NSError?>) -> NSObject?
        let imp: IMP = (target as? NSObject.Type).map { class_getMethodImplementation(object_getClass($0), selector)! }
            ?? class_getMethodImplementation(object_getClass(target), selector)!
        let fn = unsafeBitCast(imp, to: FnT.self)
        return fn(target, selector, arg1, &errPtr)
    }

    private func shell(_ cmd: String, _ args: [String]) throws -> String {
        let proc = Process()
        proc.launchPath = "/usr/bin/env"
        proc.arguments = [cmd] + args
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = Pipe()
        try proc.run()
        proc.waitUntilExit()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        return String(data: data, encoding: .utf8) ?? ""
    }
}
