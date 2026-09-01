
import Foundation
import XCTest

struct PressButtonRequest: Codable {
    enum Button: String, Codable {
        case home
        case lock
        #if os(tvOS)
        case up
        case down
        case left
        case right
        case select
        case menu
        case playPause
        // Newer remotes. Availability is checked at press time, since the
        // driver can run against an OS older than the SDK it was built with.
        case pageUp
        case pageDown
        case guide
        case tvProvider
        case oneTwoThree
        case fourColors
        #endif
    }

    let button: Button
    // tvOS held press (seconds); ignored off-tvOS.
    let duration: TimeInterval?
}
