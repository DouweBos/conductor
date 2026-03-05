import XCTest
import FlyingFox
import os

final class conductor_driver_iosUITests: XCTestCase {
   
    private static let logger = Logger(
        subsystem: Bundle.main.bundleIdentifier!,
        category: "conductor_driver_iosUITests"
    )

    private static var swizzledOutIdle = false

    override func setUpWithError() throws {
        // XCTest internals sometimes use XCTAssert* instead of exceptions.
        // Setting `continueAfterFailure` so that the xctest runner does not stop
        // when an XCTest internal error happes (eg: when using .allElementsBoundByIndex
        // on a ReactNative app)
        continueAfterFailure = true
    }

    override class func setUp() {
        logger.trace("setUp")
    }

    func testHttpServer() async throws {
        let server = XCTestHTTPServer()
        conductor_driver_iosUITests.logger.info("Will start HTTP server")
        try await server.start()
    }

    override class func tearDown() {
        logger.trace("tearDown")
    }
}
