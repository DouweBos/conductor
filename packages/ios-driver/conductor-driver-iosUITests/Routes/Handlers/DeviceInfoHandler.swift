import Foundation
import FlyingFox
import os
import XCTest
import Network

@MainActor
struct DeviceInfoHandler: HTTPHandler {
    private let logger = Logger(
        subsystem: Bundle.main.bundleIdentifier!,
        category: String(describing: Self.self)
    )

    func handleRequest(_ request: HTTPRequest) async throws -> HTTPResponse {
        do {
            let (width, height, orientation) = try ScreenSizeHelper.actualScreenSize()
            NSLog("Device orientation is \(String(orientation.rawValue))")

            #if os(macOS)
            let platform = "MACOS"
            let scale = MacScreen.current().scale
            #elseif os(tvOS)
            let platform = "TVOS"
            let scale = UIScreen.main.scale
            #else
            let platform = "IOS"
            let scale = UIScreen.main.scale
            #endif

            let deviceInfo = DeviceInfoResponse(
                widthPoints: Int(width),
                heightPoints: Int(height),
                widthPixels: Int(CGFloat(width) * scale),
                heightPixels: Int(CGFloat(height) * scale),
                platform: platform
            )

            let responseBody = try JSONEncoder().encode(deviceInfo)
            return HTTPResponse(statusCode: .ok, body: responseBody)
        } catch let error {
            return AppError(message: "Getting device info call failed. Error \(error.localizedDescription)").httpResponse
        }
    }
}
