// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "ConductorDriverLib",
    platforms: [
        .iOS(.v15),
        .tvOS(.v15),
        .macOS(.v13)
    ],
    products: [
        .library(
            name: "ConductorDriverLib",
            targets: ["ConductorDriverLib"]
        ),
    ],
    targets: [
        .target(
            name: "ConductorDriverLib",
            path: "Sources/ConductorDriverLib"
        ),
        .testTarget(
            name: "ConductorDriverLibTests",
            dependencies: ["ConductorDriverLib"],
            path: "Tests/ConductorDriverLibTests"
        ),
    ]
)