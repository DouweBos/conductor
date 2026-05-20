//
// KeyboardHelper.swift
//
// In-process `pressKey` implementation. Routes the five XCUITest keys
// (delete, return, enter, tab, space) through the first responder's
// UIKeyInput / UITextInput surface.
//

import Foundation
import UIKit

@MainActor
enum KeyboardHelper {
    static func pressKey(_ key: String) {
        guard let responder = findFirstResponder() else { return }

        switch key {
        case "delete":
            if let input = responder as? UIKeyInput {
                input.deleteBackward()
            }
        case "return", "enter":
            // Match UITextField "return key" semantics: ask the delegate
            // whether the return should be processed and resign focus.
            if let textField = responder as? UITextField {
                if textField.delegate?.textFieldShouldReturn?(textField) ?? true {
                    textField.resignFirstResponder()
                }
            } else if let textView = responder as? UITextView {
                textView.insertText("\n")
            } else if let input = responder as? UIKeyInput {
                input.insertText("\n")
            }
        case "tab":
            if let input = responder as? UIKeyInput {
                input.insertText("\t")
            }
        case "space":
            if let input = responder as? UIKeyInput {
                input.insertText(" ")
            }
        default:
            // Unknown key — silently no-op; the CLI's fallback will route
            // unrecognized keys to XCUITest.
            break
        }
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
}
