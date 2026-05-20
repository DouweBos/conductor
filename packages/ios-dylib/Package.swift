// swift-tools-version: 5.9
//
// libConductorInject — experimental in-process iOS interaction driver.
//
// Built as a dynamic library and injected into a target app via
// DYLD_INSERT_LIBRARIES on the booted simulator. On dylib load:
//   1. ConductorInjectCtor (C) fires a __attribute__((constructor)) which
//      calls Swift's `ConductorInjectInit`.
//   2. `ConductorInjectInit` reads CONDUCTOR_DYLIB_PORT from the environment
//      and opens an HTTP listener on 127.0.0.1:<port>.
//   3. Serves five interaction routes (tap, swipe, gesturePath,
//      pressKey, inputText) with the same JSON contract as the
//      XCUITest driver.
//
// Scope: iphonesimulator only. The dylib never ships for real devices —
// DYLD_INSERT_LIBRARIES is forbidden by code signing on iOS hardware.
import PackageDescription

let package = Package(
    name: "libConductorInject",
    platforms: [
        .iOS(.v14),
    ],
    products: [
        .library(
            name: "ConductorInject",
            type: .dynamic,
            targets: ["ConductorInject"]
        ),
    ],
    targets: [
        // C target that owns the __attribute__((constructor)) entry. Linking
        // it into the dynamic library guarantees dyld emits a __mod_init_func
        // slot so our init runs on DYLD_INSERT_LIBRARIES load (Swift globals
        // alone don't — they fire on first symbol access).
        .target(
            name: "ConductorInjectCtor",
            path: "Sources/ConductorInjectCtor"
        ),
        .target(
            name: "ConductorInject",
            dependencies: ["ConductorInjectCtor"],
            path: "Sources/ConductorInject"
        ),
    ]
)
