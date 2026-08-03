import Foundation
import UIKit

/// Reads native UI state from the host app process. All UIKit access hops to the
/// main thread. Shared by iOS and tvOS (UIKit types used here exist on both).
enum IntrospectionBridge {
    static let maxDepth = 40
    static let maxNodes = 4000

    // MARK: Public entry points (thread-safe: marshal to main)

    /// Thread-local: whether the current walk includes hidden/zero-alpha views.
    static var includeHiddenWalk = false

    static func inspect(includeHidden: Bool = false) -> [String: Any] {
        onMain {
            includeHiddenWalk = includeHidden
            defer { includeHiddenWalk = false }
            var counter = 0
            let windows = allWindows(includeHidden: includeHidden).map { viewNode($0, depth: 0, count: &counter) }
            return ["status": "ok", "nodeCount": counter, "windows": windows]
        }
    }

    /// Isolated PNGs for every view in the tree, keyed by id — one round-trip for
    /// a whole 3D exploded scene instead of one request per node. `scale` shrinks
    /// textures (0.5) for big trees or sharpens (2.0). Base64 PNG per id.
    static func snapshotAll(scale: CGFloat, maxCount: Int, includeHidden: Bool) -> [String: Any] {
        onMain {
            var out: [String: String] = [:]
            var order: [String] = []
            func visit(_ v: UIView) {
                if out.count >= maxCount { return }
                if !includeHidden && (v.isHidden || v.alpha < 0.01) { return }
                let id = idFor(v)
                if let png = renderView(v, includeSubviews: false, scale: scale) {
                    out[id] = png.base64EncodedString()
                    order.append(id)
                }
                v.subviews.forEach(visit)
            }
            allWindows(includeHidden: includeHidden).forEach(visit)
            return ["status": "ok", "count": out.count, "order": order, "textures": out]
        }
    }

    /// PNG of the whole key window (what's on screen).
    static func screenshot() -> Data? {
        onMain {
            guard let window = keyWindows().first else { return nil }
            let renderer = UIGraphicsImageRenderer(bounds: window.bounds)
            return renderer.image { _ in
                window.drawHierarchy(in: window.bounds, afterScreenUpdates: false)
            }.pngData()
        }
    }

    /// PNG of a rectangular region of the key window (crop any element by its
    /// inspect frame). Works for any renderer — UIImageView, RN Fabric, Chroma
    /// image views — because it composites whatever is actually drawn there.
    static func renderRegion(_ rect: CGRect) -> Data? {
        onMain {
            guard let window = keyWindows().first, rect.width > 0, rect.height > 0 else { return nil }
            let renderer = UIGraphicsImageRenderer(size: rect.size)
            return renderer.image { _ in
                window.drawHierarchy(
                    in: CGRect(x: -rect.minX, y: -rect.minY, width: window.bounds.width, height: window.bounds.height),
                    afterScreenUpdates: false
                )
            }.pngData()
        }
    }

    /// PNG of a single view rendered in isolation — the texture for a 3D
    /// exploded-layer viewer. `includeSubviews == false` (default) captures only
    /// this view's own content (background, border, image, text) by hiding its
    /// sublayers during render, so each node becomes a distinct layer plane.
    /// Restored before returning to the runloop, so nothing flickers on screen.
    static func snapshot(id: String, includeSubviews: Bool, scale: CGFloat = 1) -> Data? {
        onMain {
            guard let v = viewForId(id) else { return nil }
            return renderView(v, includeSubviews: includeSubviews, scale: scale)
        }
    }

    /// Render one view to a PNG (main-thread). `scale` overrides the device scale.
    static func renderView(_ v: UIView, includeSubviews: Bool, scale: CGFloat) -> Data? {
        let size = v.bounds.size
        guard size.width >= 1, size.height >= 1 else { return nil }
        let format = UIGraphicsImageRendererFormat.default()
        if scale > 0 { format.scale = scale }
        let renderer = UIGraphicsImageRenderer(size: size, format: format)
        return renderer.image { ctx in
            if includeSubviews {
                v.layer.render(in: ctx.cgContext)
            } else {
                let sublayers = v.layer.sublayers ?? []
                let saved = sublayers.map { $0.isHidden }
                sublayers.forEach { $0.isHidden = true }
                v.layer.render(in: ctx.cgContext)
                for (i, layer) in sublayers.enumerated() { layer.isHidden = saved[i] }
            }
        }.pngData()
    }

    static func navigation() -> [String: Any] {
        onMain {
            let windows: [[String: Any]] = keyWindows().compactMap { window in
                guard let root = window.rootViewController else { return nil }
                return [
                    "window": String(describing: type(of: window)),
                    "root": vcNode(root),
                ]
            }
            return ["status": "ok", "windows": windows]
        }
    }

    // MARK: Single-view detail (inspector panel)

    static func viewDetail(id: String) -> [String: Any] {
        onMain {
            guard let v = viewForId(id) else { return notFound(id) }
            var d: [String: Any] = [
                "status": "ok",
                "id": id,
                "class": String(describing: type(of: v)),
                "classHierarchy": classChain(v),
                "frame": rect(v.frame),
                "bounds": rect(v.bounds),
                "center": ["x": round(v.center.x), "y": round(v.center.y)],
                "alpha": round(v.alpha),
                "hidden": v.isHidden,
                "opaque": v.isOpaque,
                "clipsToBounds": v.clipsToBounds,
                "userInteractionEnabled": v.isUserInteractionEnabled,
                "contentMode": contentModeName(v.contentMode),
                "tag": v.tag,
                "translatesAutoresizingMaskIntoConstraints": v.translatesAutoresizingMaskIntoConstraints,
                "hasAmbiguousLayout": v.hasAmbiguousLayout,
                "subviewCount": v.subviews.count,
            ]
            if let window = v.window { d["absFrame"] = rect(v.convert(v.bounds, to: window)) }
            if let bg = hex(v.backgroundColor) { d["backgroundColor"] = bg }
            if let tint = hex(v.tintColor) { d["tintColor"] = tint }
            if !v.transform.isIdentity {
                d["transform"] = [
                    "a": round(v.transform.a), "b": round(v.transform.b),
                    "c": round(v.transform.c), "d": round(v.transform.d),
                    "tx": round(v.transform.tx), "ty": round(v.transform.ty),
                ]
            }
            var layer: [String: Any] = [
                "cornerRadius": round(v.layer.cornerRadius),
                "masksToBounds": v.layer.masksToBounds,
                "opacity": round(CGFloat(v.layer.opacity)),
                "zPosition": round(v.layer.zPosition),
                "borderWidth": round(v.layer.borderWidth),
            ]
            if let bc = v.layer.borderColor, let h = hex(UIColor(cgColor: bc)) { layer["borderColor"] = h }
            if v.layer.shadowOpacity > 0 {
                layer["shadowOpacity"] = round(CGFloat(v.layer.shadowOpacity))
                layer["shadowRadius"] = round(v.layer.shadowRadius)
            }
            d["layer"] = layer
            if let grs = v.gestureRecognizers, !grs.isEmpty {
                d["gestureRecognizers"] = grs.map { String(describing: type(of: $0)) }
            }
            if let sv = v.superview {
                d["superview"] = ["id": idFor(sv), "class": String(describing: type(of: sv))]
            }
            addTypeSpecifics(v, to: &d)
            return d
        }
    }

    // MARK: Live mutation (Reveal-style editing)

    static func setProperty(id: String, key: String, value: String) -> [String: Any] {
        onMain {
            guard let v = viewForId(id) else { return notFound(id) }
            switch key {
            case "alpha":
                guard let d = Double(value) else { return badValue("alpha wants a number") }
                v.alpha = CGFloat(d)
            case "hidden":
                v.isHidden = (value as NSString).boolValue
            case "clipsToBounds":
                v.clipsToBounds = (value as NSString).boolValue
            case "userInteractionEnabled":
                v.isUserInteractionEnabled = (value as NSString).boolValue
            case "backgroundColor":
                guard let c = color(value) else { return badValue("bad color (use #RRGGBB or #RRGGBBAA)") }
                v.backgroundColor = c
            case "tintColor":
                guard let c = color(value) else { return badValue("bad color") }
                v.tintColor = c
            case "cornerRadius":
                guard let d = Double(value) else { return badValue("number") }
                v.layer.cornerRadius = CGFloat(d)
                v.clipsToBounds = true
            case "borderWidth":
                guard let d = Double(value) else { return badValue("number") }
                v.layer.borderWidth = CGFloat(d)
            case "borderColor":
                guard let c = color(value) else { return badValue("bad color") }
                v.layer.borderColor = c.cgColor
            case "frame":
                guard let r = parseRect(value) else { return badValue("x,y,w,h") }
                v.frame = r
            case "text":
                guard setText(v, value) else { return badValue("view has no settable text") }
            case "textColor":
                guard let c = color(value) else { return badValue("bad color (use #RRGGBB or #RRGGBBAA)") }
                guard setTextColor(v, c) else { return badValue("view has no settable text color") }
            case "zPosition":
                guard let d = Double(value) else { return badValue("number") }
                v.layer.zPosition = CGFloat(d)
            case "opacity":
                guard let d = Double(value) else { return badValue("number") }
                v.layer.opacity = Float(d)
            case "anchorPoint":
                let p = value.split(separator: ",").compactMap { Double($0) }
                guard p.count == 2 else { return badValue("x,y") }
                v.layer.anchorPoint = CGPoint(x: p[0], y: p[1])
            case "transform3D":
                let m = value.split(separator: ",").compactMap { Double($0) }
                guard m.count == 16 else { return badValue("16 comma-separated numbers (row-major)") }
                v.layer.transform = CATransform3D(
                    m11: m[0], m12: m[1], m13: m[2], m14: m[3],
                    m21: m[4], m22: m[5], m23: m[6], m24: m[7],
                    m31: m[8], m32: m[9], m33: m[10], m34: m[11],
                    m41: m[12], m42: m[13], m43: m[14], m44: m[15])
            default:
                // Anything else: generic KVC set (ObjC exceptions caught) so any
                // settable property works, not just the whitelist above.
                var errorMessage: NSString?
                _ = ConductorObjC.catching({
                    v.setValue(coerce(value), forKeyPath: key)
                    return nil
                }, error: &errorMessage)
                if let message = errorMessage {
                    return ["status": "error", "message": "set '\(key)': \(message)"]
                }
            }
            v.setNeedsLayout()
            return ["status": "ok", "id": id, "set": [key: value]]
        }
    }

    /// Best-effort coercion of a string param into a KVC-settable value.
    static func coerce(_ value: String) -> Any {
        if value.hasPrefix("#"), let c = color(value) { return c }
        if value == "true" { return true }
        if value == "false" { return false }
        if let d = Double(value) { return d }
        return value
    }

    // MARK: React Native Fabric props (lazy — own endpoint, not in inspect)

    /// Typed `ViewProps` (reconstructed from the mounted host view's applied
    /// state) plus `rawProps` (the JS prop bag, C++-only — see ReactPropsBridge).
    /// Best-effort and crash-proof: a non-Fabric view returns isFabric:false.
    static func props(id: String) -> [String: Any] {
        onMain {
            guard let v = viewForId(id) else { return notFound(id) }
            let cls = String(describing: type(of: v))
            guard ReactPropsBridge.isFabricView(v) else {
                return ["status": "ok", "id": id, "class": cls, "isFabric": false,
                        "props": NSNull(), "rawProps": NSNull(),
                        "note": "not a React Native Fabric view"]
            }
            var out: [String: Any] = [
                "status": "ok", "id": id, "class": cls, "isFabric": true,
                "props": appliedViewProps(v),
            ]
            var note: NSString?
            if let json = ReactPropsBridge.rawPropsJSON(v, note: &note),
               let data = json.data(using: .utf8),
               let obj = try? JSONSerialization.jsonObject(with: data) {
                out["rawProps"] = obj
            } else {
                out["rawProps"] = NSNull()
                if let note { out["note"] = note as String }
            }
            return out
        }
    }

    /// The Fabric host view's applied ViewProps, read off the mounted UIKit view
    /// (RN wrote these values onto it). Only non-default fields; names match the
    /// `react::ViewProps` contract the Argus side consumes.
    static func appliedViewProps(_ v: UIView) -> [String: Any] {
        var p: [String: Any] = [:]
        let opacity = CGFloat(v.layer.opacity)
        if opacity < 0.999 { p["opacity"] = round(opacity) }
        if let bg = hex(v.backgroundColor) { p["backgroundColor"] = bg }
        // foregroundColor: text tint for RN text host views (attributedText).
        if v.responds(to: NSSelectorFromString("attributedText")),
           let attr = v.value(forKey: "attributedText") as? NSAttributedString, attr.length > 0,
           let fg = attr.attributes(at: 0, effectiveRange: nil)[.foregroundColor] as? UIColor,
           let h = hex(fg) { p["foregroundColor"] = h }
        if v.layer.cornerRadius > 0 { p["borderRadii"] = ["all": round(v.layer.cornerRadius)] }
        if v.layer.borderWidth > 0 { p["borderWidths"] = ["all": round(v.layer.borderWidth)] }
        if let bc = v.layer.borderColor, let h = hex(UIColor(cgColor: bc)) {
            p["borderColors"] = ["all": h]
        }
        if !CATransform3DIsIdentity(v.layer.transform) { p["transform"] = transform3D(v.layer.transform) }
        if v.layer.zPosition != 0 { p["zIndex"] = round(v.layer.zPosition) }
        if !v.isUserInteractionEnabled { p["pointerEvents"] = "none" }
        if let label = v.accessibilityLabel, !label.isEmpty { p["accessibilityLabel"] = label }
        if let testId = v.accessibilityIdentifier, !testId.isEmpty { p["testId"] = testId }
        if v.responds(to: NSSelectorFromString("nativeID")),
           let nid = v.value(forKey: "nativeID") as? String, !nid.isEmpty { p["nativeId"] = nid }
        return p
    }

    // MARK: Auto Layout constraints

    static func constraints(id: String) -> [String: Any] {
        onMain {
            guard let v = viewForId(id) else { return notFound(id) }
            return [
                "status": "ok",
                "id": id,
                "hasAmbiguousLayout": v.hasAmbiguousLayout,
                "horizontal": v.constraintsAffectingLayout(for: .horizontal).map(describeConstraint),
                "vertical": v.constraintsAffectingLayout(for: .vertical).map(describeConstraint),
                "own": v.constraints.map(describeConstraint),
            ]
        }
    }

    // MARK: Hit-test (select by point)

    static func hitTest(x: Double, y: Double) -> [String: Any] {
        onMain {
            let point = CGPoint(x: x, y: y)
            for window in keyWindows().reversed() {
                guard let hit = window.hitTest(point, with: nil) else { continue }
                var chain: [[String: Any]] = []
                var cursor: UIView? = hit
                var depth = 0
                while let c = cursor, depth < 15 {
                    chain.append(["id": idFor(c), "class": String(describing: type(of: c))])
                    cursor = c.superview
                    depth += 1
                }
                var d: [String: Any] = [
                    "status": "ok",
                    "id": idFor(hit),
                    "class": String(describing: type(of: hit)),
                    "chain": chain,
                ]
                d["absFrame"] = rect(hit.convert(hit.bounds, to: window))
                return d
            }
            return ["status": "error", "message": "no view at \(x),\(y)"]
        }
    }

    // MARK: On-device highlight

    static func highlight(id: String) -> [String: Any] {
        onMain {
            guard let v = viewForId(id), let window = v.window else { return notFound(id) }
            let frame = v.convert(v.bounds, to: window)
            let overlay = UIView(frame: frame)
            overlay.backgroundColor = UIColor.systemBlue.withAlphaComponent(0.22)
            overlay.layer.borderColor = UIColor.systemBlue.cgColor
            overlay.layer.borderWidth = 2
            overlay.isUserInteractionEnabled = false
            window.addSubview(overlay)
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { overlay.removeFromSuperview() }
            return ["status": "ok", "id": id, "highlighted": rect(frame)]
        }
    }

    // MARK: Search

    static func find(className: String?, text: String?) -> [String: Any] {
        onMain {
            var matches: [[String: Any]] = []
            func visit(_ v: UIView) {
                let cls = String(describing: type(of: v))
                var ok = true
                if let cn = className, !cn.isEmpty { ok = ok && cls.localizedCaseInsensitiveContains(cn) }
                if let t = text, !t.isEmpty { ok = ok && (textOf(v)?.localizedCaseInsensitiveContains(t) ?? false) }
                if ok && (className != nil || text != nil) {
                    var m: [String: Any] = ["id": idFor(v), "class": cls]
                    if let window = v.window { m["absFrame"] = rect(v.convert(v.bounds, to: window)) }
                    if let t = textOf(v) { m["text"] = t }
                    matches.append(m)
                }
                v.subviews.forEach(visit)
            }
            keyWindows().forEach(visit)
            return ["status": "ok", "count": matches.count, "matches": Array(matches.prefix(200))]
        }
    }

    // MARK: id ↔ view

    static func idFor(_ view: UIView) -> String {
        let ptr = Unmanaged.passUnretained(view).toOpaque()
        return String(format: "0x%llx", UInt(bitPattern: ptr))
    }

    static func viewForId(_ id: String) -> UIView? {
        for window in allWindows(includeHidden: true) {
            if let v = searchTree(window, id: id) { return v }
        }
        return nil
    }

    static func searchTree(_ view: UIView, id: String) -> UIView? {
        if idFor(view) == id { return view }
        for sub in view.subviews {
            if let found = searchTree(sub, id: id) { return found }
        }
        return nil
    }

    // MARK: Window discovery

    static func keyWindows() -> [UIWindow] {
        allWindows(includeHidden: false)
    }

    static func allWindows(includeHidden: Bool) -> [UIWindow] {
        var windows: [UIWindow] = []
        for scene in UIApplication.shared.connectedScenes {
            if let ws = scene as? UIWindowScene { windows.append(contentsOf: ws.windows) }
        }
        if windows.isEmpty { windows = UIApplication.shared.windows }
        if includeHidden { return windows }
        return windows.filter { !$0.isHidden && $0.alpha > 0.01 }
    }

    // MARK: View hierarchy

    static func viewNode(_ view: UIView, depth: Int, count: inout Int) -> [String: Any] {
        count += 1
        var node: [String: Any] = [
            "id": idFor(view),
            "class": String(describing: type(of: view)),
            "frame": rect(view.frame),
            "depth": depth,
        ]
        // Window-absolute rect — the plane's position/size in the 3D explosion,
        // and what `native-image --frame` crops.
        if let window = view.window {
            node["absFrame"] = rect(view.convert(view.bounds, to: window))
        }
        // z-ordering within siblings (layer zPosition); the exploded viewer stacks
        // primarily by `depth`, then by sibling order / zPosition.
        if view.layer.zPosition != 0 { node["z"] = round(view.layer.zPosition) }
        if view.alpha < 0.999 { node["alpha"] = round(view.alpha) }
        if view.isHidden { node["hidden"] = true }
        if let id = view.accessibilityIdentifier, !id.isEmpty { node["accessibilityIdentifier"] = id }
        if let label = view.accessibilityLabel, !label.isEmpty { node["accessibilityLabel"] = label }
        if let bg = hex(view.backgroundColor) { node["backgroundColor"] = bg }
        // 3D geometry: full CATransform3D + anchor when non-default.
        if !CATransform3DIsIdentity(view.layer.transform) { node["transform3D"] = transform3D(view.layer.transform) }
        let anchor = view.layer.anchorPoint
        if abs(anchor.x - 0.5) > 0.001 || abs(anchor.y - 0.5) > 0.001 {
            node["anchorPoint"] = ["x": round(anchor.x), "y": round(anchor.y)]
        }
        if view.layer.mask != nil { node["hasMask"] = true }
        if let rn = reactInfo(view) { node["rn"] = rn }
        addLayerVisuals(view.layer, to: &node)
        addTypeSpecifics(view, to: &node)

        if depth < maxDepth && count < maxNodes {
            let subs = includeHiddenWalk ? view.subviews : view.subviews.filter { !$0.isHidden || $0.alpha > 0.01 }
            let children = subs.map { viewNode($0, depth: depth + 1, count: &count) }
            if !children.isEmpty { node["children"] = children }
        } else if !view.subviews.isEmpty {
            node["truncated"] = view.subviews.count
        }
        return node
    }

    /// React Native tag/testID mapping so a node reads as its JSX component.
    static func reactInfo(_ view: UIView) -> [String: Any]? {
        var rn: [String: Any] = [:]
        for key in ["reactTag", "nativeID"] where view.responds(to: NSSelectorFromString(key)) {
            if let v = view.value(forKey: key) {
                let s = String(describing: v)
                if !s.isEmpty && s != "0" && s != "<null>" { rn[key] = s }
            }
        }
        if let testID = view.accessibilityIdentifier, !testID.isEmpty { rn["testID"] = testID }
        return rn.isEmpty ? nil : rn
    }

    static func transform3D(_ t: CATransform3D) -> [Double] {
        [t.m11, t.m12, t.m13, t.m14, t.m21, t.m22, t.m23, t.m24,
         t.m31, t.m32, t.m33, t.m34, t.m41, t.m42, t.m43, t.m44].map { Self.round($0) }
    }

    static func addLayerVisuals(_ layer: CALayer, to node: inout [String: Any]) {
        if layer.cornerRadius > 0 {
            node["cornerRadius"] = round(layer.cornerRadius)
            // maskedCorners matters for the 3D plane's shape (top-only rounding, etc.)
            if layer.maskedCorners != [.layerMinXMinYCorner, .layerMaxXMinYCorner, .layerMinXMaxYCorner, .layerMaxXMaxYCorner] {
                node["maskedCorners"] = layer.maskedCorners.rawValue
            }
        }
        if layer.masksToBounds { node["masksToBounds"] = true }
        if layer.borderWidth > 0 {
            node["borderWidth"] = round(layer.borderWidth)
            if let c = layer.borderColor, let h = hex(UIColor(cgColor: c)) { node["borderColor"] = h }
        }
        if layer.shadowOpacity > 0 {
            node["shadowOpacity"] = round(CGFloat(layer.shadowOpacity))
            node["shadowRadius"] = round(layer.shadowRadius)
            if let c = layer.shadowColor, let h = hex(UIColor(cgColor: c)) { node["shadowColor"] = h }
        }
        if let gradient = layer as? CAGradientLayer {
            let colors = (gradient.colors as? [CGColor])?.compactMap { hex(UIColor(cgColor: $0)) }
            if let colors, !colors.isEmpty { node["gradientColors"] = colors }
        }
    }

    static func addTypeSpecifics(_ view: UIView, to node: inout [String: Any]) {
        switch view {
        case let label as UILabel:
            node["text"] = label.text ?? ""
            if let c = hex(label.textColor) { node["textColor"] = c }
            if let f = font(label.font) { node["font"] = f }
        case let field as UITextField:
            node["text"] = field.text ?? ""
            if let p = field.placeholder { node["placeholder"] = p }
            if let c = hex(field.textColor) { node["textColor"] = c }
            if let f = font(field.font) { node["font"] = f }
        case let textView as UITextView:
            node["text"] = textView.text ?? ""
            if let c = hex(textView.textColor) { node["textColor"] = c }
            if let f = font(textView.font) { node["font"] = f }
        case let button as UIButton:
            node["title"] = button.title(for: .normal) ?? button.currentTitle ?? ""
            if let c = hex(button.currentTitleColor) { node["titleColor"] = c }
            if let f = font(button.titleLabel?.font) { node["font"] = f }
            node["enabled"] = button.isEnabled
        case let imageView as UIImageView:
            if let img = imageView.image {
                var meta: [String: Any] = [
                    "w": Int(img.size.width.rounded()),
                    "h": Int(img.size.height.rounded()),
                    "scale": round(img.scale),
                ]
                if let name = img.accessibilityIdentifier, !name.isEmpty { meta["name"] = name }
                node["image"] = meta
            }
        default:
            break
        }

        // Fabric / custom text renderers (React Native RCTParagraph*, TextKit-based
        // views, etc.) render an NSAttributedString and aren't UILabel — pull text,
        // color, and font generically. Guarded by responds(to:) so KVC is safe.
        if node["text"] == nil,
           view.responds(to: NSSelectorFromString("attributedText")),
           let attributed = view.value(forKey: "attributedText") as? NSAttributedString,
           !attributed.string.isEmpty {
            node["text"] = attributed.string
            let attrs = attributed.attributes(at: 0, effectiveRange: nil)
            if let color = attrs[.foregroundColor] as? UIColor, let h = hex(color) {
                node["textColor"] = h
            }
            if let f = attrs[.font] as? UIFont, let fi = font(f) { node["font"] = fi }
        }

        if let tint = hex(view.tintColor), view is UIControl { node["tintColor"] = tint }
    }

    // MARK: View controller hierarchy (navigation state)

    static func vcNode(_ vc: UIViewController) -> [String: Any] {
        var node: [String: Any] = ["class": String(describing: type(of: vc))]
        if let title = vc.title, !title.isEmpty { node["title"] = title }
        node["viewLoaded"] = vc.isViewLoaded

        if let nav = vc as? UINavigationController {
            node["kind"] = "navigation"
            node["stack"] = nav.viewControllers.map { child -> [String: Any] in
                var s: [String: Any] = ["class": String(describing: type(of: child))]
                if let t = child.title, !t.isEmpty { s["title"] = t }
                if let navItemTitle = child.navigationItem.title, !navItemTitle.isEmpty {
                    s["navigationItemTitle"] = navItemTitle
                }
                return s
            }
            if let top = nav.topViewController {
                node["top"] = String(describing: type(of: top))
            }
        } else if let tab = vc as? UITabBarController {
            node["kind"] = "tab"
            node["selectedIndex"] = tab.selectedIndex
            node["tabs"] = (tab.viewControllers ?? []).map { vcNode($0) }
        } else if let split = vc as? UISplitViewController {
            node["kind"] = "split"
            node["columns"] = split.viewControllers.map { vcNode($0) }
        } else {
            let children = vc.children.map { vcNode($0) }
            if !children.isEmpty { node["children"] = children }
        }

        if let presented = vc.presentedViewController {
            node["presented"] = vcNode(presented)
        }
        return node
    }

    // MARK: Helpers

    static func rect(_ r: CGRect) -> [String: Int] {
        [
            "x": Int(r.origin.x.rounded()),
            "y": Int(r.origin.y.rounded()),
            "w": Int(r.size.width.rounded()),
            "h": Int(r.size.height.rounded()),
        ]
    }

    static func round(_ v: CGFloat) -> Double {
        (Double(v) * 100).rounded() / 100
    }

    /// UIColor → "#RRGGBBAA", resolving dynamic (trait-dependent) colors.
    static func hex(_ color: UIColor?) -> String? {
        guard let color else { return nil }
        let resolved = color.resolvedColor(with: UITraitCollection.current)
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        if resolved.getRed(&r, green: &g, blue: &b, alpha: &a) {
            return format(r, g, b, a)
        }
        var white: CGFloat = 0
        if resolved.getWhite(&white, alpha: &a) {
            return format(white, white, white, a)
        }
        return nil
    }

    static func format(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat) -> String {
        func clamp(_ v: CGFloat) -> Int { max(0, min(255, Int((v * 255).rounded()))) }
        return String(format: "#%02X%02X%02X%02X", clamp(r), clamp(g), clamp(b), clamp(a))
    }

    static func font(_ font: UIFont?) -> [String: Any]? {
        guard let font else { return nil }
        var info: [String: Any] = [
            "name": font.fontName,
            "family": font.familyName,
            "size": round(font.pointSize),
        ]
        let traits = font.fontDescriptor.symbolicTraits
        if traits.contains(.traitBold) { info["bold"] = true }
        if traits.contains(.traitItalic) { info["italic"] = true }
        if let dict = font.fontDescriptor.object(forKey: .traits) as? [UIFontDescriptor.TraitKey: Any],
           let weight = dict[.weight] as? NSNumber {
            info["weight"] = round(CGFloat(weight.doubleValue))
        }
        return info
    }

    static func onMain<T>(_ work: () -> T) -> T {
        if Thread.isMainThread { return work() }
        return DispatchQueue.main.sync(execute: work)
    }

    static func notFound(_ id: String) -> [String: Any] {
        ["status": "error", "message": "no view with id \(id) (re-run native-inspect; ids change across launches)"]
    }

    static func badValue(_ msg: String) -> [String: Any] {
        ["status": "error", "message": msg]
    }

    /// Parse "#RRGGBB" or "#RRGGBBAA" into a UIColor.
    static func color(_ value: String) -> UIColor? {
        var s = value.hasPrefix("#") ? String(value.dropFirst()) : value
        if s.count == 6 { s += "FF" }
        guard s.count == 8, let v = UInt32(s, radix: 16) else { return nil }
        return UIColor(
            red: CGFloat((v >> 24) & 0xFF) / 255,
            green: CGFloat((v >> 16) & 0xFF) / 255,
            blue: CGFloat((v >> 8) & 0xFF) / 255,
            alpha: CGFloat(v & 0xFF) / 255
        )
    }

    static func parseRect(_ value: String) -> CGRect? {
        let n = value.split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
        guard n.count == 4 else { return nil }
        return CGRect(x: n[0], y: n[1], width: n[2], height: n[3])
    }

    static func setText(_ view: UIView, _ value: String) -> Bool {
        switch view {
        case let label as UILabel: label.text = value
        case let field as UITextField: field.text = value
        case let textView as UITextView: textView.text = value
        case let button as UIButton: button.setTitle(value, for: .normal)
        default:
            // RN Fabric (RCTParagraphComponentView) and other attributedText-based
            // renderers: swap the string but keep the existing run attributes.
            return setAttributed(view) { current in
                let m = NSMutableAttributedString(string: value)
                if let current, current.length > 0 {
                    let attrs = current.attributes(at: 0, effectiveRange: nil)
                    m.setAttributes(attrs, range: NSRange(location: 0, length: m.length))
                }
                return m
            }
        }
        return true
    }

    static func setTextColor(_ view: UIView, _ color: UIColor) -> Bool {
        switch view {
        case let label as UILabel: label.textColor = color; return true
        case let field as UITextField: field.textColor = color; return true
        case let textView as UITextView: textView.textColor = color; return true
        case let button as UIButton: button.setTitleColor(color, for: .normal); return true
        default: break
        }
        // RN Fabric: re-apply foregroundColor over the whole attributed string.
        if setAttributed(view, { current in
            let m = current.map { NSMutableAttributedString(attributedString: $0) } ?? NSMutableAttributedString()
            if m.length > 0 { m.addAttribute(.foregroundColor, value: color, range: NSRange(location: 0, length: m.length)) }
            return m
        }) { return true }
        // Anything else with a KVC-settable textColor (ObjC exceptions caught).
        var errorMessage: NSString?
        _ = ConductorObjC.catching({
            view.setValue(color, forKeyPath: "textColor")
            return nil
        }, error: &errorMessage)
        if errorMessage == nil { view.setNeedsLayout(); view.setNeedsDisplay(); return true }
        return false
    }

    /// Rewrite an attributedText-backed view's string (RN Fabric, TextKit renderers)
    /// via KVC. Returns false if the view can't get+set attributedText or ObjC throws.
    static func setAttributed(_ view: UIView, _ transform: (NSAttributedString?) -> NSAttributedString) -> Bool {
        guard view.responds(to: NSSelectorFromString("attributedText")),
              view.responds(to: NSSelectorFromString("setAttributedText:")) else { return false }
        let current = view.value(forKey: "attributedText") as? NSAttributedString
        let updated = transform(current)
        var errorMessage: NSString?
        _ = ConductorObjC.catching({
            view.setValue(updated, forKey: "attributedText")
            return nil
        }, error: &errorMessage)
        guard errorMessage == nil else { return false }
        view.setNeedsLayout()
        view.setNeedsDisplay()
        return true
    }

    static func textOf(_ view: UIView) -> String? {
        if let label = view as? UILabel, let t = label.text, !t.isEmpty { return t }
        if let field = view as? UITextField, let t = field.text, !t.isEmpty { return t }
        if let button = view as? UIButton, let t = button.title(for: .normal), !t.isEmpty { return t }
        if view.responds(to: NSSelectorFromString("attributedText")),
           let attr = view.value(forKey: "attributedText") as? NSAttributedString, !attr.string.isEmpty {
            return attr.string
        }
        if let label = view.accessibilityLabel, !label.isEmpty { return label }
        return nil
    }

    static func classChain(_ obj: AnyObject) -> [String] {
        var chain: [String] = []
        var cls: AnyClass? = type(of: obj)
        while let c = cls {
            chain.append(String(describing: c))
            cls = class_getSuperclass(c)
        }
        return chain
    }

    static func contentModeName(_ mode: UIView.ContentMode) -> String {
        switch mode {
        case .scaleToFill: return "scaleToFill"
        case .scaleAspectFit: return "scaleAspectFit"
        case .scaleAspectFill: return "scaleAspectFill"
        case .center: return "center"
        case .top: return "top"
        case .bottom: return "bottom"
        case .left: return "left"
        case .right: return "right"
        case .redraw: return "redraw"
        default: return "other(\(mode.rawValue))"
        }
    }

    static func describeConstraint(_ c: NSLayoutConstraint) -> [String: Any] {
        var d: [String: Any] = [
            "constant": round(c.constant),
            "multiplier": round(c.multiplier),
            "priority": round(CGFloat(c.priority.rawValue)),
            "active": c.isActive,
            "relation": relationName(c.relation),
            "firstAttribute": attributeName(c.firstAttribute),
            "description": String(describing: c),
        ]
        if c.secondItem != nil { d["secondAttribute"] = attributeName(c.secondAttribute) }
        return d
    }

    static func relationName(_ r: NSLayoutConstraint.Relation) -> String {
        switch r {
        case .lessThanOrEqual: return "<="
        case .equal: return "=="
        case .greaterThanOrEqual: return ">="
        @unknown default: return "?"
        }
    }

    static func attributeName(_ a: NSLayoutConstraint.Attribute) -> String {
        switch a {
        case .left: return "left"
        case .right: return "right"
        case .top: return "top"
        case .bottom: return "bottom"
        case .leading: return "leading"
        case .trailing: return "trailing"
        case .width: return "width"
        case .height: return "height"
        case .centerX: return "centerX"
        case .centerY: return "centerY"
        case .lastBaseline: return "lastBaseline"
        case .firstBaseline: return "firstBaseline"
        case .notAnAttribute: return "none"
        default: return "attr(\(a.rawValue))"
        }
    }
}
