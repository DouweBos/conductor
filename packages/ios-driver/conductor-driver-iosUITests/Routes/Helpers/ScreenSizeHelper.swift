import XCTest
#if canImport(UIKit)
import UIKit
#endif
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
        #if os(macOS)
        let size = MacScreen.current().frame.size
        #elseif os(tvOS)
        // tvOS has no windowing, so the runner's own screen bounds are already
        // the full screen. Querying HeadBoard's frame hangs indefinitely on
        // physical Apple TVs, and it buys nothing here.
        let size = UIScreen.main.bounds.size
        #else
        let size = XCUIApplication(bundleIdentifier: "com.apple.springboard").frame.size
        #endif
        return (Float(size.width), Float(size.height))
    }

    // XCUI frames (and so every coordinate the CLI sends) are in the foreground
    // app's interface orientation. Device orientation alone misses apps that force
    // landscape: the device stays unknown/portrait while the UI is rotated.
    private static func actualOrientation() -> DeviceOrientation {
        #if os(tvOS) || os(macOS)
        return .portrait
        #else
        let interface = RunningApp.getForegroundApp()?.conductor_interfaceOrientation()
        let resolved = OrientationMapping.effective(
            interface: interface.map { Int($0) },
            device: XCUIDevice.shared.orientation.rawValue
        )
        return DeviceOrientation(rawValue: resolved) ?? .portrait
        #endif
    }

    /// Screen size in the foreground app's interface orientation.
    static func actualScreenSize() throws -> (Float, Float, DeviceOrientation) {
        let orientation = actualOrientation()

        let (width, height) = physicalScreenSize()
        let size = OrientationMapping.orientedSize(
            width: CGFloat(width), height: CGFloat(height), orientation: orientation.rawValue
        )
        return (Float(size.width), Float(size.height), orientation)
    }

    static func orientationAwarePoint(
        width: Float, height: Float, point: CGPoint
    ) -> CGPoint {
        OrientationMapping.toPortrait(
            point,
            orientation: actualOrientation().rawValue,
            width: CGFloat(width),
            height: CGFloat(height)
        )
    }
}
