import CoreGraphics

/// Maps between the coordinate space the CLI uses (the foreground app's
/// interface orientation, which XCUI element frames are reported in) and the
/// portrait screen space XCTest synthesizes touches in.
///
/// Orientations are raw values shared by UIDeviceOrientation and
/// UIInterfaceOrientation: 1 portrait, 2 upside down, 3 home-on-right
/// (device landscapeLeft / interface landscapeRight), 4 home-on-left.
public enum OrientationMapping {
    public static let portrait = 1
    public static let portraitUpsideDown = 2
    public static let homeOnRight = 3
    public static let homeOnLeft = 4

    /// The app's interface orientation wins: an app that forces landscape (e.g. a
    /// full-screen video player) leaves the device reporting unknown/portrait.
    /// Device orientation is only a fallback; faceUp/faceDown/unknown mean portrait.
    public static func effective(interface: Int?, device: Int) -> Int {
        if let interface, (1...4).contains(interface) { return interface }
        if (1...4).contains(device) { return device }
        return portrait
    }

    /// `width`/`height` are the portrait screen size in points.
    public static func toPortrait(_ point: CGPoint, orientation: Int, width: CGFloat, height: CGFloat) -> CGPoint {
        switch orientation {
        case homeOnRight: CGPoint(x: width - point.y, y: point.x)
        case homeOnLeft: CGPoint(x: point.y, y: height - point.x)
        default: point
        }
    }

    /// Screen size in the given orientation's coordinate space.
    public static func orientedSize(width: CGFloat, height: CGFloat, orientation: Int) -> CGSize {
        orientation == homeOnRight || orientation == homeOnLeft
            ? CGSize(width: height, height: width)
            : CGSize(width: width, height: height)
    }
}
