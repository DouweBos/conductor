//
// GestureSynthesizer.swift
//
// In-process touch and gesture synthesis. Discovers the topmost UIWindow,
// hit-tests the requested point, and drives the matching responder /
// gesture-recognizer chain.
//
// The synthesizer is intentionally coarse-grained — it covers the common
// "tap a UIControl", "swipe a scrollView", "drive a UIGestureRecognizer"
// cases without replicating XCUITest's CoreSimulator HID pipeline. The CLI
// will fall back to the XCUITest driver per-route if a specific app
// surfaces gesture-recognition issues (see plan: per-route XCUITest
// fallback knob).
//
// Coordinates arrive in **points** in the device's natural orientation,
// matching the XCUITest contract. The synthesizer maps them onto the
// orientation-aware key window.
//

import Foundation
import UIKit

@MainActor
enum GestureSynthesizer {
    // MARK: - Window discovery

    static func activeWindow() -> UIWindow? {
        if let scene = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .first(where: { $0.activationState == .foregroundActive })
            ?? UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first {
            if let key = scene.windows.first(where: { $0.isKeyWindow }) {
                return key
            }
            return scene.windows.first
        }
        return nil
    }

    static func hitTest(_ point: CGPoint) -> (UIView, UIWindow)? {
        guard let window = activeWindow() else { return nil }
        let local = window.convert(point, from: nil)
        guard let view = window.hitTest(local, with: nil) else { return nil }
        return (view, window)
    }

    // MARK: - Tap

    static func tap(at point: CGPoint, duration: Double?) {
        guard let (view, _) = hitTest(point) else { return }

        // Drive UIControl natively — this is the closest match to a real tap
        // for buttons, switches, segmented controls, etc.
        if let control = view as? UIControl {
            control.sendActions(for: .touchDown)
            let upDelay = duration ?? 0.0
            if upDelay > 0 {
                DispatchQueue.main.asyncAfter(deadline: .now() + upDelay) {
                    control.sendActions(for: .touchUpInside)
                }
            } else {
                control.sendActions(for: .touchUpInside)
            }
            return
        }

        // Walk up the responder chain looking for a tap gesture recognizer
        // and invoke it directly. This is best-effort — it covers the
        // overwhelming majority of SwiftUI/UIKit tappable views, but not
        // every custom hit-testing chain.
        if duration ?? 0 >= 0.4 {
            invokeRecognizer(of: UILongPressGestureRecognizer.self, on: view)
        } else {
            invokeRecognizer(of: UITapGestureRecognizer.self, on: view)
        }
    }

    private static func invokeRecognizer<T: UIGestureRecognizer>(of type: T.Type, on view: UIView) {
        var current: UIView? = view
        while let v = current {
            if let recognizers = v.gestureRecognizers {
                for r in recognizers where r is T && r.isEnabled {
                    // Use the private firing API only if available; otherwise
                    // simulate by sending state transitions. UIGestureRecognizer
                    // doesn't expose a public "fire now" — we send the target/
                    // action pair via the documented `addTarget` path.
                    fireRecognizer(r)
                    return
                }
            }
            current = v.superview
        }
    }

    private static func fireRecognizer(_ recognizer: UIGestureRecognizer) {
        // UIGestureRecognizer holds its targets in private storage. The closest
        // documented surface is `state` — recognizers re-broadcast on state
        // transitions. We push the state through began → ended which fires the
        // attached actions on most recognizers (tap, long-press, swipe).
        recognizer.setValue(UIGestureRecognizer.State.began.rawValue, forKey: "state")
        recognizer.setValue(UIGestureRecognizer.State.ended.rawValue, forKey: "state")
    }

    // MARK: - Swipe

    static func swipe(from start: CGPoint, to end: CGPoint, duration: TimeInterval) {
        guard let (view, _) = hitTest(start) else { return }

        // Find the nearest scroll view and offset its contentOffset directly —
        // this is the most reliable in-process swipe for the common case.
        if let scroll = enclosingScrollView(of: view) {
            let dx = start.x - end.x
            let dy = start.y - end.y
            let target = CGPoint(
                x: max(0, min(scroll.contentSize.width - scroll.bounds.width,
                              scroll.contentOffset.x + dx)),
                y: max(0, min(scroll.contentSize.height - scroll.bounds.height,
                              scroll.contentOffset.y + dy))
            )
            UIView.animate(withDuration: duration) {
                scroll.setContentOffset(target, animated: false)
            }
            return
        }

        // No scroll view in the chain — invoke a swipe-or-pan recognizer
        // on the responder chain if one is registered.
        invokeRecognizer(of: UIPanGestureRecognizer.self, on: view)
    }

    private static func enclosingScrollView(of view: UIView) -> UIScrollView? {
        var current: UIView? = view
        while let v = current {
            if let s = v as? UIScrollView { return s }
            current = v.superview
        }
        return nil
    }

    // MARK: - Multi-finger gesture path

    static func playGesturePaths(_ paths: [[(point: CGPoint, dt: Double)]]) {
        // Out of scope to fully synthesize multi-finger UIEvents in-process.
        // For the common pinch/rotate case the CLI falls back to XCUITest;
        // for single-finger linear paths we approximate with the swipe logic.
        guard let first = paths.first, first.count >= 2 else { return }
        let start = first.first!.point
        let end = first.last!.point
        let totalDuration = first.dropFirst().reduce(0.0) { $0 + $1.dt }
        swipe(from: start, to: end, duration: max(0.1, totalDuration))
    }
}
