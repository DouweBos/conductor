// swift-tools-version: 5.9
//
// conductor-sim-driver — host-side macOS binary that drives HID events into a
// booted iOS simulator via the private CoreSimulator.framework + IOKit's
// IOHIDEvent* APIs.
//
// One process per UDID. Per-device port; HTTP listener bound to 127.0.0.1.
// Spawned by the conductor daemon for iOS sessions. The CLI's IOSDriver
// prefers this server for the five HID-class routes (touch, swipeV2,
// gesturePath, pressKey, pressButton) and falls back to the XCUITest driver
// on connection error / non-2xx. Out-of-process so React Native, SwiftUI,
// and any view that handles raw touches sees real digitizer events instead
// of in-process UIKit synthesis.
//
// CoreSimulator.framework and the IOHIDEvent* functions are *private* Apple
// APIs. They're declared via a separate clang module target with bridging
// headers that re-declare only the selectors/functions we actually call —
// no Apple headers are vendored.
//
// Scope: macOS host binary, universal arm64+x86_64, adhoc-signed. The CLI
// bundles the artefact under packages/cli/drivers/ios-sim-driver/.
import PackageDescription

let package = Package(
    name: "conductor-sim-driver",
    platforms: [
        .macOS(.v12),
    ],
    products: [
        .executable(
            name: "conductor-sim-driver",
            targets: ["ConductorSimDriver"]
        ),
    ],
    targets: [
        // Clang module exposing the private CoreSimulator + IOHIDEvent symbols
        // that the Swift target calls into. The headers in this directory
        // declare only the runtime ABI we use — not Apple's full SPI surface.
        .target(
            name: "CCoreSimulator",
            path: "Sources/CCoreSimulator",
            publicHeadersPath: "include",
            linkerSettings: [
                .linkedFramework("CoreFoundation"),
                .linkedFramework("IOKit"),
                // CoreSimulator lives under /Library/Developer/PrivateFrameworks
                // and is not on the default framework search path. The build
                // script adds an -F flag pointing there; the link directive
                // here ensures the framework is recorded in the binary.
                .linkedFramework("CoreSimulator"),
                .unsafeFlags([
                    "-F", "/Library/Developer/PrivateFrameworks",
                    "-Xlinker", "-rpath",
                    "-Xlinker", "/Library/Developer/PrivateFrameworks",
                ]),
            ]
        ),
        .executableTarget(
            name: "ConductorSimDriver",
            dependencies: ["CCoreSimulator"],
            path: "Sources/ConductorSimDriver",
            linkerSettings: [
                .linkedFramework("CoreFoundation"),
                .linkedFramework("IOKit"),
                .linkedFramework("CoreSimulator"),
                .unsafeFlags([
                    "-F", "/Library/Developer/PrivateFrameworks",
                    "-Xlinker", "-rpath",
                    "-Xlinker", "/Library/Developer/PrivateFrameworks",
                ]),
            ]
        ),
    ]
)
