//
// Handlers.swift
//
// In-process implementations of the five interaction routes:
//
//   POST /touch       — TouchRequest        → tap / long-press at (x,y)
//   POST /swipeV2     — SwipeRequest        → linear swipe
//   POST /gesturePath — GesturePathRequest  → multi-finger arbitrary path
//   POST /pressKey    — PressKeyRequest     → hardware/system key
//   POST /inputText   — InputTextRequest    → first-responder insertText with HID fallback
//
// JSON shapes mirror packages/ios-driver/conductor-driver-iosUITests/Routes/Models
// exactly so the CLI's TypeScript IOSDriver can swap URLs without changing the
// wire contract.
//
// In-process gesture synthesis uses the public UIEvent / UITouch surface where
// possible, with documented fallbacks where Conductor's existing XCUITest
// approach can't be replicated outside the XCTest runner. The dylib's
// "fidelity" is intentionally coarser than XCUITest — the CLI is expected to
// fall back to XCUITest for any app that surfaces gesture-recognition issues.
//

import Foundation
import UIKit

// MARK: - Decoders

private struct TouchRequest: Decodable {
    let x: Double
    let y: Double
    let duration: Double?
}

private struct SwipeRequest: Decodable {
    let startX: Double
    let startY: Double
    let endX: Double
    let endY: Double
    let duration: Double
    let appIds: [String]?
}

private struct GestureStep: Decodable {
    let x: Double
    let y: Double
    let dt: Double
}

private struct GestureFingerPath: Decodable {
    let steps: [GestureStep]
}

private struct GesturePathRequest: Decodable {
    let paths: [GestureFingerPath]
}

private struct PressKeyRequest: Decodable {
    let key: String
}

private struct InputTextRequest: Decodable {
    let text: String
    let appIds: [String]?
}

// MARK: - Utilities

private func decode<T: Decodable>(_ type: T.Type, from data: Data) -> T? {
    return try? JSONDecoder().decode(T.self, from: data)
}

/// Run a block on the main thread synchronously and return its result.
///
/// All the gesture/keyboard/text routes touch UIKit, which Swift infers as
/// `@MainActor`. The block parameter is annotated `@MainActor` so the
/// compiler accepts UIKit calls inside it. When we're already on the main
/// thread we hop into the actor with `MainActor.assumeIsolated`; otherwise
/// we dispatch and the closure runs on main implicitly.
private func onMainSync(_ block: @escaping @MainActor () -> HTTPResponse) -> HTTPResponse {
    if Thread.isMainThread {
        return MainActor.assumeIsolated { block() }
    }
    var result: HTTPResponse = HTTPResponse.error("never executed")
    let semaphore = DispatchSemaphore(value: 0)
    DispatchQueue.main.async {
        result = MainActor.assumeIsolated { block() }
        semaphore.signal()
    }
    semaphore.wait()
    return result
}

// MARK: - Touch

enum TouchHandler {
    static func handle(_ req: HTTPRequest) -> HTTPResponse {
        guard let body = decode(TouchRequest.self, from: req.body) else {
            return HTTPResponse.error("invalid /touch body", status: 400)
        }
        return onMainSync {
            GestureSynthesizer.tap(
                at: CGPoint(x: body.x, y: body.y),
                duration: body.duration
            )
            return HTTPResponse.ok
        }
    }
}

// MARK: - Swipe

enum SwipeHandler {
    static func handle(_ req: HTTPRequest) -> HTTPResponse {
        guard let body = decode(SwipeRequest.self, from: req.body) else {
            return HTTPResponse.error("invalid /swipeV2 body", status: 400)
        }
        return onMainSync {
            GestureSynthesizer.swipe(
                from: CGPoint(x: body.startX, y: body.startY),
                to: CGPoint(x: body.endX, y: body.endY),
                duration: body.duration
            )
            return HTTPResponse.ok
        }
    }
}

// MARK: - Gesture path

enum GesturePathHandler {
    static func handle(_ req: HTTPRequest) -> HTTPResponse {
        guard let body = decode(GesturePathRequest.self, from: req.body) else {
            return HTTPResponse.error("invalid /gesturePath body", status: 400)
        }
        return onMainSync {
            GestureSynthesizer.playGesturePaths(body.paths.map { path in
                path.steps.map { (CGPoint(x: $0.x, y: $0.y), $0.dt) }
            })
            return HTTPResponse.ok
        }
    }
}

// MARK: - Press key

enum PressKeyHandler {
    static func handle(_ req: HTTPRequest) -> HTTPResponse {
        guard let body = decode(PressKeyRequest.self, from: req.body) else {
            return HTTPResponse.error("invalid /pressKey body", status: 400)
        }
        return onMainSync {
            KeyboardHelper.pressKey(body.key)
            return HTTPResponse.ok
        }
    }
}

// MARK: - Input text

enum InputTextHandler {
    static func handle(_ req: HTTPRequest) -> HTTPResponse {
        guard let body = decode(InputTextRequest.self, from: req.body) else {
            return HTTPResponse.error("invalid /inputText body", status: 400)
        }
        return onMainSync {
            TextInsertion.insert(body.text)
            return HTTPResponse.ok
        }
    }
}
