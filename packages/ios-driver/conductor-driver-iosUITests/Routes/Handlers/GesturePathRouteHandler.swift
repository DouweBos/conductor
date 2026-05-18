import FlyingFox
import XCTest
import os

@MainActor
struct GesturePathRouteHandler: HTTPHandler {
    private let logger = Logger(
        subsystem: Bundle.main.bundleIdentifier!,
        category: String(describing: Self.self)
    )

    func handleRequest(_ request: FlyingFox.HTTPRequest) async throws -> FlyingFox.HTTPResponse {
        guard let body = try? await JSONDecoder().decode(GesturePathRequest.self, from: request.bodyData) else {
            return AppError(type: .precondition, message: "incorrect request body for gesturePath").httpResponse
        }
        if body.paths.isEmpty {
            return AppError(type: .precondition, message: "gesturePath requires at least one finger path").httpResponse
        }
        for (i, finger) in body.paths.enumerated() {
            if finger.steps.isEmpty {
                return AppError(type: .precondition, message: "gesturePath finger \(i) has no steps").httpResponse
            }
        }

        do {
            try await dispatch(body)
            return HTTPResponse(statusCode: .ok)
        } catch {
            return AppError(message: "gesturePath failed: \(error.localizedDescription)").httpResponse
        }
    }

    private func dispatch(_ request: GesturePathRequest) async throws {
        let (width, height) = ScreenSizeHelper.physicalScreenSize()
        let style: EventRecord.Style = request.paths.count > 1 ? .multiFinger : .singleFinger
        let pathCount = request.paths.count
        let description = "Gesture: \(pathCount) finger path\(pathCount == 1 ? "" : "s")"
        logger.info("\(description)")

        let target = EventTarget()
        try await target.dispatchEvent(description: description) {
            let record = EventRecord(orientation: .portrait, style: style)
            for finger in request.paths {
                // First step: touch down at its (x, y) with `dt` as initial offset.
                let firstStep = finger.steps[0]
                let firstPoint = ScreenSizeHelper.orientationAwarePoint(
                    width: width,
                    height: height,
                    point: CGPoint(x: firstStep.x, y: firstStep.y)
                )
                var path = PointerEventPath.pathForTouch(at: firstPoint, offset: firstStep.dt)
                // Subsequent steps: advance offset by `dt`, move to point.
                for i in 1..<finger.steps.count {
                    let step = finger.steps[i]
                    path.offset += step.dt
                    let point = ScreenSizeHelper.orientationAwarePoint(
                        width: width,
                        height: height,
                        point: CGPoint(x: step.x, y: step.y)
                    )
                    path.moveTo(point: point)
                }
                // Lift at the current offset (after the last move).
                path.liftUp()
                _ = record.add(path)
            }
            return record
        }
    }
}
