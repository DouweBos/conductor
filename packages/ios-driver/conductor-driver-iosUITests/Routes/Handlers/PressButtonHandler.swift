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
        }
        if let duration = requestBody.duration, duration > 0 {
            XCUIRemote.shared.press(remoteButton, forDuration: duration)
        } else {
            XCUIRemote.shared.press(remoteButton)
        }
        #else
        switch requestBody.button {
        case .home:
            XCUIDevice.shared.press(.home)
        case .lock:
            XCUIDevice.shared.perform(NSSelectorFromString("pressLockButton"))
        }
        #endif
        return HTTPResponse(statusCode: .ok)
    }
}
