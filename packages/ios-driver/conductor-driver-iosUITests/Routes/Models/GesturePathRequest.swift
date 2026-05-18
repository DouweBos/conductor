import Foundation

/// One frame in a finger's path.
/// - `x`, `y`: pixel coordinates (orientation-aware in the device's natural frame).
/// - `dt`: delay in seconds since the previous frame. The first frame's `dt` is
///   the initial offset before the touch goes down.
struct GestureStep: Decodable {
    let x: Double
    let y: Double
    let dt: TimeInterval
}

/// A single finger's traced path. Must have at least one step. The first step
/// is the touch-down point; subsequent steps are moves; after the last step the
/// finger is lifted.
struct GestureFingerPath: Decodable {
    let steps: [GestureStep]
}

/// Multi-finger gesture path. Pass `paths.count == 1` for a single-finger
/// gesture; the handler builds a multi-finger event when there are 2+ paths.
struct GesturePathRequest: Decodable {
    let paths: [GestureFingerPath]
}
