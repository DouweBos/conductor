import XCTest
import UIKit
import ConductorDriverLib

// UIKit doesn't include UIDeviceOrientation on tvOS
public enum DeviceOrientation: Int, @unchecked Sendable {
    case unknown = 0
    case portrait = 1 // Device oriented vertically, home button on the bottom
    case portraitUpsideDown = 2 // Device oriented vertically, home button on the top
    case landscapeLeft = 3 // Device oriented horizontally, home button on the right
    case landscapeRight = 4 // Device oriented horizontally, home button on the left
    case faceUp = 5 // Device oriented flat, face up
    case faceDown = 6 // Device oriented flat, face down
}

// UIKit doesn't include UIInterfaceOrientation on tvOS
public enum InterfaceOrientation: Int, @unchecked Sendable {
    case unknown = 0 // Unknown orientation
    case portrait = 1 // Device oriented vertically, home button on the bottom
    case portraitUpsideDown = 2 // Device oriented vertically, home button on the top
    case landscapeLeft = 3 // Device oriented horizontally, home button on the right
    case landscapeRight = 4 // Device oriented horizontally, home button on the left
}

struct ScreenSizeHelper {

    // Portrait-oriented physical *screen* bounds — not the current app's window.
    // Uses SpringBoard (HeadBoard on tvOS) because its frame is always the full
    // screen, independent of iPadOS windowing state, and .frame only resolves the
    // root XCUIElement so it's fast even under a heavy foreground app. The view
    // hierarchy endpoint separately reports the foreground app's window frame,
    // so callers that want the screenshot-matching dimensions use this, and
    // callers that want the app window frame read it from the hierarchy.
    static func physicalScreenSize() -> (Float, Float) {
        #if os(tvOS)
        // tvOS has no windowing, so the runner's own screen bounds are already
        // the full screen. Querying HeadBoard's frame hangs indefinitely on
        // physical Apple TVs, and it buys nothing here.
        let size = UIScreen.main.bounds.size
        #else
        let size = XCUIApplication(bundleIdentifier: "com.apple.springboard").frame.size
        #endif
        return (Float(size.width), Float(size.height))
    }

    private static func actualOrientation() -> DeviceOrientation {
        #if os(tvOS)
        let orientation = Optional(DeviceOrientation.unknown)
        #else
        let orientation = DeviceOrientation(rawValue: XCUIDevice.shared.orientation.rawValue)
        #endif

        guard let unwrappedOrientation = orientation, orientation != .unknown else {
            // If orientation is "unknown", we assume it is "portrait" to
            // work around https://stackoverflow.com/q/78932288/7009800
            return DeviceOrientation.portrait
        }

        // A physical device resting on a desk reports .faceUp/.faceDown, which a
        // simulator never does. Those say nothing about how the UI is laid out,
        // so treat them as portrait — matching what actualScreenSize() already
        // does for them. (A device held flat while the app is in landscape will
        // map coordinates as portrait; device orientation is all XCUIDevice
        // exposes here.)
        if unwrappedOrientation == .faceUp || unwrappedOrientation == .faceDown {
            return DeviceOrientation.portrait
        }

        return unwrappedOrientation
    }

    /// Takes device orientation into account.
    static func actualScreenSize() throws -> (Float, Float, DeviceOrientation) {
        let orientation = actualOrientation()

        let (width, height) = physicalScreenSize()
        let (actualWidth, actualHeight) =
            switch orientation {
            case .portrait, .portraitUpsideDown: (width, height)
            case .landscapeLeft, .landscapeRight: (height, width)
            case .faceDown, .faceUp: (width, height)
            case .unknown:
                throw AppError(
                    message: "Unsupported orientation: \(orientation)")
            @unknown default:
                throw AppError(
                    message: "Unsupported orientation: \(orientation)")
            }

        return (actualWidth, actualHeight, orientation)
    }

    static func orientationAwarePoint(
        width: Float, height: Float, point: CGPoint
    ) -> CGPoint {
        let orientation = actualOrientation()

        return switch orientation {
        case .portrait: point
        case .landscapeLeft:
            CGPoint(x: CGFloat(width) - point.y, y: CGFloat(point.x))
        case .landscapeRight:
            CGPoint(x: CGFloat(point.y), y: CGFloat(height) - point.x)
        // Never crash the driver over an orientation we don't map: an untranslated
        // point is a recoverable mis-tap, a fatalError kills every later request.
        default:
            {
                NSLog("orientationAwarePoint: unmapped orientation \(orientation), using point as-is")
                return point
            }()
        }
    }
}
