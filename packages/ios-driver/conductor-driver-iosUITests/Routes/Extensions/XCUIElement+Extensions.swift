import Foundation
import XCTest

extension XCUIElement {
    #if os(iOS)
    func setText(text: String, application: XCUIApplication) {
        UIPasteboard.general.string = text
        doubleTap()
        application.menuItems["Paste"].tap()
    }
    #endif
}
