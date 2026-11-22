import Foundation
import FlyingFox
import os
import XCTest
import Network

@MainActor
struct PressButtonHandler: HTTPHandler {
    private let logger = Logger(
        subsystem: Bundle.main.bundleIdentifier!,
        category: String(describing: Self.self)
    )

    func handleRequest(_ request: HTTPRequest) async throws -> HTTPResponse {
        guard let requestBody = try? await JSONDecoder().decode(PressButtonRequest.self, from: request.bodyData) else {
            return AppError(type: .precondition, message: "Incorrect request body for PressButton Handler").httpResponse
        }
        
        #if os(tvOS)
        // Map to an XCUIRemote button, then honor an optional held-press duration.
        let remoteButton: XCUIRemote.Button
        switch requestBody.button {
        case .home, .lock:
            remoteButton = .home
        case .up:
            remoteButton = .up
        case .down:
            remoteButton = .down
        case .left:
            remoteButton = .left
        case .right:
            remoteButton = .right
        case .select:
            remoteButton = .select
        case .menu:
            remoteButton = .menu
        case .playPause:
            remoteButton = .playPause
        case .pageUp, .pageDown, .guide:
            guard #available(tvOS 14.3, *) else {
                return unavailable(requestBody.button, since: "tvOS 14.3")
            }
            switch requestBody.button {
            case .pageUp: remoteButton = .pageUp
            case .pageDown: remoteButton = .pageDown
            default: remoteButton = .guide
            }
        case .tvProvider, .oneTwoThree, .fourColors:
            guard #available(tvOS 18.1, *) else {
                return unavailable(requestBody.button, since: "tvOS 18.1")
            }
            switch requestBody.button {
            case .tvProvider: remoteButton = .tvProvider
            case .oneTwoThree: remoteButton = .oneTwoThree
            default: remoteButton = .fourColors
            }
        }
        if let duration = requestBody.duration, duration > 0 {
            XCUIRemote.shared.press(remoteButton, forDuration: duration)
        } else {
            XCUIRemote.shared.press(remoteButton)
        }
        #elseif os(watchOS)
        switch requestBody.button {
        case .home:
            // A Digital Crown press: watch face from an app, app grid from the face.
            XCUIDevice.shared.press(.home)
        case .lock:
            return AppError(type: .precondition, message: "Button lock does not exist on watchOS").httpResponse
        case .crownUp, .crownDown:
            // A positive delta reveals content further down a list; half a turn is about one screen.
            let turns = abs(requestBody.rotations ?? 0.5)
            XCUIDevice.shared.rotateDigitalCrown(delta: requestBody.button == .crownDown ? turns : -turns)
        case .action:
            guard XCUIDevice.shared.hasHardwareButton(.action) else {
                return AppError(
                    type: .precondition,
                    message: "This watch has no Action Button; use an Apple Watch Ultra simulator"
                ).httpResponse
            }
            XCUIDevice.shared.press(.action)
        case .back:
            // watchOS has no back key; pop the navigation stack via its back button.
            let app = RunningApp.getForegroundApp() ?? XCUIApplication(bundleIdentifier: RunningApp.homeBundleId)
            let buttons = app.buttons.matching(identifier: "BackButton").allElementsBoundByIndex
            guard buttons.count == 1, let button = buttons.first, button.isHittable else {
                return AppError(type: .precondition, message: "This screen has no navigation back button").httpResponse
            }
            button.tap()
        case .doubleTap:
            guard XCUIDevice.shared.supportsHandGestures else {
                return AppError(type: .precondition, message: "This watch does not support hand gestures").httpResponse
            }
            XCUIDevice.shared.perform(handGesture: .doubleTap)
        }
        #elseif os(macOS)
        return AppError(
            type: .precondition,
            message: "Button \(requestBody.button.rawValue) does not exist on macOS"
        ).httpResponse
        #else
        switch requestBody.button {
        case .home:
            XCUIDevice.shared.press(.home)
        case .lock:
            XCUIDevice.shared.perform(NSSelectorFromString("pressLockButton"))
        }
        #endif
        #if !os(macOS)
        return HTTPResponse(statusCode: .ok)
        #endif
    }

    #if os(tvOS)
    private func unavailable(_ button: PressButtonRequest.Button, since: String) -> HTTPResponse {
        AppError(
            type: .precondition,
            message: "Button \(button.rawValue) needs \(since) or newer"
        ).httpResponse
    }
    #endif
}
