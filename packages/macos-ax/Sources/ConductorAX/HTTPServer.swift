import Foundation
import Network

struct HTTPRequest {
    let method: String
    let path: String
    let query: [String: String]
    let body: Data
}

struct HTTPResponse {
    var status: Int = 200
    var contentType = "application/json"
    var body = Data()

    static func json(_ object: Any, status: Int = 200) -> HTTPResponse {
        let data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data()
        return HTTPResponse(status: status, body: data)
    }

    static let ok = HTTPResponse()
}

/// Mirrors the XCUITest driver's error body so the CLI reports both the same way.
struct DriverError: Error {
    enum Kind: String { case `internal`, precondition, timeout }
    let kind: Kind
    let message: String

    init(_ kind: Kind, _ message: String) {
        self.kind = kind
        self.message = message
    }

    init(_ message: String) {
        self.init(.internal, message)
    }

    var response: HTTPResponse {
        let status = kind == .precondition ? 400 : kind == .timeout ? 408 : 500
        return .json(["code": kind.rawValue, "errorMessage": message], status: status)
    }
}

/// Minimal loopback HTTP/1.1 server: one request per connection, closed after
/// the response. Requests are handled one at a time — AX calls aren't reentrant.
final class HTTPServer {
    private let listener: NWListener
    private let ioQueue = DispatchQueue(label: "conductor-ax.io")
    private let workQueue = DispatchQueue(label: "conductor-ax.work")
    private let handler: (HTTPRequest) -> HTTPResponse

    init(port: UInt16, handler: @escaping (HTTPRequest) -> HTTPResponse) throws {
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!)
        params.allowLocalEndpointReuse = true
        listener = try NWListener(using: params)
        self.handler = handler
    }

    func start() {
        listener.newConnectionHandler = { [weak self] conn in self?.accept(conn) }
        listener.stateUpdateHandler = { state in
            if case .failed(let error) = state {
                FileHandle.standardError.write("listener failed: \(error)\n".data(using: .utf8)!)
                exit(1)
            }
        }
        listener.start(queue: ioQueue)
    }

    private func accept(_ conn: NWConnection) {
        conn.start(queue: ioQueue)
        receive(conn, buffer: Data())
    }

    private func receive(_ conn: NWConnection, buffer: Data) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [weak self] data, _, done, error in
            guard let self else { return }
            var buffer = buffer
            if let data { buffer.append(data) }
            if let request = Self.parse(buffer) {
                self.workQueue.async {
                    let response = self.handler(request)
                    self.send(response, on: conn)
                }
            } else if done || error != nil {
                conn.cancel()
            } else {
                self.receive(conn, buffer: buffer)
            }
        }
    }

    private func send(_ response: HTTPResponse, on conn: NWConnection) {
        let reason = [200: "OK", 400: "Bad Request", 404: "Not Found", 408: "Request Timeout"][response.status]
            ?? "Internal Server Error"
        var head = "HTTP/1.1 \(response.status) \(reason)\r\n"
        head += "Content-Type: \(response.contentType)\r\n"
        head += "Content-Length: \(response.body.count)\r\n"
        head += "Connection: close\r\n\r\n"
        var out = Data(head.utf8)
        out.append(response.body)
        conn.send(content: out, completion: .contentProcessed { _ in conn.cancel() })
    }

    /// Returns a request once the headers and the full Content-Length body are in.
    private static func parse(_ data: Data) -> HTTPRequest? {
        guard let headerEnd = data.range(of: Data("\r\n\r\n".utf8)) else { return nil }
        guard let head = String(data: data[..<headerEnd.lowerBound], encoding: .utf8) else { return nil }
        let lines = head.components(separatedBy: "\r\n")
        let parts = lines.first?.split(separator: " ") ?? []
        guard parts.count >= 2 else { return nil }
        var length = 0
        for line in lines.dropFirst() {
            let kv = line.split(separator: ":", maxSplits: 1)
            if kv.count == 2, kv[0].trimmingCharacters(in: .whitespaces).lowercased() == "content-length" {
                length = Int(kv[1].trimmingCharacters(in: .whitespaces)) ?? 0
            }
        }
        let body = data[headerEnd.upperBound...]
        guard body.count >= length else { return nil }
        let target = String(parts[1])
        let comps = URLComponents(string: target)
        var query: [String: String] = [:]
        for item in comps?.queryItems ?? [] { query[item.name] = item.value ?? "" }
        let path = (comps?.path ?? target).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return HTTPRequest(method: String(parts[0]), path: path, query: query, body: Data(body.prefix(length)))
    }
}
