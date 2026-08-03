import Foundation

/// Captures the app's stdout/stderr into a ring buffer by redirecting the file
/// descriptors through pipes (still tee'd back to the originals so normal logging
/// is unaffected). Poll via `read(since:)` with a monotonic cursor.
final class ConsoleCapture {
    static let shared = ConsoleCapture()

    private let lock = NSLock()
    private var entries: [[String: Any]] = []
    private var seq = 0
    private var started = false
    private let maxEntries = 3000

    func start() {
        lock.lock()
        let already = started
        started = true
        lock.unlock()
        guard !already else { return }
        redirect(fd: STDOUT_FILENO, name: "stdout")
        redirect(fd: STDERR_FILENO, name: "stderr")
    }

    private func redirect(fd: Int32, name: String) {
        var fds: [Int32] = [0, 0]
        guard pipe(&fds) == 0 else { return }
        let origin = dup(fd)
        dup2(fds[1], fd)
        close(fds[1])
        let readFD = fds[0]

        Thread.detachNewThread { [weak self] in
            var pending = Data()
            let size = 8192
            var buf = [UInt8](repeating: 0, count: size)
            while true {
                let n = Foundation.read(readFD, &buf, size)
                if n <= 0 { break }
                _ = buf.withUnsafeBytes { Foundation.write(origin, $0.baseAddress, n) } // tee back
                pending.append(contentsOf: buf[0..<n])
                while let idx = pending.firstIndex(of: 0x0A) {
                    let lineData = pending.subdata(in: pending.startIndex..<idx)
                    pending.removeSubrange(pending.startIndex...idx)
                    if let line = String(data: lineData, encoding: .utf8), !line.isEmpty {
                        self?.append(source: name, text: line)
                    }
                }
            }
        }
    }

    private func append(source: String, text: String) {
        lock.lock()
        seq += 1
        entries.append(["n": seq, "source": source, "text": text])
        if entries.count > maxEntries { entries.removeFirst(entries.count - maxEntries) }
        lock.unlock()
    }

    func read(since: Int) -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        let fresh = entries.filter { ($0["n"] as? Int ?? 0) > since }
        return ["status": "ok", "cursor": seq, "count": fresh.count, "lines": Array(fresh.suffix(500))]
    }
}
