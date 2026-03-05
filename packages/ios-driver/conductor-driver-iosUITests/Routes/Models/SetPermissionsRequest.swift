import Foundation
import ConductorDriverLib

struct SetPermissionsRequest: Codable {
    let permissions: [String : PermissionValue]
}