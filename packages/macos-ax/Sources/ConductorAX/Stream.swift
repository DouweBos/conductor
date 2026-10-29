import AVFoundation
import CoreMedia
import ScreenCaptureKit
import VideoToolbox

/// Runs an async ScreenCaptureKit call from the (synchronous) HTTP work queue.
func blocking<T>(timeout: Double = 10, _ body: @escaping () async throws -> T) throws -> T {
    let done = DispatchSemaphore(value: 0)
    var result: Result<T, Error> = .failure(DriverError(.timeout, "capture timed out"))
    Task {
        do { result = .success(try await body()) } catch { result = .failure(error) }
        done.signal()
    }
    _ = done.wait(timeout: .now() + timeout)
    return try result.get()
}

/// One ScreenCaptureKit stream of the target window, shared by recording and
/// the live stream. It runs while either is active. Samples arrive on their own
/// queue so a busy encoder never blocks the HTTP handlers.
final class WindowCapture: NSObject, SCStreamOutput, SCStreamDelegate {
    static let shared = WindowCapture()

    /// Longest encoded side, matching the iOS simulator stream.
    static let maxSide: CGFloat = 1920

    private let queue = DispatchQueue(label: "conductor-ax.capture")
    private let lock = NSLock()
    private var stream: SCStream?
    private var config: SCStreamConfiguration?
    private var windowID: CGWindowID?
    private var scale: CGFloat = 2
    private var size = CGSize.zero
    private var recorder: Recorder?
    private var encoder: Encoder?
    private var resizeTimer: DispatchSourceTimer?
    private lazy var server = AnnexBServer { [weak self] in
        // A new client needs SPS/PPS + IDR now, even if the window is static.
        self?.queue.async { self?.encoder?.keyframeNow() }
    }

    // MARK: Routes (HTTP work queue)

    func startRecording(to path: String, target: Target) throws {
        if lock.withLock({ recorder != nil }) { throw DriverError(.precondition, "a recording is already running") }
        try ensureStream(target)
        let rec = try Recorder(url: URL(fileURLWithPath: path), size: size)
        lock.withLock { recorder = rec }
    }

    func stopRecording() throws -> String {
        guard let rec = lock.withLock({ recorder }) else { throw DriverError(.precondition, "no recording is running") }
        // Detach on the sample queue so no append races markAsFinished.
        queue.sync { lock.withLock { recorder = nil } }
        if lock.withLock({ encoder == nil }) { stopStream() }
        return try rec.finish()
    }

    func startStreaming(target: Target) throws -> UInt16 {
        let port = try server.start()
        try ensureStream(target)
        lock.withLock {
            if encoder == nil { encoder = Encoder { [server] data in server.broadcast(data) } }
        }
        return port
    }

    func stopStreaming() {
        queue.sync { lock.withLock { encoder = nil } }
        server.dropClients()
        if lock.withLock({ recorder == nil }) { stopStream() }
    }

    /// Follow a newly focused window. A running recording keeps its window.
    func retarget(_ target: Target) {
        guard lock.withLock({ stream != nil && recorder == nil }), target.windowID != windowID else { return }
        stopStream()
        try? ensureStream(target)
    }

    // MARK: Stream lifecycle

    private func ensureStream(_ target: Target) throws {
        guard let id = target.windowID else {
            throw DriverError(.precondition, "\(target.bundleId) has no window on screen")
        }
        if lock.withLock({ self.stream != nil && self.windowID == id }) { return }
        stopStream()
        let (filter, window) = try blocking { () -> (SCContentFilter, SCWindow) in
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            guard let window = content.windows.first(where: { $0.windowID == id }) else {
                throw DriverError("window \(id) is no longer available")
            }
            return (SCContentFilter(desktopIndependentWindow: window), window)
        }
        scale = CGFloat(filter.pointPixelScale)
        size = pixels(window.frame.size)
        let config = SCStreamConfiguration()
        config.width = Int(size.width)
        config.height = Int(size.height)
        config.minimumFrameInterval = CMTime(value: 1, timescale: 30)
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.queueDepth = 5
        config.showsCursor = false
        config.scalesToFit = true
        if #available(macOS 14.2, *) { config.ignoreShadowsSingleWindow = true }
        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        do {
            try blocking { try await stream.startCapture() }
        } catch {
            throw DriverError("capture failed (\(error.localizedDescription)) — allow ConductorAX in System Settings ▸ "
                + "Privacy & Security ▸ Screen & System Audio Recording, then restart the driver")
        }
        lock.withLock {
            self.stream = stream
            self.config = config
            windowID = id
        }
        startResizeWatch()
    }

    private func stopStream() {
        resizeTimer?.cancel()
        resizeTimer = nil
        guard let stream = lock.withLock({ () -> SCStream? in
            defer { self.stream = nil; windowID = nil }
            return self.stream
        }) else { return }
        _ = try? blocking { try await stream.stopCapture() }
    }

    /// Even pixel dimensions for a window size, capped at `maxSide`.
    private func pixels(_ points: CGSize) -> CGSize {
        var w = points.width * scale, h = points.height * scale
        let longest = max(w, h)
        if longest > Self.maxSide {
            w *= Self.maxSide / longest
            h *= Self.maxSide / longest
        }
        return CGSize(width: max(2, Int(w) & ~1), height: max(2, Int(h) & ~1))
    }

    /// Window resizes change the stream's size. A recording can't change size
    /// mid-file, so it stays put and SCK letterboxes into it.
    private func startResizeWatch() {
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 0.5, repeating: 0.5)
        timer.setEventHandler { [weak self] in self?.checkResize() }
        timer.resume()
        resizeTimer = timer
    }

    private func checkResize() {
        guard let (stream, config, id) = lock.withLock({ () -> (SCStream, SCStreamConfiguration, CGWindowID)? in
            guard recorder == nil, let stream, let config, let windowID else { return nil }
            return (stream, config, windowID)
        }) else { return }
        guard let info = (CGWindowListCopyWindowInfo(.optionIncludingWindow, id) as? [[String: Any]])?.first,
              let dict = info[kCGWindowBounds as String] as? NSDictionary,
              let bounds = CGRect(dictionaryRepresentation: dict) else { return }
        let next = pixels(bounds.size)
        guard abs(next.width - size.width) >= 2 || abs(next.height - size.height) >= 2 else { return }
        size = next
        config.width = Int(next.width)
        config.height = Int(next.height)
        stream.updateConfiguration(config) { _ in }
    }

    // MARK: SCStreamOutput / SCStreamDelegate (capture queue)

    func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sample.isValid, let pixels = sample.imageBuffer,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false)
                as? [[SCStreamFrameInfo: Any]],
              let raw = attachments.first?[.status] as? Int, SCFrameStatus(rawValue: raw) == .complete
        else { return }
        let (rec, enc) = lock.withLock { (recorder, encoder) }
        rec?.append(sample)
        enc?.encode(pixels, at: sample.presentationTimeStamp)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        FileHandle.standardError.write("capture stopped: \(error.localizedDescription)\n".data(using: .utf8)!)
        lock.withLock {
            if self.stream === stream { self.stream = nil; windowID = nil }
        }
        // The daemon reconnects with backoff and restarts on the current window.
        server.dropClients()
    }
}

/// Writes the capture to an H.264 .mp4.
final class Recorder {
    private let writer: AVAssetWriter
    private let input: AVAssetWriterInput
    private var lastTime: CMTime?

    init(url: URL, size: CGSize) throws {
        try? FileManager.default.removeItem(at: url)
        writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: Int(size.width),
            AVVideoHeightKey: Int(size.height),
        ])
        input.expectsMediaDataInRealTime = true
        guard writer.canAdd(input) else { throw DriverError("cannot record at \(Int(size.width))x\(Int(size.height))") }
        writer.add(input)
        guard writer.startWriting() else {
            throw DriverError("could not start recording: \(writer.error?.localizedDescription ?? "unknown error")")
        }
    }

    func append(_ sample: CMSampleBuffer) {
        let time = sample.presentationTimeStamp
        if lastTime == nil { writer.startSession(atSourceTime: time) }
        guard input.isReadyForMoreMediaData, input.append(sample) else { return }
        lastTime = time
    }

    func finish() throws -> String {
        guard let lastTime else {
            writer.cancelWriting()
            throw DriverError("no frames were captured")
        }
        // SCK only delivers frames on change; run the file up to the stop time.
        let now = CMClockGetTime(CMClockGetHostTimeClock())
        writer.endSession(atSourceTime: CMTimeMaximum(now, lastTime))
        input.markAsFinished()
        let done = DispatchSemaphore(value: 0)
        writer.finishWriting { done.signal() }
        _ = done.wait(timeout: .now() + 30)
        guard writer.status == .completed else {
            throw DriverError("recording failed: \(writer.error?.localizedDescription ?? "did not finish")")
        }
        return writer.outputURL.path
    }
}

/// VideoToolbox H.264 encoder emitting Annex B access units. Settings mirror
/// packages/ios-capture: Main, realtime, no reordering, quality VBR, 1s GOP.
final class Encoder {
    private static let startCode: [UInt8] = [0, 0, 0, 1]
    private var session: VTCompressionSession?
    private var width = 0, height = 0
    private var last: CVPixelBuffer?
    private let output: (Data) -> Void

    init(output: @escaping (Data) -> Void) {
        self.output = output
    }

    deinit {
        if let session { VTCompressionSessionInvalidate(session) }
    }

    func encode(_ pixels: CVPixelBuffer, at time: CMTime, forceKeyframe: Bool = false) {
        last = pixels
        let w = CVPixelBufferGetWidth(pixels), h = CVPixelBufferGetHeight(pixels)
        if session == nil || w != width || h != height {
            guard makeSession(w, h) else { return }
        }
        guard let session else { return }
        let props = forceKeyframe ? [kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue] as CFDictionary : nil
        VTCompressionSessionEncodeFrame(session, imageBuffer: pixels, presentationTimeStamp: time,
                                        duration: .invalid, frameProperties: props, infoFlagsOut: nil) {
            [output] status, _, sample in
            guard status == noErr, let sample, let data = Self.annexB(sample) else { return }
            output(data)
        }
    }

    /// Re-encode the last frame as a keyframe; a static window sends no new ones.
    func keyframeNow() {
        guard let last else { return }
        encode(last, at: CMClockGetTime(CMClockGetHostTimeClock()), forceKeyframe: true)
    }

    private func makeSession(_ w: Int, _ h: Int) -> Bool {
        if let session { VTCompressionSessionInvalidate(session) }
        session = nil
        var created: VTCompressionSession?
        guard VTCompressionSessionCreate(allocator: nil, width: Int32(w), height: Int32(h),
                                         codecType: kCMVideoCodecType_H264, encoderSpecification: nil,
                                         imageBufferAttributes: nil, compressedDataAllocator: nil,
                                         outputCallback: nil, refcon: nil, compressionSessionOut: &created) == noErr,
              let created else { return false }
        VTSessionSetProperty(created, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        VTSessionSetProperty(created, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
        VTSessionSetProperty(created, key: kVTCompressionPropertyKey_ProfileLevel,
                             value: kVTProfileLevel_H264_Main_AutoLevel)
        // Below 1.0, or VideoToolbox emits 4:4:4 that WebCodecs can't decode.
        VTSessionSetProperty(created, key: kVTCompressionPropertyKey_Quality, value: 0.8 as CFNumber)
        VTSessionSetProperty(created, key: kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, value: 1.0 as CFNumber)
        VTSessionSetProperty(created, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: 30 as CFNumber)
        VTCompressionSessionPrepareToEncodeFrames(created)
        session = created
        width = w
        height = h
        return true
    }

    /// AVCC sample → Annex B, with SPS/PPS ahead of every keyframe.
    private static func annexB(_ sample: CMSampleBuffer) -> Data? {
        guard CMSampleBufferDataIsReady(sample), let block = CMSampleBufferGetDataBuffer(sample) else { return nil }
        var out = Data()
        let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[CFString: Any]]
        let keyframe = attachments?.first?[kCMSampleAttachmentKey_NotSync] == nil
        if keyframe, let format = CMSampleBufferGetFormatDescription(sample) {
            var count = 0
            CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: 0, parameterSetPointerOut: nil,
                                                               parameterSetSizeOut: nil, parameterSetCountOut: &count,
                                                               nalUnitHeaderLengthOut: nil)
            for i in 0..<count {
                var ptr: UnsafePointer<UInt8>?
                var len = 0
                if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: i,
                                                                      parameterSetPointerOut: &ptr,
                                                                      parameterSetSizeOut: &len,
                                                                      parameterSetCountOut: nil,
                                                                      nalUnitHeaderLengthOut: nil) == noErr, let ptr {
                    out.append(contentsOf: startCode)
                    out.append(ptr, count: len)
                }
            }
        }
        var total = 0
        var base: UnsafeMutablePointer<CChar>?
        guard CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &total,
                                          dataPointerOut: &base) == noErr, let base else { return nil }
        let bytes = UnsafeRawPointer(base).assumingMemoryBound(to: UInt8.self)
        var offset = 0
        while offset + 4 <= total {
            let len = Int(bytes[offset]) << 24 | Int(bytes[offset + 1]) << 16 | Int(bytes[offset + 2]) << 8
                | Int(bytes[offset + 3])
            offset += 4
            guard offset + len <= total else { break }
            out.append(contentsOf: startCode)
            out.append(bytes + offset, count: len)
            offset += len
        }
        return out.isEmpty ? nil : out
    }
}

/// Loopback TCP server carrying the raw Annex B stream, as packages/ios-capture
/// does. The daemon connects and parses it; there's no framing beyond start codes.
final class AnnexBServer {
    private let lock = NSLock()
    private var clients: [Int32] = []
    private var port: UInt16?
    private let onClient: () -> Void

    init(onClient: @escaping () -> Void) {
        self.onClient = onClient
    }

    func start() throws -> UInt16 {
        if let port = lock.withLock({ self.port }) { return port }
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { throw DriverError("stream socket() failed") }
        var one: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, socklen_t(MemoryLayout<Int32>.size))
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_addr.s_addr = INADDR_LOOPBACK.bigEndian
        let bound = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        guard bound == 0, listen(fd, 8) == 0 else {
            close(fd)
            throw DriverError("stream server could not listen")
        }
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        withUnsafeMutablePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { _ = getsockname(fd, $0, &len) }
        }
        let port = UInt16(bigEndian: addr.sin_port)
        lock.withLock { self.port = port }
        Thread.detachNewThread { [weak self] in
            while true {
                let client = accept(fd, nil, nil)
                guard client >= 0, let self else { break }
                var one: Int32 = 1
                setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
                self.lock.withLock { self.clients.append(client) }
                self.onClient()
            }
        }
        return port
    }

    func broadcast(_ data: Data) {
        let snapshot = lock.withLock { clients }
        let dead = snapshot.filter { !Self.writeAll($0, data) }
        guard !dead.isEmpty else { return }
        lock.withLock { clients.removeAll(where: dead.contains) }
        dead.forEach { close($0) }
    }

    func dropClients() {
        let all = lock.withLock { () -> [Int32] in
            defer { clients = [] }
            return clients
        }
        all.forEach { close($0) }
    }

    private static func writeAll(_ fd: Int32, _ data: Data) -> Bool {
        data.withUnsafeBytes { raw in
            guard var ptr = raw.baseAddress else { return true }
            var left = raw.count
            while left > 0 {
                let n = write(fd, ptr, left)
                if n <= 0 { return false }
                ptr += n
                left -= n
            }
            return true
        }
    }
}
