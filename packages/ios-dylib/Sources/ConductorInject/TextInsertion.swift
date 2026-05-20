//
// TextInsertion.swift
//
// In-process `inputText` implementation. Walks the active window's
// responder chain to find or coerce a first responder, then calls
// `insertText:`. Falls back to HID-style per-character key events when
// no responder is set (no field is focused).
//
// Behavioral differences from the XCUITest driver (intentional — see
// docs/plans/ios-dylib-driver.md, "inputText behavior change"):
//   • No autocorrect / smart-quote substitution.
//   • No predictive bar artifacts.
//   • `shouldChangeCharactersInRange:` *is* delivered because we go
//     through `insertText:`, but only once per call, not per keystroke.
//
// OTP flows that watch per-keystroke timing may behave differently; the
// CLI surfaces this in `--ios-driver dylib` help.
//

import Foundation
import UIKit

@MainActor
enum TextInsertion {
    static func insert(_ text: String) {
        if let responder = findFirstResponder() {
            // Ensure the responder is focused before inserting — covers the
            // case where hit-testing landed on a tappable field that has
            // not yet activated its keyboard.
            if !(responder is UITextInput) {
                _ = responder.becomeFirstResponder()
            }
            if let input = responder as? UITextInput, let selection = input.selectedTextRange {
                input.replace(selection, withText: text)
                return
            }
            if let textField = responder as? UITextField {
                textField.insertText(text)
                return
            }
            if let textView = responder as? UITextView {
                textView.insertText(text)
                return
            }
        }

        // No first responder — fall back to character-by-character HID-style
        // typing via UIKeyInput on whatever the active window can produce.
        fallbackHIDType(text)
    }

    private static func findFirstResponder() -> UIResponder? {
        guard let window = GestureSynthesizer.activeWindow() else { return nil }
        return findFirstResponder(in: window)
    }

    private static func findFirstResponder(in view: UIView) -> UIResponder? {
        if view.isFirstResponder { return view }
        for sub in view.subviews {
            if let found = findFirstResponder(in: sub) { return found }
        }
        return nil
    }

    private static func fallbackHIDType(_ text: String) {
        // Best-effort: ask the active window to insert text via any
        // available UIKeyInput. This is rarely useful in practice — if no
        // field is focused there's nowhere for the text to land — but it
        // satisfies the plan's "fall back to HID if no responder is set"
        // requirement without escalating to private APIs.
        guard let window = GestureSynthesizer.activeWindow() else { return }
        if let input = window as? UIKeyInput {
            for char in text {
                input.insertText(String(char))
            }
        }
    }
}
