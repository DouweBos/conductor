import Foundation
import ObjectiveC.runtime

/// HTTP capture. A pass-through `URLProtocol` records every request/response into
/// a ring buffer; installed both via `registerClass` (URLSession.shared) and by
/// swizzling the private config class's `protocolClasses` getter so sessions made
/// with `.default`/`.ephemeral` configs are covered too.
final class NetworkStore {
    static let shared = NetworkStore()
    private let lock = NSLock()
    private var records: [[String: Any]] = []
    private var seq = 0
    private let maxRecords = 1000

    func add(_ record: [String: Any]) {
        lock.lock()
        seq += 1
        var r = record
        r["n"] = seq
        records.append(r)
        if records.count > maxRecords { records.removeFirst(records.count - maxRecords) }
        lock.unlock()
    }

    func read(since: Int) -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        let fresh = records.filter { ($0["n"] as? Int ?? 0) > since }
        return ["status": "ok", "cursor": seq, "count": fresh.count, "requests": Array(fresh.suffix(200))]
    }
}

final class NetworkCapture: URLProtocol, URLSessionDataDelegate {
    private static let handledKey = "ConductorNetworkHandled"
    private var proxySession: URLSession?
    private var proxyTask: URLSessionDataTask?
    private var bodyBytes = 0
    private var startedAt = Date()
    private var record: [String: Any] = [:]

    static func install() {
        URLProtocol.registerClass(NetworkCapture.self)
        swizzleConfig()
    }

    private static func swizzleConfig() {
        let config = URLSessionConfiguration.default
        guard let cls = object_getClass(config) else { return }
        let selector = #selector(getter: URLSessionConfiguration.protocolClasses)
        guard let method = class_getInstanceMethod(cls, selector) else { return }
        typealias Getter = @convention(c) (AnyObject, Selector) -> [AnyClass]?
        let original = unsafeBitCast(method_getImplementation(method), to: Getter.self)
        let block: @convention(block) (AnyObject) -> [AnyClass]? = { obj in
            let existing = original(obj, selector) ?? []
            return [NetworkCapture.self] + existing.filter { $0 != NetworkCapture.self }
        }
        method_setImplementation(method, imp_implementationWithBlock(block))
    }

    override class func canInit(with request: URLRequest) -> Bool {
        if URLProtocol.property(forKey: handledKey, in: request) != nil { return false }
        let scheme = request.url?.scheme?.lowercased()
        return scheme == "http" || scheme == "https"
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        startedAt = Date()
        record = [
            "method": request.httpMethod ?? "GET",
            "url": request.url?.absoluteString ?? "",
            "requestHeaders": request.allHTTPHeaderFields ?? [:],
            "requestBodyBytes": request.httpBody?.count ?? 0,
        ]
        guard let mutable = (request as NSURLRequest).mutableCopy() as? NSMutableURLRequest else {
            client?.urlProtocol(self, didFailWithError: URLError(.unknown)); return
        }
        URLProtocol.setProperty(true, forKey: NetworkCapture.handledKey, in: mutable)
        proxySession = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
        proxyTask = proxySession?.dataTask(with: mutable as URLRequest)
        proxyTask?.resume()
    }

    override func stopLoading() {
        proxyTask?.cancel()
        proxySession?.invalidateAndCancel()
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask,
                    didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        if let http = response as? HTTPURLResponse {
            record["status"] = http.statusCode
            record["responseHeaders"] = http.allHeaderFields.reduce(into: [String: String]()) {
                if let k = $1.key as? String { $0[k] = String(describing: $1.value) }
            }
        }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        client?.urlProtocol(self, didLoad: data)
        bodyBytes += data.count
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error {
            client?.urlProtocol(self, didFailWithError: error)
            record["error"] = error.localizedDescription
        } else {
            client?.urlProtocolDidFinishLoading(self)
        }
        record["responseBodyBytes"] = bodyBytes
        record["durationMs"] = Int(Date().timeIntervalSince(startedAt) * 1000)
        NetworkStore.shared.add(record)
    }
}
