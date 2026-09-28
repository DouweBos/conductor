import Foundation
import XCTest

struct PressKeyRequest: Codable {
    /// A named key (delete, return, …) or, on macOS, any single character.
    let key: String
    /// macOS only: modifier names held while pressing, e.g. ["command", "shift"].
    let modifiers: [String]?

    var xctestKey: String? {
        // Note: XCUIKeyboardKey().rawValue is the ascii representation of that key,
        // not the enum value name.
        switch key {
        case "delete": return XCUIKeyboardKey.delete.rawValue
        case "return": return XCUIKeyboardKey.return.rawValue
        case "enter": return XCUIKeyboardKey.enter.rawValue
        case "tab": return XCUIKeyboardKey.tab.rawValue
        case "space": return XCUIKeyboardKey.space.rawValue
        case "escape": return XCUIKeyboardKey.escape.rawValue
        default: return nil
        }
    }
}
