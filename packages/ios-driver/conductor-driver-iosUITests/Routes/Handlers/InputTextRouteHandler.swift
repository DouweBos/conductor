import FlyingFox
import XCTest
import os

@MainActor
struct InputTextRouteHandler : HTTPHandler {
    private let logger = Logger(
        subsystem: Bundle.main.bundleIdentifier!,
        category: String(describing: Self.self)
    )

    func handleRequest(_ request: FlyingFox.HTTPRequest) async throws -> FlyingFox.HTTPResponse {
        guard let requestBody = try? await JSONDecoder().decode(InputTextRequest.self, from: request.bodyData) else {
            return AppError(type: .precondition, message: "incorrect request body provided for input text").httpResponse
        }

        #if os(macOS)
        MacScreen.forInput().keyTarget.typeText(requestBody.text)
        return HTTPResponse(statusCode: .ok)
        #elseif os(watchOS)
        return await watchInputText(requestBody.text)
        #else
        do {
            let start = Date()

            await waitUntilKeyboardIsPresented()

            // Capture the focused field's value so we can tell, afterwards,
            // whether any of the typed text actually landed.
            let valueBefore = focusedEditableValue()

            try await TextInputHelper.inputText(requestBody.text)

            // Best-effort repair: when faster replay outpaces the keyboard the
            // first keystrokes can be dropped entirely. If a readable field is
            // unchanged from before typing, the input clearly did not register
            // — retype once. Anything uncertain is left alone.
            if shouldRepairTextEntry(typed: requestBody.text, valueBefore: valueBefore) {
                logger.info("Text entry did not register — retyping once")
                try await TextInputHelper.inputText(requestBody.text)
            }

            let duration = Date().timeIntervalSince(start)
            logger.info("Text input duration took \(duration)")
            return HTTPResponse(statusCode: .ok)
        } catch {
            return AppError(message: "Error inputting text: \(error.localizedDescription)").httpResponse
        }
        #endif
    }

    /// True only when we are confident the input was dropped: non-empty text
    /// was requested, the focused field is readable, and its value is byte-for
    /// byte identical to before typing. Returns false whenever anything is
    /// uncertain, so verification can never turn a working type into a failure.
    private func shouldRepairTextEntry(typed: String, valueBefore: String?) -> Bool {
        guard !typed.isEmpty else { return false }
        guard let before = valueBefore else { return false }
        guard let after = focusedEditableValue() else { return false }
        return after == before
    }

    /// Reads the current text of the focused field, or nil when no field is
    /// focused or its contents cannot be trusted (secure text entry).
    private func focusedEditableValue() -> String? {
        guard let app = RunningApp.getForegroundApp() else { return nil }
        let focused = app.descendants(matching: .any)
            .matching(NSPredicate(format: "hasKeyboardFocus == true"))
            .firstMatch
        guard focused.exists else { return nil }
        guard focused.elementType != .secureTextField else { return nil }
        return focused.value as? String
    }

    #if os(watchOS)
    /// watchOS edits text in a system input sheet that tapping a field opens; the
    /// field never takes keyboard focus. Type into the sheet, then Done commits it.
    private func watchInputText(_ text: String) async -> HTTPResponse {
        await waitUntilKeyboardIsPresented(timeout: 3)
        guard let app = RunningApp.getForegroundApp(), app.keyboards.firstMatch.exists else {
            return AppError(
                type: .precondition,
                message: "No text input sheet is open. On watchOS, tap the text field first; the text goes into the sheet it opens."
            ).httpResponse
        }
        app.typeText(text)
        let done = app.buttons["Done"]
        guard done.exists else {
            return AppError(message: "The watchOS input sheet has no Done button to commit the text").httpResponse
        }
        done.tap()
        return HTTPResponse(statusCode: .ok)
    }
    #endif

    private func waitUntilKeyboardIsPresented(timeout: TimeInterval = 1) async {
        try? await TimeoutHelper.repeatUntil(timeout: timeout, delta: 0.2) {
            let app = RunningApp.getForegroundApp() ?? XCUIApplication(bundleIdentifier: RunningApp.homeBundleId)

            return app.keyboards.firstMatch.exists
        }
    }
}
