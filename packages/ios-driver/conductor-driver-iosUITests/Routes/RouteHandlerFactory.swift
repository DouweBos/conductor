import Foundation
import FlyingFox

class RouteHandlerFactory {
    @MainActor class func createRouteHandler(route: Route) -> HTTPHandler {
        switch route {
        case .runningApp:
            return RunningAppRouteHandler()
        case .swipe:
            return SwipeRouteHandler()
        case .inputText:
            return InputTextRouteHandler()
        case .touch:
            return TouchRouteHandler()
        case .gesturePath:
            return GesturePathRouteHandler()
        case .screenshot:
            return ScreenshotHandler()
        case .isScreenStatic:
            return IsScreenStaticHandler()
        case .pressKey:
            return PressKeyHandler()
        case .pressButton:
            return PressButtonHandler()
        case .eraseText:
            return EraseTextHandler()
        case .deviceInfo:
            return DeviceInfoHandler()
        case .setOrientation:
            return SetOrientationHandler()
        case .setPermissions:
            return SetPermissionsHandler()
        case .viewHierarchy:
            return ViewHierarchyHandler()
        case .queryElement:
            return QueryElementHandler()
        case .status:
            return StatusHandler()
        case .keyboard:
            return KeyboardRouteHandler()
        case .terminateApp:
            return TerminateAppHandler()
        case .launchApp:
             return LaunchAppHandler()
        case .restoreFocus:
            return RestoreFocusHandler()
        }
    }
}
