import FlyingFox
import XCTest
import os
import ConductorDriverLib

@MainActor
struct ViewHierarchyHandler: HTTPHandler {

    #if os(tvOS)
    private static let homescreenBundleId = "com.apple.HeadBoard"
    #else
    private static let homescreenBundleId = "com.apple.springboard"
    #endif
    private let homescreenApplication = XCUIApplication(bundleIdentifier: ViewHierarchyHandler.homescreenBundleId)
    private let snapshotMaxDepth = 60

    private let logger = Logger(
        subsystem: Bundle.main.bundleIdentifier!,
        category: String(describing: Self.self)
    )

    func handleRequest(_ request: FlyingFox.HTTPRequest) async throws -> HTTPResponse {
        guard let requestBody = try? await JSONDecoder().decode(ViewHierarchyRequest.self, from: request.bodyData) else {
            return AppError(type: .precondition, message: "incorrect request body provided").httpResponse
        }

        do {
            let foregroundApp = RunningApp.getForegroundApp()
            guard let foregroundApp = foregroundApp else {
                NSLog("No foreground app found returning homescreen app hierarchy")
                let homescreenHierarchy = try elementHierarchy(xcuiElement: homescreenApplication)
                let homescreenViewHierarchy = ViewHierarchy.init(axElement: homescreenHierarchy, depth: homescreenHierarchy.depth())
                let body = try JSONEncoder().encode(homescreenViewHierarchy)
                return HTTPResponse(statusCode: .ok, body: body)
            }
            NSLog("[Start] View hierarchy snapshot for \(foregroundApp)")
            let appViewHierarchy = try await getAppViewHierarchy(foregroundApp: foregroundApp, excludeKeyboardElements: requestBody.excludeKeyboardElements)
            let viewHierarchy = ViewHierarchy.init(axElement: appViewHierarchy, depth: appViewHierarchy.depth())
            
            NSLog("[Done] View hierarchy snapshot for \(foregroundApp) ")
            let body = try JSONEncoder().encode(viewHierarchy)
            return HTTPResponse(statusCode: .ok, body: body)
        } catch let error as AppError {
            NSLog("AppError in handleRequest, Error:\(error)");
            return error.httpResponse
        } catch let error {
            NSLog("Error in handleRequest, Error:\(error)");
            return AppError(message: "Snapshot failure while getting view hierarchy. Error: \(error.localizedDescription)").httpResponse
        }
    }

    func getAppViewHierarchy(foregroundApp: XCUIApplication, excludeKeyboardElements: Bool) async throws -> AXElement {
        let appHierarchy = try getHierarchyWithFallback(foregroundApp)
        await SystemPermissionHelper.handleSystemPermissionAlertIfNeeded(appHierarchy: appHierarchy, foregroundApp: foregroundApp)
                
        let statusBars = logger.measure(message: "Fetch status bar hierarchy") {
            fullStatusBars(homescreenApplication)
        } ?? []

        // Fetch Safari WebView hierarchy for iOS 26+ (runs in separate SafariViewService process). Skip on tvOS.
        #if os(tvOS)
        let safariWebViewHierarchy: AXElement? = nil
        #else
        let safariWebViewHierarchy: AXElement? = logger.measure(message: "Fetch Safari WebView hierarchy") {
            getSafariWebViewHierarchy()
        }
        #endif

        // In windowed modes (iPadOS Stage Manager, Slide Over) the foreground
        // app's snapshot hierarchy reports frames in window-local coordinates
        // (root at 0,0) while the screenshot alongside is full-device.
        // `XCUIApplication.frame` and `attributesForElement:` both resolve
        // through the same window-local path. SpringBoard, however, is always
        // fullscreen, so its own snapshot contains the windowed app as a
        // descendant element whose frame IS in screen space. Match that
        // descendant by its dimensions (unique enough per window) and take
        // its origin.
        let appFrame = appHierarchy.frame
        let appWidth = appFrame["Width"] ?? 0
        let appHeight = appFrame["Height"] ?? 0
        var windowOriginX: Double = 0
        var windowOriginY: Double = 0
        if appWidth > 0, appHeight > 0 {
            if let origin = findWindowOriginInSpringBoard(width: appWidth, height: appHeight) {
                windowOriginX = origin.x
                windowOriginY = origin.y
            }
        }
        NSLog("Resolved windowOrigin=(\(windowOriginX),\(windowOriginY)) for appSize=(\(appWidth),\(appHeight))")

        let appHierarchyForResponse: AXElement
        if windowOriginX != 0 || windowOriginY != 0 {
            let offset = WindowOffset(offsetX: windowOriginX, offsetY: windowOriginY)
            // The app's root reports its window-local size, which becomes the
            // window's screen-space bounds once translated. Elements whose
            // translated frame falls entirely outside that bound are clipped
            // by the window compositor and not interactable, so drop them —
            // this keeps `tap-on` honest and stops consumers from drawing
            // outlines on bits of the app that live off-window.
            let windowRect = CGRect(x: windowOriginX, y: windowOriginY,
                                    width: appWidth, height: appHeight)
            NSLog("Translating windowed app frames by \(offset); clipping to \(windowRect)")
            appHierarchyForResponse = translateFrames(appHierarchy, offset: offset, clipTo: windowRect)
        } else {
            appHierarchyForResponse = appHierarchy
        }

        return AXElement(children: [appHierarchyForResponse, AXElement(children: statusBars), safariWebViewHierarchy].compactMap { $0 })
    }

    /// Walks the SpringBoard (shell) snapshot hierarchy looking for a
    /// descendant element whose size matches the foreground app's window
    /// size. Returns the screen-space origin of that descendant.
    ///
    /// SpringBoard is always fullscreen, so every descendant's frame is in
    /// full-device screen coordinates — this is what we need to translate
    /// the foreground app's window-local snapshot frames back into screen
    /// space for iPadOS Stage Manager / Slide Over.
    private func findWindowOriginInSpringBoard(width: Double, height: Double) -> CGPoint? {
        do {
            let sb = try elementHierarchy(xcuiElement: homescreenApplication)
            let tolerance = 0.5
            var found: CGPoint?
            func walk(_ el: AXElement) {
                if found != nil { return }
                let w = el.frame["Width"] ?? 0
                let h = el.frame["Height"] ?? 0
                if abs(w - width) < tolerance, abs(h - height) < tolerance {
                    let x = el.frame["X"] ?? 0
                    let y = el.frame["Y"] ?? 0
                    // Treat (0,0) as "no useful offset" — same as fullscreen.
                    if x != 0 || y != 0 {
                        found = CGPoint(x: x, y: y)
                        return
                    }
                }
                for c in el.children ?? [] {
                    walk(c)
                    if found != nil { return }
                }
            }
            walk(sb)
            return found
        } catch {
            NSLog("findWindowOriginInSpringBoard: snapshot failed \(error)")
            return nil
        }
    }

    /// Recursively add `offset` to every element's frame origin, dropping
    /// any subtree whose translated frame lies entirely outside `clipTo`.
    /// Used to lift window-local snapshot frames into full-device screen
    /// space when the foreground app runs windowed, while trimming elements
    /// the window compositor clips (scrolled-off list items, sibling
    /// containers the app keeps measured but not visible, etc).
    func translateFrames(_ element: AXElement, offset: WindowOffset, clipTo windowRect: CGRect) -> AXElement {
        let tx = (element.frame["X"] ?? 0) + offset.offsetX
        let ty = (element.frame["Y"] ?? 0) + offset.offsetY
        let tw = element.frame["Width"] ?? 0
        let th = element.frame["Height"] ?? 0
        let translatedFrame: AXFrame = [
            "X": tx,
            "Y": ty,
            "Width": tw,
            "Height": th,
        ]
        let translatedChildren = (element.children ?? [])
            .compactMap { child -> AXElement? in
                let cx = (child.frame["X"] ?? 0) + offset.offsetX
                let cy = (child.frame["Y"] ?? 0) + offset.offsetY
                let cw = child.frame["Width"] ?? 0
                let ch = child.frame["Height"] ?? 0
                // Preserve zero-size elements (invisible layout anchors can
                // still matter for hit-testing siblings) — only drop
                // explicitly-sized rects whose screen-space bounds miss the
                // window entirely.
                if cw > 0, ch > 0 {
                    let childRect = CGRect(x: cx, y: cy, width: cw, height: ch)
                    if !windowRect.intersects(childRect) {
                        return nil
                    }
                }
                return translateFrames(child, offset: offset, clipTo: windowRect)
            }

        return AXElement(
            identifier: element.identifier,
            frame: translatedFrame,
            value: element.value,
            title: element.title,
            label: element.label,
            elementType: element.elementType,
            enabled: element.enabled,
            horizontalSizeClass: element.horizontalSizeClass,
            verticalSizeClass: element.verticalSizeClass,
            placeholderValue: element.placeholderValue,
            selected: element.selected,
            hasFocus: element.hasFocus,
            displayID: element.displayID,
            windowContextID: element.windowContextID,
            children: translatedChildren
        )
    }

    func getHierarchyWithFallback(_ element: XCUIElement) throws -> AXElement {
        logger.info("Starting getHierarchyWithFallback for element.")

        do {
            var hierarchy = try elementHierarchy(xcuiElement: element)
            logger.info("Successfully retrieved element hierarchy.")

            if hierarchy.depth() < snapshotMaxDepth {
                return hierarchy
            }
            let count = try element.snapshot().children.count
            var children: [AXElement] = []
            for i in 0..<count {
              let element = element.descendants(matching: .other).element(boundBy: i).firstMatch
              children.append(try getHierarchyWithFallback(element))
            }
            hierarchy.children = children
            return hierarchy
        } catch let error {
            guard isIllegalArgumentError(error) else {
                NSLog("Snapshot failure, cannot return view hierarchy due to \(error)")
                if let nsError = error as NSError?,
                   nsError.domain == "com.apple.dt.XCTest.XCTFuture",
                   nsError.code == 1000,
                   nsError.localizedDescription.contains("Timed out while evaluating UI query") {
                    throw AppError(type: .timeout, message: error.localizedDescription)
                } else if let nsError = error as NSError?,
                           nsError.domain == "com.apple.dt.xctest.automation-support.error",
                           nsError.code == 6,
                           nsError.localizedDescription.contains("Unable to perform work on main run loop, process main thread busy for") {
                    throw AppError(type: .timeout, message: nsError.localizedDescription)
                } else {
                    throw AppError(message: error.localizedDescription)
                }
            }

            NSLog("Snapshot failure, getting recovery element for fallback")
            AXClientSwizzler.overwriteDefaultParameters["maxDepth"] = snapshotMaxDepth
            // In apps with bigger view hierarchys, calling
            // `XCUIApplication().snapshot().dictionaryRepresentation` or `XCUIApplication().allElementsBoundByIndex`
            // throws "Error kAXErrorIllegalArgument getting snapshot for element <AXUIElementRef 0x6000025eb660>"
            // We recover by selecting the first child of the app element,
            // which should be the window, and continue from there.

            let recoveryElement = try findRecoveryElement(element.children(matching: .any).firstMatch)
            let hierarchy = try getHierarchyWithFallback(recoveryElement)

            // When the application element is skipped, try to fetch
            // the keyboard, alert and other custom element hierarchies separately.
            if let element = element as? XCUIApplication {
                let keyboard = logger.measure(message: "Fetch keyboard hierarchy") {
                    keyboardHierarchy(element)
                }

                let alerts = logger.measure(message: "Fetch alert hierarchy") {
                    fullScreenAlertHierarchy(element)
                }

                let other = try logger.measure(message: "Fetch other custom element from window") {
                    try customWindowElements(element)
                }
                return AXElement(children: [
                    other,
                    keyboard,
                    alerts,
                    hierarchy
                ].compactMap { $0 })
            }

            return hierarchy
        }
    }

    private func isIllegalArgumentError(_ error: Error) -> Bool {
        error.localizedDescription.contains("Error kAXErrorIllegalArgument getting snapshot for element")
    }

    private func keyboardHierarchy(_ element: XCUIApplication) -> AXElement? {
        guard element.keyboards.firstMatch.exists else {
            return nil
        }
        
        let keyboard = element.keyboards.firstMatch
        return try? elementHierarchy(xcuiElement: keyboard)
    }
    
    private func customWindowElements(_ element: XCUIApplication) throws -> AXElement? {
        let windowElement = element.children(matching: .any).firstMatch
        if try windowElement.snapshot().children.count > 1 {
            return nil
        }
        return try? elementHierarchy(xcuiElement: windowElement)
    }

    func fullScreenAlertHierarchy(_ element: XCUIApplication) -> AXElement? {
        guard element.alerts.firstMatch.exists else {
            return nil
        }
        
        let alert = element.alerts.firstMatch
        return try? elementHierarchy(xcuiElement: alert)
    }
    
    func fullStatusBars(_ element: XCUIApplication) -> [AXElement]? {
        guard element.statusBars.firstMatch.exists else {
            return nil
        }
        
        let snapshots = try? element.statusBars.allElementsBoundByIndex.compactMap{ (statusBar) in
            try elementHierarchy(xcuiElement: statusBar)
        }
        
        return snapshots
    }
    
    /// Fetches the Safari WebView hierarchy for iOS 26+ where SFSafariViewController
    /// runs in a separate process (com.apple.SafariViewService).
    /// Returns nil if not on iOS 26+, Safari service is not running, or no webviews exist.
    private func getSafariWebViewHierarchy() -> AXElement? {
        let systemVersion = ProcessInfo.processInfo.operatingSystemVersion
        guard systemVersion.majorVersion >= 26 else {
            return nil
        }
        
        let safariWebService = XCUIApplication(bundleIdentifier: "com.apple.SafariViewService")
        
        let isRunning = safariWebService.state == .runningForeground || safariWebService.state == .runningBackground
        guard isRunning else {
            return nil
        }
        
        let webViewCount = safariWebService.webViews.count
        guard webViewCount > 0 else {
            return nil
        }
        
        NSLog("[Start] Fetching Safari WebView hierarchy (\(webViewCount) webview(s) detected)")
        
        do {
            AXClientSwizzler.overwriteDefaultParameters["maxDepth"] = snapshotMaxDepth
            let safariHierarchy = try elementHierarchy(xcuiElement: safariWebService)
            NSLog("[Done] Safari WebView hierarchy fetched successfully")
            return safariHierarchy
        } catch {
            NSLog("[Error] Failed to fetch Safari WebView hierarchy: \(error.localizedDescription)")
            return nil
        }
    }

    private func findRecoveryElement(_ element: XCUIElement) throws -> XCUIElement {
        if try element.snapshot().children.count > 1 {
            return element
        }
        let firstOtherElement = element.children(matching: .other).firstMatch
        if (firstOtherElement.exists) {
            return try findRecoveryElement(firstOtherElement)
        } else {
            return element
        }
    }

    private func elementHierarchy(xcuiElement: XCUIElement) throws -> AXElement {
        let snapshotDictionary = try xcuiElement.snapshot().dictionaryRepresentation
        return AXElement(snapshotDictionary)
    }
}
