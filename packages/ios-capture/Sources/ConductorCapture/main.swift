// main.swift — newline-delimited JSON-over-stdio loop plus a raw H.264 Annex B
// TCP stream server. conductor's daemon spawns this host binary, sends
// start_capture, then connects to the reported localhost port and fans the
// elementary stream out to WebSocket subscribers.
//
// Requests:
//   {"cmd":"ping"}                              → {"ok":true}
//   {"cmd":"start_capture","udid":"<UDID>"}     → {"ok":true,"port":<uint16>}
//   {"cmd":"stop_capture"}                      → {"ok":true}
// Ported from Argus's argus-sim-bridge (main.swift), capture commands only.
import Foundation

// SIGPIPE would kill us when we write to a stream socket the client has closed
// (e.g. a mirror window closed). writeAll handles EPIPE and drops the client.
signal(SIGPIPE, SIG_IGN)

// ---------------------------------------------------------------------------
// MARK: - Raw H.264 TCP server
// ---------------------------------------------------------------------------

/// Tracks connected streaming clients and fans out encoded H.264 Annex B chunks
/// to each of them in order. There are no HTTP headers — each client receives
/// the raw elementary byte stream, which the Node side parses with
/// H264AccessUnitParser.
private final class StreamHub {
    private var clients: [Int32] = []
    private let lock = NSLock()

    func addClient(_ fd: Int32) {
        lock.lock()
        clients.append(fd)
        lock.unlock()
        // A new subscriber needs a keyframe (SPS/PPS + IDR) to start decoding.
        SHRequestKeyframe()
    }

    /// Write one encoded chunk to every connected client, in order. Clients
    /// whose socket write fails (closed/broken connection) are dropped.
    func broadcast(_ data: Data) {
        lock.lock()
        let snapshot = clients
        lock.unlock()
        if snapshot.isEmpty { return }

        var dead: [Int32] = []
        for fd in snapshot where !writeAll(fd, data) {
            dead.append(fd)
        }
        if !dead.isEmpty {
            lock.lock()
            clients.removeAll { dead.contains($0) }
            lock.unlock()
            for fd in dead { close(fd) }
        }
    }
}

private let streamHub = StreamHub()

/// C-callable frame callback invoked by csStartFramebuffer at ~30fps with H.264
/// Annex B chunks (one access unit per call).
private let frameCallback: @convention(c) (UnsafePointer<UInt8>, UInt) -> Void = {
    ptr, len in
    let bytes = Data(bytes: ptr, count: Int(len))
    streamHub.broadcast(bytes)
}

/// Write all bytes to a file descriptor, handling short writes.
private func writeAll(_ fd: Int32, _ data: Data) -> Bool {
    var remaining = data
    while !remaining.isEmpty {
        let written = remaining.withUnsafeBytes { ptr -> Int in
            guard let base = ptr.baseAddress else { return -1 }
            return write(fd, base, ptr.count)
        }
        if written <= 0 { return false }
        remaining = remaining.dropFirst(written)
    }
    return true
}

/// Bind a TCP listener on an ephemeral loopback port, start accepting raw H.264
/// stream clients, and return the bound port number.
private func startStreamServer() throws -> UInt16 {
    let serverFd = socket(AF_INET, SOCK_STREAM, 0)
    guard serverFd >= 0 else {
        throw NSError(domain: "Capture", code: 1,
                      userInfo: [NSLocalizedDescriptionKey: "socket() failed"])
    }

    var opt: Int32 = 1
    setsockopt(serverFd, SOL_SOCKET, SO_REUSEADDR, &opt, socklen_t(MemoryLayout<Int32>.size))

    var addr = sockaddr_in()
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = 0  // let OS pick a port
    // Bind to loopback only — this is a localhost-only stream the daemon reads.
    addr.sin_addr.s_addr = INADDR_LOOPBACK.bigEndian

    let bindResult = withUnsafePointer(to: &addr) { ptr -> Int32 in
        ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
            bind(serverFd, sockPtr, socklen_t(MemoryLayout<sockaddr_in>.size))
        }
    }
    guard bindResult == 0 else {
        close(serverFd)
        throw NSError(domain: "Capture", code: 2,
                      userInfo: [NSLocalizedDescriptionKey: "bind() failed"])
    }

    guard listen(serverFd, 8) == 0 else {
        close(serverFd)
        throw NSError(domain: "Capture", code: 3,
                      userInfo: [NSLocalizedDescriptionKey: "listen() failed"])
    }

    // Read back the assigned port
    var boundAddr = sockaddr_in()
    var addrLen = socklen_t(MemoryLayout<sockaddr_in>.size)
    withUnsafeMutablePointer(to: &boundAddr) { ptr in
        ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
            _ = getsockname(serverFd, sockPtr, &addrLen)
        }
    }
    let port = UInt16(bigEndian: boundAddr.sin_port)

    // Accept clients in a background thread. The stream hub fans encoded frames
    // out to every connected client from the encoder callback, so no per-client
    // serving thread is needed.
    Thread.detachNewThread {
        while true {
            let clientFd = accept(serverFd, nil, nil)
            guard clientFd >= 0 else { break }
            streamHub.addClient(clientFd)
        }
        close(serverFd)
    }

    return port
}

// ---------------------------------------------------------------------------
// MARK: - JSON I/O helpers
// ---------------------------------------------------------------------------

private func writeResponse(_ dict: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: dict),
          let line = String(data: data, encoding: .utf8) else {
        print("{\"ok\":false,\"error\":\"failed to serialize response\"}")
        fflush(stdout)
        return
    }
    print(line)
    fflush(stdout)
}

private func respond(ok: Bool, extras: [String: Any] = [:]) {
    var dict: [String: Any] = ["ok": ok]
    for (k, v) in extras { dict[k] = v }
    writeResponse(dict)
}

private func respondError(_ message: String) {
    writeResponse(["ok": false, "error": message])
}

// ---------------------------------------------------------------------------
// MARK: - Command dispatch
// ---------------------------------------------------------------------------

private func dispatch(_ obj: [String: Any]) {
    guard let cmd = obj["cmd"] as? String else {
        respondError("missing 'cmd' field")
        return
    }

    switch cmd {
    case "ping":
        respond(ok: true)

    // start_capture — start IOSurface framebuffer capture + H.264 server
    case "start_capture":
        guard let udid = obj["udid"] as? String else {
            respondError("start_capture: missing 'udid'")
            return
        }
        // Start the raw H.264 TCP server first so we have a port to report.
        let port: UInt16
        do {
            port = try startStreamServer()
        } catch {
            respondError("start_capture: failed to start stream server: \(error)")
            return
        }
        let rc = udid.withCString { csStartFramebuffer($0, frameCallback) }
        guard rc == 0 else {
            respondError("start_capture: csStartFramebuffer returned \(rc)")
            return
        }
        respond(ok: true, extras: ["port": Int(port)])

    // stop_capture — stop IOSurface framebuffer capture
    case "stop_capture":
        csStopFramebuffer()
        respond(ok: true)

    default:
        respondError("unknown command '\(cmd)'")
    }
}

// ---------------------------------------------------------------------------
// MARK: - Main loop
// ---------------------------------------------------------------------------

// Read stdin line by line — blocking read, no run-loop needed.
while let line = readLine(strippingNewline: true) {
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    guard !trimmed.isEmpty else { continue }

    guard let data = trimmed.data(using: .utf8),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        respondError("invalid JSON")
        continue
    }

    dispatch(obj)
}
