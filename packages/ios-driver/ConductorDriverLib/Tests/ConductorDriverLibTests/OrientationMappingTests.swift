import XCTest
@testable import ConductorDriverLib

final class OrientationMappingTests: XCTestCase {
    // iPhone 18 Pro, portrait points.
    private let width: CGFloat = 402
    private let height: CGFloat = 874

    func testInterfaceOrientationWinsOverUnknownDevice() {
        // A player that forces landscape while the device reports unknown (0).
        XCTAssertEqual(OrientationMapping.effective(interface: 3, device: 0), 3)
    }

    func testInterfaceOrientationWinsOverLandscapeDevice() {
        // Portrait-locked app on a device turned sideways stays portrait.
        XCTAssertEqual(OrientationMapping.effective(interface: 1, device: 4), 1)
    }

    func testFallsBackToDeviceWhenInterfaceUnknown() {
        XCTAssertEqual(OrientationMapping.effective(interface: nil, device: 4), 4)
        XCTAssertEqual(OrientationMapping.effective(interface: 0, device: 3), 3)
    }

    func testFlatOrUnknownMeansPortrait() {
        XCTAssertEqual(OrientationMapping.effective(interface: nil, device: 0), 1)
        XCTAssertEqual(OrientationMapping.effective(interface: 0, device: 5), 1)
        XCTAssertEqual(OrientationMapping.effective(interface: nil, device: 6), 1)
    }

    func testHomeOnRightMapsLandscapePointOntoScreen() {
        // Close button centre in the landscape hierarchy → where it is on the portrait screen.
        let p = OrientationMapping.toPortrait(CGPoint(x: 772, y: 36), orientation: 3, width: width, height: height)
        XCTAssertEqual(p, CGPoint(x: 366, y: 772))
    }

    func testHomeOnLeftMapsLandscapePointOntoScreen() {
        let p = OrientationMapping.toPortrait(CGPoint(x: 772, y: 36), orientation: 4, width: width, height: height)
        XCTAssertEqual(p, CGPoint(x: 36, y: 102))
    }

    func testPortraitPointUnchanged() {
        let p = OrientationMapping.toPortrait(CGPoint(x: 10, y: 20), orientation: 1, width: width, height: height)
        XCTAssertEqual(p, CGPoint(x: 10, y: 20))
    }

    func testOrientedSizeSwapsInLandscape() {
        XCTAssertEqual(OrientationMapping.orientedSize(width: width, height: height, orientation: 3), CGSize(width: 874, height: 402))
        XCTAssertEqual(OrientationMapping.orientedSize(width: width, height: height, orientation: 1), CGSize(width: 402, height: 874))
    }
}
