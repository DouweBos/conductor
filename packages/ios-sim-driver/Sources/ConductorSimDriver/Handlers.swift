//
// Handlers.swift
//
// Route handlers for the host-side sim-driver. Each handler decodes the JSON
// body (matching the same shapes the XCUITest driver accepts so the CLI can
// swap URLs invisibly) and synthesizes one or more IOHIDEvents that get
// dispatched to the simulator's IO client.
//
// Coordinate space matches what XCUITest accepts: points in the device's
// natural orientation. CoreSimulator's digitizer events take points in the
// same space, so no transformation is needed.
//
// Sampling rate for swipes: 60 Hz (16 ms steps). For very short swipes
// (< 16 ms) we still emit at least one move between the down and up events
// so receivers see a real movement, not just two endpoints.
//
import Foundation
import CCoreSimulator

final class Handlers {
    private let bridge: SimDeviceBridge
    private let udid: String

    init(bridge: SimDeviceBridge, udid: String) {
        self.bridge = bridge
        self.udid = udid
    }

    // MARK: - /status

    func status() -> HTTPResponse {
        // Body keys mirror what conductor-driver-iosUITests' /status emits so
        // the CLI can treat both servers uniformly. Adds `driver: "sim"` and
        // `developerDir` to make ABI-drift debugging easier.
        let ok = bridge.isReady
        let err = bridge.lastError.map { ",\"error\":\"\(escape($0))\"" } ?? ""
        let body = """
        {"ok":\(ok),"udid":"\(escape(udid))","driver":"sim","developerDir":"\(escape(bridge.developerDir))"\(err)}
        """
        return HTTPResponse(status: 200, body: body)
    }

    // MARK: - /touch

    /// JSON body: `{ "x": Number, "y": Number, "duration"?: Number }`
    /// `duration` is seconds; defaults to a short tap (~50 ms).
    func touch(_ req: HTTPRequest) -> HTTPResponse {
        guard bridge.isReady else { return notReady() }
        guard let obj = parseJSON(req.body),
              let x = obj["x"] as? Double,
              let y = obj["y"] as? Double
        else {
            return HTTPResponse.error("bad request: expected {x,y}", status: 400)
        }
        let duration = (obj["duration"] as? Double) ?? 0.05

        // touch-down → optional hold → touch-up.
        dispatchFinger(x: Float(x), y: Float(y), isDown: true)
        if duration > 0 {
            Thread.sleep(forTimeInterval: duration)
        }
        dispatchFinger(x: Float(x), y: Float(y), isDown: false)
        return .ok
    }

    // MARK: - /swipeV2

    /// JSON body matches XCUITest's SwipeRequest:
    /// `{ startX, startY, endX, endY, duration, appIds? }`
    /// `duration` is seconds; we ignore `appIds` (XCUITest hint, not needed at HID layer).
    func swipe(_ req: HTTPRequest) -> HTTPResponse {
        guard bridge.isReady else { return notReady() }
        guard let obj = parseJSON(req.body),
              let sx = obj["startX"] as? Double,
              let sy = obj["startY"] as? Double,
              let ex = obj["endX"] as? Double,
              let ey = obj["endY"] as? Double,
              let dur = obj["duration"] as? Double
        else {
            return HTTPResponse.error("bad request: expected {startX,startY,endX,endY,duration}", status: 400)
        }

        let stepMs = 16.0
        let totalMs = max(dur * 1000.0, stepMs)
        let stepCount = max(1, Int((totalMs / stepMs).rounded()))
        let perStepDelay = (dur / Double(stepCount))

        // Touch down at start.
        dispatchFinger(x: Float(sx), y: Float(sy), isDown: true)

        for s in 1...stepCount {
            Thread.sleep(forTimeInterval: perStepDelay)
            let t = Double(s) / Double(stepCount)
            let x = sx + (ex - sx) * t
            let y = sy + (ey - sy) * t
            dispatchFinger(x: Float(x), y: Float(y), isDown: true)
        }

        // Touch up at end.
        dispatchFinger(x: Float(ex), y: Float(ey), isDown: false)
        return .ok
    }

    // MARK: - /gesturePath

    /// JSON body matches XCUITest's GesturePathRequest:
    /// `{ paths: [{ steps: [{ x, y, dt }] }] }`
    /// Each path is one finger; `dt` is seconds since the previous step (or
    /// initial offset for the first step).
    ///
    /// We process the paths as a global timeline: at each tick, emit one
    /// digitizer parent containing one finger event per active path. This is
    /// the only way to get true multi-touch — emitting per-path serially
    /// would look like sequential single-finger touches to receivers.
    func gesturePath(_ req: HTTPRequest) -> HTTPResponse {
        guard bridge.isReady else { return notReady() }
        guard let obj = parseJSON(req.body),
              let paths = obj["paths"] as? [[String: Any]]
        else {
            return HTTPResponse.error("bad request: expected {paths:[...]}", status: 400)
        }

        // Flatten into per-finger absolute-time step lists.
        struct AbsStep { let t: Double; let x: Float; let y: Float }
        var perFinger: [[AbsStep]] = []
        for p in paths {
            guard let steps = p["steps"] as? [[String: Any]], !steps.isEmpty else { continue }
            var acc: Double = 0
            var out: [AbsStep] = []
            for s in steps {
                guard let x = s["x"] as? Double, let y = s["y"] as? Double else { continue }
                let dt = (s["dt"] as? Double) ?? 0
                acc += dt
                out.append(AbsStep(t: acc, x: Float(x), y: Float(y)))
            }
            if !out.isEmpty { perFinger.append(out) }
        }
        if perFinger.isEmpty { return .ok }

        // Build a sorted list of unique tick times. We'll emit a digitizer
        // parent at each tick with all fingers active at that moment.
        var allTicks = Set<Double>()
        for f in perFinger {
            for s in f { allTicks.insert(s.t) }
        }
        let ticks = allTicks.sorted()

        var lastT: Double = 0
        for (idx, t) in ticks.enumerated() {
            let delay = t - lastT
            if delay > 0 { Thread.sleep(forTimeInterval: delay) }
            lastT = t

            // Build a parent digitizer event with one child per finger that
            // either has a step at this tick or is between steps.
            let isLastTick = idx == ticks.count - 1
            let parent = csd_create_digitizer_event(
                0,
                CSD_DIGITIZER_MASK_TOUCH | CSD_DIGITIZER_MASK_POSITION,
                UInt32(perFinger.count),
                isLastTick ? 0 : 1,
                isLastTick ? 0 : 1)
            guard let parent = parent else { continue }

            for (fIdx, finger) in perFinger.enumerated() {
                // Find the step at-or-just-before `t`. If none, this finger
                // isn't down yet; skip.
                var pos: (Float, Float)?
                for s in finger {
                    if s.t <= t { pos = (s.x, s.y) }
                    else { break }
                }
                guard let (x, y) = pos else { continue }
                let isDown = !isLastTick
                if let child = csd_create_finger_event(
                    0,
                    UInt32(fIdx + 1),
                    UInt32(fIdx + 1),
                    CSD_DIGITIZER_MASK_TOUCH | CSD_DIGITIZER_MASK_POSITION,
                    x, y,
                    1.0,
                    isDown ? 1 : 0,
                    isDown ? 1 : 0) {
                    csd_append_child(parent, child)
                    csd_release_event(child)
                }
            }
            _ = bridge.dispatch(event: parent)
        }
        return .ok
    }

    // MARK: - /pressKey

    /// `{ "key": "delete"|"return"|"enter"|"tab"|"space" }`
    func pressKey(_ req: HTTPRequest) -> HTTPResponse {
        guard bridge.isReady else { return notReady() }
        guard let obj = parseJSON(req.body),
              let key = obj["key"] as? String
        else {
            return HTTPResponse.error("bad request: expected {key}", status: 400)
        }
        // USB HID usage codes (kHIDPage_KeyboardOrKeypad).
        let usage: UInt32?
        switch key {
        case "delete": usage = 0x2A  // kHIDUsage_KeyboardDeleteOrBackspace
        case "return", "enter": usage = 0x28  // kHIDUsage_KeyboardReturnOrEnter
        case "tab": usage = 0x2B  // kHIDUsage_KeyboardTab
        case "space": usage = 0x2C  // kHIDUsage_KeyboardSpacebar
        default: return HTTPResponse.error("unsupported key: \(key)", status: 400)
        }
        guard let usage = usage else { return HTTPResponse.error("unmapped", status: 500) }

        if let down = csd_create_keyboard_event(0, UInt32(CSD_HID_PAGE_KEYBOARD), usage, 1) {
            _ = bridge.dispatch(event: down)
        }
        Thread.sleep(forTimeInterval: 0.02)
        if let up = csd_create_keyboard_event(0, UInt32(CSD_HID_PAGE_KEYBOARD), usage, 0) {
            _ = bridge.dispatch(event: up)
        }
        return .ok
    }

    // MARK: - /pressButton

    /// `{ "button": "home"|"lock"|... }`
    /// home/lock support varies by simulator version — best-effort. Directional
    /// buttons map to the Consumer / GenericDesktop HID pages.
    func pressButton(_ req: HTTPRequest) -> HTTPResponse {
        guard bridge.isReady else { return notReady() }
        guard let obj = parseJSON(req.body),
              let button = obj["button"] as? String
        else {
            return HTTPResponse.error("bad request: expected {button}", status: 400)
        }

        // Consumer page usages used by Apple's HID buttons. Values from
        // IOKit's IOHIDUsageTables.h (public).
        struct Map { let page: UInt32; let usage: UInt32 }
        let m: Map?
        switch button {
        case "home":    m = Map(page: UInt32(CSD_HID_PAGE_CONSUMER), usage: 0x40)  // AC Home
        case "lock":    m = Map(page: UInt32(CSD_HID_PAGE_CONSUMER), usage: 0x30)  // Power
        case "menu":    m = Map(page: UInt32(CSD_HID_PAGE_CONSUMER), usage: 0x86)  // Menu Pick
        case "select":  m = Map(page: UInt32(CSD_HID_PAGE_KEYBOARD), usage: 0x28)  // Return
        case "playPause": m = Map(page: UInt32(CSD_HID_PAGE_CONSUMER), usage: 0xCD) // Play/Pause
        case "up":      m = Map(page: UInt32(CSD_HID_PAGE_KEYBOARD), usage: 0x52)
        case "down":    m = Map(page: UInt32(CSD_HID_PAGE_KEYBOARD), usage: 0x51)
        case "left":    m = Map(page: UInt32(CSD_HID_PAGE_KEYBOARD), usage: 0x50)
        case "right":   m = Map(page: UInt32(CSD_HID_PAGE_KEYBOARD), usage: 0x4F)
        default: return HTTPResponse.error("unsupported button: \(button)", status: 400)
        }
        guard let m = m else { return HTTPResponse.error("unmapped", status: 500) }

        if let down = csd_create_keyboard_event(0, m.page, m.usage, 1) {
            _ = bridge.dispatch(event: down)
        }
        Thread.sleep(forTimeInterval: 0.05)
        if let up = csd_create_keyboard_event(0, m.page, m.usage, 0) {
            _ = bridge.dispatch(event: up)
        }
        return .ok
    }

    // MARK: - Helpers

    private func notReady() -> HTTPResponse {
        return HTTPResponse.error(
            "sim-driver not ready: \(bridge.lastError ?? "unknown")",
            status: 500)
    }

    private func dispatchFinger(x: Float, y: Float, isDown: Bool) {
        let mask = CSD_DIGITIZER_MASK_TOUCH | CSD_DIGITIZER_MASK_POSITION
        guard let parent = csd_create_digitizer_event(
            0, mask, 1, isDown ? 1 : 0, isDown ? 1 : 0)
        else { return }
        if let child = csd_create_finger_event(
            0, 1, 1, mask, x, y, 1.0,
            isDown ? 1 : 0, isDown ? 1 : 0) {
            csd_append_child(parent, child)
            csd_release_event(child)
        }
        _ = bridge.dispatch(event: parent)
    }

    private func parseJSON(_ data: Data) -> [String: Any]? {
        guard !data.isEmpty else { return [:] }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }
}

private func escape(_ s: String) -> String {
    s.replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: "\"", with: "\\\"")
}
