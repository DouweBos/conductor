import FlyingFox
import XCTest
import os

@MainActor
struct SwipeRouteHandler: HTTPHandler {
    private let logger = Logger(
        subsystem: Bundle.main.bundleIdentifier!,
        category: String(describing: Self.self)
    )

    /// Gap kept between a keyboard-avoiding drag and the keyboard's top edge.
    private static let keyboardClearancePoints: CGFloat = 12

    func handleRequest(_ request: FlyingFox.HTTPRequest) async throws -> FlyingFox.HTTPResponse {
        guard let requestBody = try? await JSONDecoder().decode(SwipeRequest.self, from: request.bodyData) else {
            return AppError(type: .precondition, message: "incorrect request body provided for swipe request").httpResponse
        }

        if (requestBody.duration < 0) {
            return AppError(type: .precondition, message: "swipe duration can not be negative").httpResponse
        }

        do {
            try await swipePrivateAPI(requestBody)
            return HTTPResponse(statusCode: .ok)
        } catch let error {
            return AppError(message: "Swipe request failure. Error: \(error.localizedDescription)").httpResponse
        }
    }

    func swipePrivateAPI(_ request: SwipeRequest) async throws {
        let (width, height) = ScreenSizeHelper.physicalScreenSize()
        let rawStart = ScreenSizeHelper.orientationAwarePoint(
            width: width,
            height: height,
            point: request.start
        )
        let rawEnd = ScreenSizeHelper.orientationAwarePoint(
            width: width,
            height: height,
            point: request.end
        )
        let (startPoint, endPoint) = keyboardAvoidingPoints(start: rawStart, end: rawEnd)

        let description = "Swipe from \(startPoint) to \(endPoint) with \(request.duration) duration"
        logger.info("\(description)")

        let eventTarget = EventTarget()
        try await eventTarget.dispatchEvent(description: description) {
            EventRecord(orientation: .portrait)
                .addSwipeEvent(
                    start: startPoint,
                    end: endPoint,
                    duration: request.duration
                )
        }
    }

    /// Lifts a predominantly vertical drag upwards so it stays clear of the
    /// on-screen keyboard. Faster replay can begin a scroll while the keyboard
    /// is still presented; without this the gesture lands on keyboard keys
    /// instead of the content beneath them.
    ///
    /// Horizontal-dominant gestures are left untouched (a sideways swipe over
    /// the keyboard is usually intentional), as are gestures that never reach
    /// the keyboard or that could not be lifted without running off-screen.
    private func keyboardAvoidingPoints(start: CGPoint, end: CGPoint) -> (CGPoint, CGPoint) {
        guard abs(end.y - start.y) > abs(end.x - start.x) else { return (start, end) }

        guard let app = RunningApp.getForegroundApp() else { return (start, end) }
        let keyboard = app.keyboards.firstMatch
        guard keyboard.exists else { return (start, end) }
        let keyboardFrame = keyboard.frame
        guard keyboardFrame.height > 0 else { return (start, end) }

        let gestureMaxY = max(start.y, end.y)
        guard gestureMaxY > keyboardFrame.minY else { return (start, end) }

        let shift = gestureMaxY - (keyboardFrame.minY - Self.keyboardClearancePoints)
        guard shift > 0 else { return (start, end) }

        let liftedStart = CGPoint(x: start.x, y: start.y - shift)
        let liftedEnd = CGPoint(x: end.x, y: end.y - shift)
        guard min(liftedStart.y, liftedEnd.y) >= 0 else { return (start, end) }

        logger.info("Lifted swipe by \(shift)pt to clear keyboard at y=\(keyboardFrame.minY)")
        return (liftedStart, liftedEnd)
    }
}
