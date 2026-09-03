import FlyingFox
import Foundation

enum Route: String, CaseIterable {
    case runningApp
    case swipe
    case inputText
    case touch
    case gesturePath
    case screenshot
    case isScreenStatic
    case pressKey
    case pressButton
    case eraseText
    case deviceInfo
    case setOrientation
    case setPermissions
    case viewHierarchy
    case queryElement
    case status
    case keyboard
    case launchApp
    case terminateApp
    case restoreFocus

    func toHTTPRoute() -> HTTPRoute {
        return HTTPRoute(rawValue)
    }
}

struct XCTestHTTPServer {
    func start() async throws {
        let env = ProcessInfo.processInfo.environment
        let port = env["PORT"]?.toUInt16()
        // Physical devices have no shared loopback with the host, so the CLI sets
        // BIND_ALL and reaches the driver over the network instead.
        let host = env["BIND_ALL"] == "1" ? "0.0.0.0" : "127.0.0.1"
        let server = HTTPServer(address: try .inet(ip4: host, port: port ?? 1075), timeout: 100)
        
        for route in Route.allCases {
            let handler = await RouteHandlerFactory.createRouteHandler(route: route)
            await server.appendRoute(route.toHTTPRoute(), to: handler)
        }
        
        try await server.run()
    }
}
