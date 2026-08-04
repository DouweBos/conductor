// HIDBridge.swift — dlopen CoreSimulator/SimulatorKit, resolve the IndigoHID
// message builders, and manage per-UDID SimDeviceLegacyHIDClients. Ported from
// Argus's ArgusBridge.swift, injection half only (no framebuffer capture).
import Foundation
import CoreGraphics
import AppKit

// C injection primitives (defined in ConductorHIDInject.m), linked by symbol.
@_silgen_name("SHSendTouch")
func SHSendTouch(_ client: AnyObject, _ fnPtr: UnsafeMutableRawPointer,
                 _ udid: UnsafePointer<CChar>, _ normX: Float, _ normY: Float,
                 _ nsEventType: Int32, _ direction: Int32) -> Int32

@_silgen_name("SHSendKeyboard")
func SHSendKeyboard(_ client: AnyObject, _ fnPtr: UnsafeMutableRawPointer,
                    _ udid: UnsafePointer<CChar>, _ keyCode: UInt16,
                    _ modifierFlags: UInt64, _ isDown: Bool) -> Int32

@_silgen_name("SHSendButton")
func SHSendButton(_ client: AnyObject, _ fnPtr: UnsafeMutableRawPointer,
                  _ udid: UnsafePointer<CChar>, _ keyCode: UInt32,
                  _ op: UInt32, _ target: UInt32) -> Int32

@_silgen_name("SHEnableHardwareKeyboard")
func SHEnableHardwareKeyboard(_ device: AnyObject)

@_silgen_name("SHIsHIDClientInvalidForUDID")
func SHIsHIDClientInvalidForUDID(_ udid: UnsafePointer<CChar>) -> Bool

@_silgen_name("SHResetHIDClientInvalidForUDID")
func SHResetHIDClientInvalidForUDID(_ udid: UnsafePointer<CChar>)

@_silgen_name("SHClearTouchStateForUDID")
func SHClearTouchStateForUDID(_ udid: UnsafePointer<CChar>)

private var indigoFnPtr: UnsafeMutableRawPointer?
private var indigoLoaded = false
private var indigoKeyboardFnPtr: UnsafeMutableRawPointer?
private var indigoKeyboardLoaded = false
private var indigoButtonFnPtr: UnsafeMutableRawPointer?
private var indigoButtonLoaded = false
private var hidClients: [String: AnyObject] = [:]

private func xcodeDevDir() -> String {
    let pipe = Pipe()
    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: "/usr/bin/xcode-select")
    proc.arguments = ["-p"]
    proc.standardOutput = pipe
    try? proc.run()
    proc.waitUntilExit()
    return String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
        .trimmingCharacters(in: .whitespacesAndNewlines)
        ?? "/Applications/Xcode.app/Contents/Developer"
}

private var coreSimLoaded = false, coreSimOk = false
private var simKitLoaded = false, simKitOk = false

@discardableResult
private func ensureCoreSimLoaded() -> Bool {
    if coreSimLoaded { return coreSimOk }
    coreSimLoaded = true
    let p = "/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator"
    coreSimOk = dlopen(p, RTLD_NOW | RTLD_GLOBAL) != nil
    return coreSimOk
}

@discardableResult
private func ensureSimKitLoaded() -> Bool {
    if simKitLoaded { return simKitOk }
    simKitLoaded = true
    ensureCoreSimLoaded()
    let p = xcodeDevDir() + "/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit"
    simKitOk = dlopen(p, RTLD_NOW | RTLD_GLOBAL) != nil
    return simKitOk
}

private func loadIndigoSymbol(_ name: String) -> UnsafeMutableRawPointer? {
    guard ensureSimKitLoaded() else { return nil }
    let p = xcodeDevDir() + "/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit"
    guard let h = dlopen(p, RTLD_NOW | RTLD_GLOBAL) else { return nil }
    return dlsym(h, name)
}

private func ensureIndigoLoaded() -> Bool {
    if indigoLoaded { return indigoFnPtr != nil }
    indigoLoaded = true
    indigoFnPtr = loadIndigoSymbol("IndigoHIDMessageForMouseNSEvent")
    return indigoFnPtr != nil
}

private func ensureIndigoKeyboardLoaded() -> Bool {
    if indigoKeyboardLoaded { return indigoKeyboardFnPtr != nil }
    indigoKeyboardLoaded = true
    indigoKeyboardFnPtr = loadIndigoSymbol("IndigoHIDMessageForKeyboardNSEvent")
    return indigoKeyboardFnPtr != nil
}

private func ensureIndigoButtonLoaded() -> Bool {
    if indigoButtonLoaded { return indigoButtonFnPtr != nil }
    indigoButtonLoaded = true
    indigoButtonFnPtr = loadIndigoSymbol("IndigoHIDMessageForButton")
    return indigoButtonFnPtr != nil
}

func findSimDevice(udid: String) -> AnyObject? {
    guard ensureCoreSimLoaded() else { return nil }
    let devDir = xcodeDevDir()
    guard let contextClass = NSClassFromString("SimServiceContext") else { return nil }
    let contextSel = NSSelectorFromString("sharedServiceContextForDeveloperDir:error:")
    guard let context = (contextClass as AnyObject)
        .perform(contextSel, with: devDir as NSString, with: nil)?.takeUnretainedValue() else { return nil }
    let setSel = NSSelectorFromString("defaultDeviceSetWithError:")
    guard let deviceSet = context.perform(setSel, with: nil)?.takeUnretainedValue() else { return nil }
    guard let devices = deviceSet.value(forKey: "devices") as? [AnyObject] else { return nil }
    let target = udid.uppercased()
    for device in devices {
        if let u = device.value(forKey: "UDID") as? NSUUID, u.uuidString.uppercased() == target {
            return device
        }
    }
    return nil
}

private func ensureHIDClient(udid: String) -> Bool {
    if hidClients[udid] != nil { return true }
    guard let device = findSimDevice(udid: udid) else { return false }
    let clientClass: AnyClass? = NSClassFromString("SimulatorKit.SimDeviceLegacyHIDClient")
        ?? NSClassFromString("SimDeviceLegacyHIDClient")
    guard let cls = clientClass else { return false }
    guard let allocated = (cls as AnyObject).perform(NSSelectorFromString("alloc"))?.takeUnretainedValue()
    else { return false }
    guard let client = allocated
        .perform(NSSelectorFromString("initWithDevice:error:"), with: device, with: nil)?.takeRetainedValue()
    else { return false }
    hidClients[udid] = client
    // Route physical keys to the focused field for HID text entry.
    SHEnableHardwareKeyboard(device)
    return true
}

/// Inject a touch. eventType: 0=Down, 1=Drag/Move, 2=Up. Returns 0 on success.
func hidTouch(udid: String, normX: Float, normY: Float, eventType: Int32) -> Int32 {
    guard ensureIndigoLoaded() else { return -1 }
    return udid.withCString { udidC -> Int32 in
        if SHIsHIDClientInvalidForUDID(udidC) {
            hidClients.removeValue(forKey: udid)
            if eventType == 1 || eventType == 2 {
                SHClearTouchStateForUDID(udidC)
                return -5
            }
            SHResetHIDClientInvalidForUDID(udidC)
        }
        guard ensureHIDClient(udid: udid), let fnPtr = indigoFnPtr, let client = hidClients[udid]
        else { return -2 }

        let nsEventType: Int32, direction: Int32
        switch eventType {
        case 0: nsEventType = 1; direction = 1
        case 1: nsEventType = 6; direction = 0
        case 2: nsEventType = 2; direction = 2
        default: return -4
        }

        let sendTouch = { (c: AnyObject) -> Int32 in
            Thread.isMainThread
                ? SHSendTouch(c, fnPtr, udidC, normX, normY, nsEventType, direction)
                : DispatchQueue.main.sync { SHSendTouch(c, fnPtr, udidC, normX, normY, nsEventType, direction) }
        }
        var rc = sendTouch(client)
        if rc == -6 && eventType == 0 {
            hidClients.removeValue(forKey: udid)
            SHResetHIDClientInvalidForUDID(udidC)
            SHClearTouchStateForUDID(udidC)
            guard ensureHIDClient(udid: udid), let retry = hidClients[udid] else { return -2 }
            rc = sendTouch(retry)
        }
        if rc != 0 && rc != -2 { hidClients.removeValue(forKey: udid) }
        return rc
    }
}

func hidKeyboard(udid: String, keyCode: UInt16, modifierFlags: UInt64, isDown: Bool) -> Int32 {
    guard ensureIndigoKeyboardLoaded() else { return -1 }
    return udid.withCString { udidC -> Int32 in
        if SHIsHIDClientInvalidForUDID(udidC) {
            hidClients.removeValue(forKey: udid)
            SHResetHIDClientInvalidForUDID(udidC)
        }
        guard ensureHIDClient(udid: udid), let fnPtr = indigoKeyboardFnPtr, let client = hidClients[udid]
        else { return -2 }
        let rc = Thread.isMainThread
            ? SHSendKeyboard(client, fnPtr, udidC, keyCode, modifierFlags, isDown)
            : DispatchQueue.main.sync { SHSendKeyboard(client, fnPtr, udidC, keyCode, modifierFlags, isDown) }
        if rc != 0 { hidClients.removeValue(forKey: udid) }
        return rc
    }
}

func hidButton(udid: String, keyCode: UInt32, op: UInt32, target: UInt32) -> Int32 {
    guard ensureIndigoButtonLoaded() else { return -1 }
    return udid.withCString { udidC -> Int32 in
        if SHIsHIDClientInvalidForUDID(udidC) {
            hidClients.removeValue(forKey: udid)
            SHResetHIDClientInvalidForUDID(udidC)
        }
        guard ensureHIDClient(udid: udid), let fnPtr = indigoButtonFnPtr, let client = hidClients[udid]
        else { return -2 }
        let rc = Thread.isMainThread
            ? SHSendButton(client, fnPtr, udidC, keyCode, op, target)
            : DispatchQueue.main.sync { SHSendButton(client, fnPtr, udidC, keyCode, op, target) }
        if rc != 0 { hidClients.removeValue(forKey: udid) }
        return rc
    }
}
