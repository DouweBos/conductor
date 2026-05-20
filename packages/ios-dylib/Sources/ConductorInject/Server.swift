//
// Server.swift
//
// Singleton that owns the HTTP listener and wires the five route handlers.
// Reads CONDUCTOR_DYLIB_PORT and the host app's bundle identifier; logs
// registration to stderr so the daemon can see which apps have the dylib
// loaded.
//

import Foundation
import UIKit

final class ConductorInjectServer {
    static let shared = ConductorInjectServer()

    private var server: HTTPServer?
    private var started = false

    func start() {
        // Idempotent — DYLD_INSERT_LIBRARIES can fire the constructor twice
        // on some configurations (e.g. when re-spawned by ASan shim).
        guard !started else { return }
        started = true

        // `launchctl setenv DYLD_INSERT_LIBRARIES` applies to every process
        // spawned in the simulator — including non-app helpers Conductor's
        // own daemon spawns (the `log stream` subprocess, xpc helpers, etc.).
        // Those would happily bind the dylib port first, blocking the real
        // target app's listener. Filter to "this looks like a real iOS app"
        // by requiring a bundle identifier; CLI tools and most system helpers
        // don't have one.
        guard let bundleId = Bundle.main.bundleIdentifier else {
            log("no bundle identifier — refusing to start listener (likely a CLI helper, not an app)")
            return
        }

        guard let portString = ProcessInfo.processInfo.environment["CONDUCTOR_DYLIB_PORT"],
              let port = UInt16(portString) else {
            log("CONDUCTOR_DYLIB_PORT not set or invalid — refusing to start listener")
            return
        }

        let server = HTTPServer(port: port)
        server.route("/status", { [weak self] _ in
            let bundleId = Bundle.main.bundleIdentifier ?? "<unknown>"
            let pid = ProcessInfo.processInfo.processIdentifier
            let escaped = bundleId.replacingOccurrences(of: "\"", with: "\\\"")
            self.map { _ in () }
            return HTTPResponse(
                status: 200,
                body: "{\"ok\":true,\"bundleId\":\"\(escaped)\",\"pid\":\(pid),\"driver\":\"dylib\"}"
            )
        })
        server.route("/touch", { req in
            TouchHandler.handle(req)
        })
        server.route("/swipeV2", { req in
            SwipeHandler.handle(req)
        })
        server.route("/gesturePath", { req in
            GesturePathHandler.handle(req)
        })
        server.route("/pressKey", { req in
            PressKeyHandler.handle(req)
        })
        server.route("/inputText", { req in
            InputTextHandler.handle(req)
        })

        do {
            try server.start()
            self.server = server
            log("registered for bundleId=\(bundleId) on port=\(port)")
        } catch {
            log("failed to start listener on port \(port): \(error)")
        }
    }

    private func log(_ message: String) {
        let line = "[ConductorInject] \(message)\n"
        FileHandle.standardError.write(Data(line.utf8))
    }
}
