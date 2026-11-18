import AppKit
import PDFKit

// 寸法の測定（距離・周長・面積）。Windows 版と同じ計算。
// 保存するときも普通の PDF 注釈（線・折れ線＋値のラベル）なので、ほかのビューアでも見える。
// 図形の注釈に測定の情報（種類・頂点・縮尺）を "/PDFStudioMeasure" として入れておき、開き直しても調整できる。
// 頂点は図形の注釈の bounds の左下からの位置で持つ（注釈を動かしても頂点がずれない）。

struct MeasureScale: Codable, Equatable {
    var factor: Double     // PDF の 1pt あたりの実寸（unit）
    var unit: String
    var label: String      // "1:100" など
    var ratio: Double?
    var decimals: Int

    static let units: [String: Double] = ["mm": 1, "cm": 0.1, "m": 0.001, "in": 1 / 25.4, "ft": 1 / 304.8, "pt": 72 / 25.4]
    static let unitOrder = ["mm", "cm", "m", "in", "ft", "pt"]
    static let unitNames = ["mm": "ミリメートル (mm)", "cm": "センチメートル (cm)", "m": "メートル (m)", "in": "インチ (in)", "ft": "フィート (ft)", "pt": "ポイント (pt)"]
    static let mmPerPt = 25.4 / 72

    /// 縮尺 1:n を、PDF の 1pt あたりの実寸に変換
    static func factor(ratio n: Double, unit: String) -> Double { mmPerPt * n * (units[unit] ?? 1) }

    static let standard = MeasureScale(factor: factor(ratio: 1, unit: "mm"), unit: "mm", label: "1:1", ratio: 1, decimals: 1)
}

struct MeasureData: Codable, Equatable {
    var kind: String          // distance / perimeter / area
    var points: [[Double]]    // 図形の注釈の bounds の左下からの位置（PDF の pt）
    var scale: MeasureScale
}

enum Measure {
    static let key = PDFAnnotationKey(rawValue: "/PDFStudioMeasure")
    static let groupPrefix = "pdfstudio-measure:"
    static let labelSize: CGFloat = 10

    // MARK: 計算

    static func absolute(_ d: MeasureData, origin: CGPoint) -> [CGPoint] {
        d.points.map { CGPoint(x: origin.x + $0[0], y: origin.y + ($0.count > 1 ? $0[1] : 0)) }
    }

    /// 測定値（数値と表示用の文字）
    static func value(kind: String, points pts: [CGPoint], scale sc: MeasureScale) -> (value: Double, text: String) {
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.minimumFractionDigits = sc.decimals
        f.maximumFractionDigits = sc.decimals
        let fmt = { (v: Double) in f.string(from: NSNumber(value: v)) ?? String(v) }
        if kind == "area" {
            var a = 0.0
            for i in pts.indices {
                let p = pts[i], q = pts[(i + 1) % pts.count]
                a += Double(p.x * q.y - q.x * p.y)
            }
            let v = abs(a) / 2 * sc.factor * sc.factor
            return (v, "\(fmt(v)) \(sc.unit)²")
        }
        var len = 0.0
        for i in pts.indices.dropFirst() { len += Double(hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)) }
        let v = len * sc.factor
        return (v, "\(fmt(v)) \(sc.unit)")
    }

    /// ラベルを置く位置（距離は中点、周長はいちばん長い辺の中点、面積は重心）
    static func labelCenter(kind: String, points pts: [CGPoint]) -> CGPoint {
        guard !pts.isEmpty else { return .zero }
        if kind == "area" {
            var a: CGFloat = 0, cx: CGFloat = 0, cy: CGFloat = 0
            for i in pts.indices {
                let p = pts[i], q = pts[(i + 1) % pts.count]
                let k = p.x * q.y - q.x * p.y
                a += k; cx += (p.x + q.x) * k; cy += (p.y + q.y) * k
            }
            if abs(a) > 1e-6 { return CGPoint(x: cx / (3 * a), y: cy / (3 * a)) }
            return CGPoint(x: pts.map(\.x).reduce(0, +) / CGFloat(pts.count), y: pts.map(\.y).reduce(0, +) / CGFloat(pts.count))
        }
        var best = 1, bl: CGFloat = -1
        for i in pts.indices.dropFirst() {
            let l = hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
            if l > bl { bl = l; best = i }
        }
        guard pts.count > 1 else { return pts[0] }
        return CGPoint(x: (pts[best - 1].x + pts[best].x) / 2, y: (pts[best - 1].y + pts[best].y) / 2)
    }

    // MARK: 注釈

    static func data(of a: PDFAnnotation) -> MeasureData? {
        guard let s = a.value(forAnnotationKey: key) as? String, let d = s.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(MeasureData.self, from: d)
    }

    static func group(of a: PDFAnnotation) -> String? {
        guard let u = a.userName, u.hasPrefix(groupPrefix) else { return nil }
        return u
    }

    /// 測定の図形（ラベルではない方）
    static func shape(in members: [PDFAnnotation]) -> PDFAnnotation? { members.first { data(of: $0) != nil } }
    static func label(in members: [PDFAnnotation]) -> PDFAnnotation? { members.first { $0.type == "FreeText" && data(of: $0) == nil } }

    /// 新しい測定（図形とラベルの 2 つの注釈）。pts は PDF のページ座標
    static func make(kind: String, points pts: [CGPoint], scale: MeasureScale, color: NSColor, lineWidth: CGFloat) -> (shape: PDFAnnotation, label: PDFAnnotation) {
        let group = groupPrefix + UUID().uuidString
        let subtype: PDFAnnotationSubtype = kind == "distance" ? .line : .ink
        let shape = PDFAnnotation(bounds: CGRect(x: 0, y: 0, width: 1, height: 1), forType: subtype, withProperties: nil)
        shape.userName = group
        shape.color = color
        let b = PDFBorder()
        b.lineWidth = lineWidth
        shape.border = b
        let label = PDFAnnotation(bounds: CGRect(x: 0, y: 0, width: 1, height: 1), forType: .freeText, withProperties: nil)
        label.userName = group
        label.font = NSFont.boldSystemFont(ofSize: labelSize)
        label.fontColor = color
        label.color = NSColor.white.withAlphaComponent(0.85)
        label.alignment = .center
        let lb = PDFBorder()
        lb.lineWidth = 0
        label.border = lb
        apply(kind: kind, points: pts, scale: scale, shape: shape, label: label)
        return (shape, label)
    }

    /// 頂点・縮尺から、図形とラベルを作り直す（その場で書き換える）
    static func apply(kind: String, points pts: [CGPoint], scale: MeasureScale, shape: PDFAnnotation, label: PDFAnnotation) {
        guard let first = pts.first else { return }
        let lw = max(1, shape.border?.lineWidth ?? 1)
        let pad = max(lw * 4, 8)
        var minX = first.x, minY = first.y, maxX = first.x, maxY = first.y
        for p in pts { minX = min(minX, p.x); minY = min(minY, p.y); maxX = max(maxX, p.x); maxY = max(maxY, p.y) }
        let bounds = CGRect(x: minX - pad, y: minY - pad, width: maxX - minX + pad * 2, height: maxY - minY + pad * 2)
        let rel = pts.map { CGPoint(x: $0.x - bounds.minX, y: $0.y - bounds.minY) }
        shape.bounds = bounds
        if kind == "distance", rel.count >= 2 {
            shape.startPoint = rel[0]
            shape.endPoint = rel[1]
            // 両端に寸法線のような短い線
            shape.startLineStyle = .none
            shape.endLineStyle = .none
        } else {
            for p in shape.paths ?? [] { shape.remove(p) }
            let path = NSBezierPath()
            path.move(to: rel[0])
            for p in rel.dropFirst() { path.line(to: p) }
            if kind == "area", rel.count > 2 { path.close() }
            path.lineWidth = lw
            path.lineJoinStyle = .round
            shape.add(path)
        }
        let d = MeasureData(kind: kind, points: rel.map { [Double($0.x), Double($0.y)] }, scale: scale)
        if let json = try? JSONEncoder().encode(d), let s = String(data: json, encoding: .utf8) {
            shape.setValue(s as NSString, forAnnotationKey: key)
        }
        let v = value(kind: kind, points: pts, scale: scale)
        shape.contents = v.text
        // ラベル
        let font = NSFont.boldSystemFont(ofSize: labelSize)
        let size = (v.text as NSString).size(withAttributes: [.font: font])
        let c = labelCenter(kind: kind, points: pts)
        label.contents = v.text
        label.bounds = CGRect(x: c.x - size.width / 2 - 4, y: c.y - size.height / 2 - 2, width: size.width + 8, height: size.height + 4)
    }

    /// 縮尺だけ変える（頂点はそのまま）
    static func rescale(shape: PDFAnnotation, label: PDFAnnotation, to scale: MeasureScale) {
        guard let d = data(of: shape) else { return }
        apply(kind: d.kind, points: absolute(d, origin: shape.bounds.origin), scale: scale, shape: shape, label: label)
    }

    static func kindName(_ kind: String) -> String {
        switch kind {
        case "area": return "面積"
        case "perimeter": return "周長"
        default: return "距離"
        }
    }
}
