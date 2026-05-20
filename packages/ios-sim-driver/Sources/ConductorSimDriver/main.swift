//
// main.swift
//
// Entry point for conductor-sim-driver. Parses --udid / --port, resolves the
// SimDevice via CoreSimulator, opens an HTTP listener on 127.0.0.1:<port>,
// and serves the HID-class routes.
//
// One process per simulator UDID. The daemon owns the lifecycle: spawns,
// kills, polls the port. Stdout/stderr are surfaced to the daemon's log
// only on startup — the process is otherwise detached.
//
// Usage:
//   conductor-sim-driver --udid <UUID> --port <PORT>
//
import Foundation

// MARK: - Argument parsing

func usage() -> Never {
    FileHandle.standardError.write(Data("usage: conductor-sim-driver --udid <UUID> --port <PORT>\n".utf8))
    exit(2)
}

var udid: String?
var port: UInt16?

var i = 1
let args = CommandLine.arguments
while i < args.count {
    let arg = args[i]
    switch arg {
    case "--udid":
        i += 1
        guard i < args.count else { usage() }
        udid = args[i]
    case "--port":
        i += 1
        guard i < args.count else { usage() }
        port = UInt16(args[i])
    case "--help", "-h":
        usage()
    default:
        FileHandle.standardError.write(Data("unknown arg: \(arg)\n".utf8))
        usage()
    }
    i += 1
}

guard let udid = udid, let port = port else { usage() }

// MARK: - CoreSimulator resolution

let bridge = SimDeviceBridge()
do {
    try bridge.resolve(udid: udid)
} catch {
    // Surface the failure on stderr so the daemon can capture it. We *don't*
    // exit — the process keeps running and returns 500 on every route, so
    // the JS fallback to XCUITest kicks in and the user sees the cause.
    FileHandle.standardError.write(Data("conductor-sim-driver: failed to resolve SimDevice: \(error)\n".utf8))
}

// MARK: - HTTP server

let server = HTTPServer(port: port)
let handlers = Handlers(bridge: bridge, udid: udid)

server.route("/status") { _ in handlers.status() }
server.route("/touch") { req in handlers.touch(req) }
server.route("/swipeV2") { req in handlers.swipe(req) }
server.route("/gesturePath") { req in handlers.gesturePath(req) }
server.route("/pressKey") { req in handlers.pressKey(req) }
server.route("/pressButton") { req in handlers.pressButton(req) }

do {
    try server.start()
    FileHandle.standardError.write(Data("conductor-sim-driver: listening on 127.0.0.1:\(port) for udid=\(udid)\n".utf8))
} catch {
    FileHandle.standardError.write(Data("conductor-sim-driver: failed to start HTTP server: \(error)\n".utf8))
    exit(1)
}

// Block forever.
RunLoop.main.run()
