import Foundation
import UIKit

/// Swift entry point invoked by the dyld constructor (`bootstrap.c`).
///
/// Runs before the host app's `main()`, so we only arm a lifecycle hook here and
/// defer the actual control server until `didFinishLaunching` — starting UIKit
/// work this early is unsafe.
@_cdecl("ConductorBootstrap")
public func ConductorBootstrap() {
    // Start capture before main() so we catch early logs and every URLSession.
    ConsoleCapture.shared.start()
    NetworkCapture.install()
    ConductorControlServer.shared.installLifecycleHook()
}
