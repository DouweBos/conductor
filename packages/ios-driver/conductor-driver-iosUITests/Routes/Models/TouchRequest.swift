import Foundation

struct TouchRequest : Codable {
    let x: Float
    let y: Float
    let duration: TimeInterval?
    // macOS only: modifier keys held during the click, and 2 for a double-click.
    let modifiers: [String]?
    let count: Int?
}
