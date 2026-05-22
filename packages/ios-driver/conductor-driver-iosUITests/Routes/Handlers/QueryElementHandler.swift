import FlyingFox
import XCTest
import Foundation
import ConductorDriverLib

/// Request body for `/queryElement`.
struct QueryElementRequest: Codable {
    /// One of "text", "id", or "query".
    let selectorKey: String
    /// The literal value to match (the caller guarantees it is not a regex).
    let selectorValue: String
    let appIds: [String]
}

/// Response body for `/queryElement`.
struct QueryElementResponse: Codable {
    let found: Bool
    /// 0 = no match, 1 = exactly one, 2 = two-or-more (ambiguous).
    let matchCount: Int
    /// The single matched element, populated only when `matchCount == 1`.
    let node: AXElement?
}

/// Resolves a single element directly through an XCUITest predicate query
/// instead of dumping and matching the entire view hierarchy.
///
/// This is the fast path for simple selectors: a predicate query touches only
/// the matching elements, whereas `/viewHierarchy` serialises the whole UI
/// tree. The handler reports `matchCount` so the caller can fall back to the
/// snapshot matcher when the result is ambiguous (`> 1`) or empty (`0`) —
/// only an exact single match is provably equivalent to the snapshot path.
@MainActor
struct QueryElementHandler: HTTPHandler {

    func handleRequest(_ request: FlyingFox.HTTPRequest) async throws -> FlyingFox.HTTPResponse {
        guard let requestBody = try? await JSONDecoder().decode(QueryElementRequest.self, from: request.bodyData) else {
            return AppError(type: .precondition, message: "incorrect request body provided for queryElement").httpResponse
        }

        let value = requestBody.selectorValue
        guard !value.isEmpty else {
            return AppError(type: .precondition, message: "selectorValue must not be empty").httpResponse
        }

        do {
            let app = RunningApp.getForegroundApp()
                ?? XCUIApplication(bundleIdentifier: RunningApp.springboardBundleId)
            let predicate = Self.buildPredicate(key: requestBody.selectorKey, value: value)
            let query = app.descendants(matching: .any).matching(predicate)

            // Collect at most two visible matches — that is enough to tell
            // "none" / "exactly one" / "ambiguous" apart.
            var matches: [XCUIElement] = []
            for element in query.allElementsBoundByIndex {
                guard element.exists else { continue }
                let frame = element.frame
                guard frame.width > 0, frame.height > 0 else { continue }
                matches.append(element)
                if matches.count > 1 { break }
            }

            if matches.count == 1, let snapshot = try? matches[0].snapshot() {
                let response = QueryElementResponse(
                    found: true,
                    matchCount: 1,
                    node: Self.axElement(from: snapshot)
                )
                return HTTPResponse(statusCode: .ok, body: try JSONEncoder().encode(response))
            }

            let response = QueryElementResponse(found: false, matchCount: matches.count, node: nil)
            return HTTPResponse(statusCode: .ok, body: try JSONEncoder().encode(response))
        } catch let error as AppError {
            return error.httpResponse
        } catch {
            return AppError(message: "queryElement failure: \(error.localizedDescription)").httpResponse
        }
    }

    /// Builds the matching predicate. `==[c]` is case-insensitive and matches
    /// the whole attribute, mirroring the literal full-string matching the
    /// JS-side selector matcher applies. For id/query, `ENDSWITH` also covers
    /// the "segment after the last slash" convention used for namespaced
    /// accessibility identifiers (e.g. React Native testIDs).
    private static func buildPredicate(key: String, value: String) -> NSPredicate {
        let suffix = "/" + value
        switch key {
        case "id":
            return NSPredicate(format: "identifier ==[c] %@ OR identifier ENDSWITH[c] %@", value, suffix)
        case "text":
            return NSPredicate(
                format: "label ==[c] %@ OR title ==[c] %@ OR placeholderValue ==[c] %@ OR value ==[c] %@",
                value, value, value, value
            )
        default: // "query" — match an accessibility id or any text-bearing field
            return NSPredicate(
                format: "identifier ==[c] %@ OR identifier ENDSWITH[c] %@ "
                    + "OR label ==[c] %@ OR title ==[c] %@ OR placeholderValue ==[c] %@ OR value ==[c] %@",
                value, suffix, value, value, value, value
            )
        }
    }

    /// Builds a shallow `AXElement` (no children) from an element snapshot —
    /// the caller only needs this node's frame and attributes to act on it.
    private static func axElement(from snapshot: XCUIElementSnapshot) -> AXElement {
        let frame: AXFrame = [
            "X": Double(snapshot.frame.minX),
            "Y": Double(snapshot.frame.minY),
            "Width": Double(snapshot.frame.width),
            "Height": Double(snapshot.frame.height),
        ]
        return AXElement(
            identifier: snapshot.identifier,
            frame: frame,
            value: snapshot.value as? String,
            title: snapshot.title,
            label: snapshot.label,
            elementType: Int(snapshot.elementType.rawValue),
            enabled: snapshot.isEnabled,
            placeholderValue: snapshot.placeholderValue,
            selected: snapshot.isSelected,
            hasFocus: snapshot.hasFocus,
            children: nil
        )
    }
}
