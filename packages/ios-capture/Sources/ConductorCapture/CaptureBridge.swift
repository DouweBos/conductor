// CaptureBridge.swift — dlopen CoreSimulator/SimulatorKit, resolve the target
// SimDevice, and hand it to the ObjC framebuffer capture core (CaptureInject.m).
// Ported from Argus's ArgusBridge.swift, capture half only (no HID injection).
import Foundation
import CoreGraphics

// MARK: - Frame callback type
// One Annex B access unit per invocation (SPS/PPS prepended on keyframes).
typealias FrameCallback = @convention(c) (UnsafePointer<UInt8>, UInt) -> Void

// C capture primitives (defined in CaptureInject.m), linked by symbol.
@_silgen_name("SHStartFramebuffer")
func SHStartFramebuffer(_ device: AnyObject, _ callback: FrameCallback) -> Int32

@_silgen_name("SHStopFramebuffer")
func SHStopFramebuffer()

@_silgen_name("SHRequestKeyframe")
func SHRequestKeyframe()

@_silgen_name("SHEnableHardwareKeyboard")
func SHEnableHardwareKeyboard(_ device: AnyObject)

// MARK: - Framework loading

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

/// Ensure CoreSimulator.framework is loaded (required before SimServiceContext).
@discardableResult
private func ensureCoreSimLoaded() -> Bool {
    if coreSimLoaded { return coreSimOk }
    coreSimLoaded = true
    let p = "/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator"
    coreSimOk = dlopen(p, RTLD_NOW | RTLD_GLOBAL) != nil
    if !coreSimOk { NSLog("[CoreSim] Failed to load CoreSimulator from %@", p) }
    return coreSimOk
}

/// Ensure SimulatorKit.framework is loaded (required for SimDeviceIOClient).
@discardableResult
private func ensureSimKitLoaded() -> Bool {
    if simKitLoaded { return simKitOk }
    simKitLoaded = true
    ensureCoreSimLoaded()
    let p = xcodeDevDir() + "/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit"
    simKitOk = dlopen(p, RTLD_NOW | RTLD_GLOBAL) != nil
    if !simKitOk { NSLog("[SimKit] Failed to load SimulatorKit from %@", p) }
    return simKitOk
}

/// Resolve a SimDevice by UDID via CoreSimulator's default device set.
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
    NSLog("[Capture] No SimDevice for UDID %@", udid)
    return nil
}

// MARK: - Public capture wrappers

/// Start capturing the simulator framebuffer. `callback` receives H.264 Annex B
/// access units at ~30fps. Returns 0 on success, non-zero on failure.
func csStartFramebuffer(_ udid: UnsafePointer<CChar>, _ callback: @escaping FrameCallback) -> Int32 {
    let udidStr = String(cString: udid)
    guard ensureSimKitLoaded() else { return -1 }
    guard let device = findSimDevice(udid: udidStr) else { return -1 }
    // Enable hardware-keyboard mode once per capture session.
    SHEnableHardwareKeyboard(device)
    return SHStartFramebuffer(device, callback)
}

/// Stop the active framebuffer capture.
func csStopFramebuffer() {
    SHStopFramebuffer()
}
