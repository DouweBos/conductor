import Foundation
import Network
import UIKit

/// Minimal in-process control server injected into the target app.
///
/// Phase 0 scope: prove the injection + transport path end-to-end. Speaks plain
/// HTTP/JSON (matching conductor's existing XCUITest driver on :1075) and answers
/// a single `GET /ping`. The port is handed in by the CLI at launch via
/// `CONDUCTOR_INPROC_PORT` so no host↔sandbox port-discovery file is needed;
/// simulator apps share the host loopback, so the CLI reaches 127.0.0.1:<port>.
final class ConductorControlServer {
    static let shared = ConductorControlServer()

    private let queue = DispatchQueue(label: "dev.houwert.conductor.inproc")
    private var listener: NWListener?
    private var started = false

    private init() {}

    // MARK: Lifecycle

    func installLifecycleHook() {
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(appDidFinishLaunching),
            name: UIApplication.didFinishLaunchingNotification,
            object: nil
        )
        // Fallback: if injection happened after didFinishLaunching already fired,
        // the notification never arrives — start on a short delay instead.
        queue.asyncAfter(deadline: .now() + 2) { [weak self] in self?.start() }
    }

    @objc private func appDidFinishLaunching() {
        start()
    }

    // MARK: Server

    func start() {
        queue.async { [weak self] in
            guard let self, !self.started else { return }
            guard let port = self.resolvePort() else {
                NSLog("[conductor-inproc] CONDUCTOR_INPROC_PORT unset — server not started")
                return
            }
            do {
                let params = NWParameters.tcp
                params.allowLocalEndpointReuse = true
                let listener = try NWListener(using: params, on: port)
                listener.newConnectionHandler = { [weak self] conn in self?.handle(conn) }
                listener.stateUpdateHandler = { state in
                    if case .ready = state {
                        NSLog("[conductor-inproc] listening on 127.0.0.1:\(port.rawValue)")
                    }
                    if case let .failed(error) = state {
                        NSLog("[conductor-inproc] listener failed: \(error)")
                    }
                }
                listener.start(queue: self.queue)
                self.listener = listener
                self.started = true
            } catch {
                NSLog("[conductor-inproc] could not bind \(port.rawValue): \(error)")
            }
        }
    }

    private func resolvePort() -> NWEndpoint.Port? {
        guard let raw = ProcessInfo.processInfo.environment["CONDUCTOR_INPROC_PORT"],
              let value = UInt16(raw) else { return nil }
        return NWEndpoint.Port(rawValue: value)
    }

    // MARK: Connection handling

    private func handle(_ conn: NWConnection) {
        conn.start(queue: queue)
        conn.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, _, _ in
            guard let self else { conn.cancel(); return }
            let request = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            self.respond(conn, self.route(self.requestPath(request)))
        }
    }

    /// A response is either JSON or raw bytes (e.g. a PNG screenshot).
    private enum Reply {
        case json([String: Any])
        case binary(Data, contentType: String)
    }

    /// Extract the path from an HTTP request line, e.g. "GET /ping HTTP/1.1".
    private func requestPath(_ request: String) -> String {
        guard let line = request.split(separator: "\r\n", maxSplits: 1, omittingEmptySubsequences: false).first else {
            return "/"
        }
        let parts = line.split(separator: " ")
        return parts.count >= 2 ? String(parts[1]) : "/"
    }

    private func route(_ target: String) -> Reply {
        let (path, query) = splitQuery(target)
        switch path {
        case "/", "/ping":
            return .json([
                "status": "ok",
                "pid": ProcessInfo.processInfo.processIdentifier,
                "app": Bundle.main.bundleIdentifier ?? "unknown",
                "process": ProcessInfo.processInfo.processName,
            ])
        case "/inspect":
            return .json(IntrospectionBridge.inspect(includeHidden: query["hidden"] == "true"))
        case "/snapshots":
            let scale = Double(query["scale"] ?? "1").map { CGFloat($0) } ?? 1
            let maxCount = Int(query["max"] ?? "500") ?? 500
            return .json(IntrospectionBridge.snapshotAll(
                scale: scale, maxCount: maxCount, includeHidden: query["hidden"] == "true"))
        case "/nav":
            return .json(IntrospectionBridge.navigation())
        case "/screenshot":
            guard let png = IntrospectionBridge.screenshot() else {
                return .json(["status": "error", "message": "no key window to capture"])
            }
            return .binary(png, contentType: "image/png")
        case "/image":
            guard let rect = parseFrame(query["frame"]) else {
                return .json(["status": "error", "message": "provide frame=x,y,w,h"])
            }
            guard let png = IntrospectionBridge.renderRegion(rect) else {
                return .json(["status": "error", "message": "could not render region"])
            }
            return .binary(png, contentType: "image/png")
        case "/snapshot":
            let includeSubviews = (query["subviews"] ?? "false") == "true"
            let scale = Double(query["scale"] ?? "1").map { CGFloat($0) } ?? 1
            guard let png = IntrospectionBridge.snapshot(
                id: query["id"] ?? "", includeSubviews: includeSubviews, scale: scale) else {
                return .json(["status": "error", "message": "no view \(query["id"] ?? "") or empty bounds"])
            }
            return .binary(png, contentType: "image/png")
        case "/view":
            return .json(IntrospectionBridge.viewDetail(id: query["id"] ?? ""))
        case "/set":
            return .json(IntrospectionBridge.setProperty(
                id: query["id"] ?? "", key: query["key"] ?? "", value: query["value"] ?? ""))
        case "/constraints":
            return .json(IntrospectionBridge.constraints(id: query["id"] ?? ""))
        case "/props":
            return .json(IntrospectionBridge.props(id: query["id"] ?? ""))
        case "/hittest":
            guard let x = Double(query["x"] ?? ""), let y = Double(query["y"] ?? "") else {
                return .json(["status": "error", "message": "provide x= and y="])
            }
            return .json(IntrospectionBridge.hitTest(x: x, y: y))
        case "/highlight":
            return .json(IntrospectionBridge.highlight(id: query["id"] ?? ""))
        case "/find":
            return .json(IntrospectionBridge.find(className: query["class"], text: query["text"]))
        // Runtime inspection
        case "/get":
            return .json(IntrospectionBridge.getKeyPath(id: query["id"] ?? "", keyPath: query["keyPath"] ?? ""))
        case "/class":
            return .json(IntrospectionBridge.classMeta(id: query["id"] ?? ""))
        case "/responders":
            return .json(IntrospectionBridge.responders(id: query["id"] ?? ""))
        case "/gestures":
            return .json(IntrospectionBridge.gestures(id: query["id"] ?? ""))
        case "/targetactions":
            return .json(IntrospectionBridge.targetActions(id: query["id"] ?? ""))
        // Appearance / animation
        case "/appearance":
            return .json(IntrospectionBridge.setAppearance(query["style"] ?? ""))
        case "/direction":
            return .json(IntrospectionBridge.setLayoutDirection(query["direction"] ?? ""))
        case "/contentsize":
            return .json(IntrospectionBridge.setContentSize(query["category"] ?? ""))
        case "/animspeed":
            return .json(IntrospectionBridge.setAnimationSpeed(Float(query["speed"] ?? "1") ?? 1))
        // SwiftUI
        case "/swiftui":
            return .json(IntrospectionBridge.swiftUITree())
        // Storage
        case "/defaults":
            if let key = query["key"] { return .json(IntrospectionBridge.defaultsSet(key: key, value: query["value"] ?? "")) }
            return .json(IntrospectionBridge.defaultsAll())
        case "/keychain":
            return .json(IntrospectionBridge.keychainAll())
        case "/cookies":
            return .json(IntrospectionBridge.cookiesAll())
        case "/files":
            return .json(IntrospectionBridge.files(path: query["path"]))
        // Heap
        case "/heap/classes":
            return .json(IntrospectionBridge.heapClasses(pattern: query["pattern"] ?? ""))
        case "/heap/instances":
            return .json(IntrospectionBridge.heapInstances(className: query["class"] ?? ""))
        case "/heap/read":
            return .json(IntrospectionBridge.heapRead(address: query["address"] ?? "", keyPath: query["keyPath"]))
        // Interaction / focus / diff
        case "/activate":
            return .json(IntrospectionBridge.activate(id: query["id"] ?? ""))
        case "/focus":
            return .json(IntrospectionBridge.focusState())
        case "/diff/save":
            return .json(IntrospectionBridge.diffSave(name: query["name"] ?? "default"))
        case "/diff/compare":
            return .json(IntrospectionBridge.diffCompare(name: query["name"] ?? "default"))
        // Dynamic Swift eval
        case "/eval":
            return .json(IntrospectionBridge.eval(dylibPath: query["dylib"] ?? ""))
        // Diagnostics streams
        case "/console":
            return .json(ConsoleCapture.shared.read(since: Int(query["since"] ?? "0") ?? 0))
        case "/network":
            return .json(NetworkStore.shared.read(since: Int(query["since"] ?? "0") ?? 0))
        default:
            return .json(["status": "error", "message": "unknown path \(path)"])
        }
    }

    /// Split "/image?frame=1,2,3,4" into ("/image", ["frame": "1,2,3,4"]).
    private func splitQuery(_ target: String) -> (String, [String: String]) {
        let parts = target.split(separator: "?", maxSplits: 1)
        let path = String(parts.first ?? "/")
        var query: [String: String] = [:]
        if parts.count == 2 {
            for pair in parts[1].split(separator: "&") {
                let kv = pair.split(separator: "=", maxSplits: 1)
                if kv.count == 2 {
                    let raw = String(kv[1])
                    query[String(kv[0])] = raw.removingPercentEncoding ?? raw
                }
            }
        }
        return (path, query)
    }

    private func parseFrame(_ value: String?) -> CGRect? {
        guard let nums = value?.split(separator: ",").compactMap({ Double($0) }), nums.count == 4 else {
            return nil
        }
        return CGRect(x: nums[0], y: nums[1], width: nums[2], height: nums[3])
    }

    private func respond(_ conn: NWConnection, _ reply: Reply) {
        let body: Data
        let contentType: String
        switch reply {
        case let .json(dict):
            body = (try? JSONSerialization.data(withJSONObject: dict)) ?? Data("{}".utf8)
            contentType = "application/json"
        case let .binary(data, type):
            body = data
            contentType = type
        }
        var head = "HTTP/1.1 200 OK\r\n"
        head += "Content-Type: \(contentType)\r\n"
        head += "Content-Length: \(body.count)\r\n"
        head += "Connection: close\r\n\r\n"
        var out = Data(head.utf8)
        out.append(body)
        conn.send(content: out, completion: .contentProcessed { _ in conn.cancel() })
    }
}
