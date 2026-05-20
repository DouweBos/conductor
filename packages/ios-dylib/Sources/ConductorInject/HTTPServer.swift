//
// HTTPServer.swift
//
// Minimal zero-dependency HTTP/1.1 server. Bound to 127.0.0.1:<port>.
// Handles one request at a time per connection, which is plenty for an
// in-process automation driver — Conductor only ever has one outstanding
// command in flight per session.
//

import Foundation
import Network

final class HTTPServer {
    typealias Handler = (HTTPRequest) -> HTTPResponse

    private let port: NWEndpoint.Port
    private let queue = DispatchQueue(label: "dev.houwert.conductor-inject.http")
    private var listener: NWListener?
    private var routes: [String: Handler] = [:]

    init(port: UInt16) {
        self.port = NWEndpoint.Port(rawValue: port)!
    }

    func route(_ path: String, _ handler: @escaping Handler) {
        routes[path] = handler
    }

    func start() throws {
        let params = NWParameters.tcp
        // Don't set `acceptLocalOnly = true` — in simulator-host loopback
        // it rejects connections that NW classifies as coming from "another
        // device" (the host curl), which silently breaks the route.
        params.allowLocalEndpointReuse = true
        let listener = try NWListener(using: params, on: port)
        self.listener = listener

        listener.newConnectionHandler = { [weak self] conn in
            self?.handle(connection: conn)
        }
        listener.start(queue: queue)
    }

    private func handle(connection: NWConnection) {
        // Set a state handler before start() so we begin reading as soon as
        // the connection is ready. NWConnection.receive on a non-ready
        // connection silently no-ops in some cases.
        connection.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                self?.readRequest(on: connection, buffer: Data())
            case .failed, .cancelled:
                connection.cancel()
            default:
                break
            }
        }
        connection.start(queue: queue)
    }

    // MARK: - Connection handling

    private func readRequest(on connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, isComplete, error in
            guard let self = self else { return }
            if let error = error {
                _ = error
                connection.cancel()
                return
            }
            var combined = buffer
            if let data = data { combined.append(data) }

            if let req = HTTPRequest.tryParse(from: combined) {
                let response: HTTPResponse
                if let handler = self.routes[req.path] {
                    response = handler(req)
                } else {
                    response = HTTPResponse(status: 404, body: "{\"error\":\"not found\"}")
                }
                self.send(response: response, on: connection)
                return
            }
            if isComplete {
                connection.cancel()
                return
            }
            self.readRequest(on: connection, buffer: combined)
        }
    }

    private func send(response: HTTPResponse, on connection: NWConnection) {
        let data = response.serialize()
        connection.send(content: data, completion: .contentProcessed { _ in
            connection.cancel()
        })
    }
}

// MARK: - HTTP types

struct HTTPRequest {
    let method: String
    let path: String
    let body: Data

    static func tryParse(from data: Data) -> HTTPRequest? {
        guard let headerEndRange = data.range(of: Data("\r\n\r\n".utf8)) else { return nil }
        let headerData = data.subdata(in: 0..<headerEndRange.lowerBound)
        guard let headerText = String(data: headerData, encoding: .utf8) else { return nil }

        let lines = headerText.split(separator: "\r\n", omittingEmptySubsequences: false)
        guard let requestLine = lines.first else { return nil }
        let parts = requestLine.split(separator: " ")
        guard parts.count >= 2 else { return nil }
        let method = String(parts[0])
        let pathWithQuery = String(parts[1])
        let path = pathWithQuery.split(separator: "?", maxSplits: 1).first.map(String.init) ?? pathWithQuery

        var contentLength = 0
        for line in lines.dropFirst() {
            if line.lowercased().hasPrefix("content-length:") {
                let value = line.split(separator: ":", maxSplits: 1).last ?? ""
                contentLength = Int(value.trimmingCharacters(in: .whitespaces)) ?? 0
            }
        }

        let bodyStart = headerEndRange.upperBound
        let available = data.count - bodyStart
        if available < contentLength { return nil }
        let body = data.subdata(in: bodyStart..<(bodyStart + contentLength))
        return HTTPRequest(method: method, path: path, body: body)
    }
}

struct HTTPResponse {
    let status: Int
    let body: String
    var contentType: String = "application/json"

    init(status: Int, body: String = "", contentType: String = "application/json") {
        self.status = status
        self.body = body
        self.contentType = contentType
    }

    static let ok = HTTPResponse(status: 200, body: "{\"ok\":true}")

    static func error(_ message: String, status: Int = 500) -> HTTPResponse {
        let escaped = message.replacingOccurrences(of: "\"", with: "\\\"")
        return HTTPResponse(status: status, body: "{\"error\":\"\(escaped)\"}")
    }

    func serialize() -> Data {
        let bodyData = body.data(using: .utf8) ?? Data()
        var head = "HTTP/1.1 \(status) \(statusText)\r\n"
        head += "Content-Type: \(contentType)\r\n"
        head += "Content-Length: \(bodyData.count)\r\n"
        head += "Connection: close\r\n\r\n"
        var out = head.data(using: .utf8) ?? Data()
        out.append(bodyData)
        return out
    }

    private var statusText: String {
        switch status {
        case 200: return "OK"
        case 400: return "Bad Request"
        case 404: return "Not Found"
        case 500: return "Internal Server Error"
        default: return "Status"
        }
    }
}
