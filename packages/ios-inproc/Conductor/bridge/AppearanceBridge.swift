import Foundation
import UIKit

/// App-wide appearance toggles and animation control — "does my UI survive dark
/// mode / RTL / large text", and freeze/scrub animations to inspect a frame.
extension IntrospectionBridge {

    /// Force light/dark/unspecified across all app windows.
    static func setAppearance(_ style: String) -> [String: Any] {
        onMain {
            let value: UIUserInterfaceStyle
            switch style {
            case "light": value = .light
            case "dark": value = .dark
            case "system", "unspecified": value = .unspecified
            default: return badValue("style must be light | dark | system")
            }
            for window in allWindows(includeHidden: true) { window.overrideUserInterfaceStyle = value }
            return ["status": "ok", "appearance": style]
        }
    }

    /// Force LTR/RTL layout direction across all windows (semantic content attr).
    static func setLayoutDirection(_ direction: String) -> [String: Any] {
        onMain {
            let value: UISemanticContentAttribute
            switch direction {
            case "rtl", "forceRightToLeft": value = .forceRightToLeft
            case "ltr", "forceLeftToRight": value = .forceLeftToRight
            case "unspecified", "auto": value = .unspecified
            default: return badValue("direction must be ltr | rtl | auto")
            }
            for window in allWindows(includeHidden: true) { window.semanticContentAttribute = value }
            return ["status": "ok", "layoutDirection": direction]
        }
    }

    /// Override Dynamic Type content size category app-wide (e.g. accessibilityExtraExtraExtraLarge).
    static func setContentSize(_ category: String) -> [String: Any] {
        onMain {
            let cat = UIContentSizeCategory(
                rawValue: "UICTContentSizeCategory" + category.prefix(1).uppercased() + category.dropFirst())
            if #available(iOS 17.0, tvOS 17.0, *) {
                for window in allWindows(includeHidden: true) {
                    window.traitOverrides.preferredContentSizeCategory = cat
                }
                return ["status": "ok", "contentSize": cat.rawValue]
            }
            return ["status": "error", "message": "Dynamic Type override needs iOS/tvOS 17+"]
        }
    }

    /// Global animation speed: 0 freezes, 1 normal, >1 fast-forward. Applied to
    /// every window layer so you can inspect a mid-animation frame in 3D.
    static func setAnimationSpeed(_ speed: Float) -> [String: Any] {
        onMain {
            for window in allWindows(includeHidden: true) {
                window.layer.speed = speed
                if speed == 0 {
                    // Pin at the current time so the frozen frame is deterministic.
                    window.layer.timeOffset = window.layer.convertTime(CACurrentMediaTime(), from: nil)
                } else {
                    window.layer.timeOffset = 0
                    window.layer.beginTime = 0
                }
            }
            return ["status": "ok", "animationSpeed": speed]
        }
    }
}
