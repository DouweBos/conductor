//
// Bootstrap.swift
//
// Entry point invoked by ConductorInjectCtor's C constructor on dylib load.
// Reads CONDUCTOR_DYLIB_PORT, opens a TCP listener, and serves the five
// Conductor interaction routes in-process.
//
// Logs registration to stderr so the CLI / daemon log can see which apps
// have the dylib loaded.
//

import Foundation
import UIKit

/// Called from `conductor_inject_ctor.c` during dylib load. Runs before main(),
/// so we can't touch UIKit synchronously — defer to the next main-runloop tick.
@_cdecl("ConductorInjectInit")
public func ConductorInjectInit() {
    DispatchQueue.main.async {
        ConductorInjectServer.shared.start()
    }
}
