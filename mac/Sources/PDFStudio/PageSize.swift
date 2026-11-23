import AppKit
import PDFKit

/// ページの大きさをそろえる（Windows 版と同じ考え方）。
/// ページごとに縦横の向きは元のまま、縦横比を保って用紙の中央に収める。内容はベクターのまま描き直し、
/// 注釈・リンク・しおりの移動先も同じだけ動かす。測定の注釈は実寸が変わらないように縮尺も直す。
/// ページの回転はそのまま残す（回転していないときの向きで計算する）
enum PageSize {
    static let papers: [(name: String, size: CGSize)] = [
        ("A3", CGSize(width: 841.89, height: 1190.55)), ("A4", CGSize(width: 595.28, height: 841.89)),
        ("A5", CGSize(width: 419.53, height: 595.28)), ("B4 (JIS)", CGSize(width: 728.5, height: 1031.81)),
        ("B5 (JIS)", CGSize(width: 515.91, height: 728.5)), ("Letter", CGSize(width: 612, height: 792)),
        ("Legal", CGSize(width: 612, height: 1008)), ("Tabloid", CGSize(width: 792, height: 1224))
    ]

    /// 回転していないときの座標で、元のページの点を新しいページの点へ移す変換と、新しいページの大きさ
    static func plan(_ page: PDFPage, paper: CGSize, onlyShrink: Bool) -> (transform: CGAffineTransform, size: CGSize, scale: CGFloat)? {
        let crop = page.bounds(for: .cropBox)
        guard crop.width > 0, crop.height > 0 else { return nil }
        let turned = (page.rotation / 90) % 2 != 0
        // 見た目の向き（回転後）に用紙を合わせ、回転していないときの向きに戻す
        let viewW = turned ? crop.height : crop.width, viewH = turned ? crop.width : crop.height
        let short = min(paper.width, paper.height), long = max(paper.width, paper.height)
        let target = viewW > viewH ? CGSize(width: long, height: short) : CGSize(width: short, height: long)
        let size = turned ? CGSize(width: target.height, height: target.width) : target
        var s = min(size.width / crop.width, size.height / crop.height)
        if onlyShrink && s >= 1 { s = 1 }
        // 大きさも置き場所も変わらないなら何もしない
        if abs(size.width - crop.width) < 0.5 && abs(size.height - crop.height) < 0.5 && crop.origin == .zero { return nil }
        if onlyShrink && s >= 1 && abs(size.width - crop.width) < 0.5 && abs(size.height - crop.height) < 0.5 { return nil }
        let ox = (size.width - crop.width * s) / 2, oy = (size.height - crop.height * s) / 2
        let t = CGAffineTransform(translationX: ox, y: oy).scaledBy(x: s, y: s).translatedBy(x: -crop.minX, y: -crop.minY)
        return (t, size, s)
    }

    /// 内容だけを新しい大きさのページに描き直す（注釈はあとで移す）
    static func redraw(_ page: PDFPage, transform: CGAffineTransform, size: CGSize) -> PDFPage? {
        var box = CGRect(origin: .zero, size: size)
        let data = NSMutableData()
        guard let cg = page.pageRef, let consumer = CGDataConsumer(data: data as CFMutableData),
              let ctx = CGContext(consumer: consumer, mediaBox: &box, nil) else { return nil }
        ctx.beginPage(mediaBox: &box)
        ctx.saveGState()
        ctx.concatenate(transform)
        // 切り抜きの外は描かない（元の表示と同じ範囲だけ）
        ctx.clip(to: page.bounds(for: .cropBox))
        ctx.drawPDFPage(cg)
        ctx.restoreGState()
        ctx.endPage()
        ctx.closePDF()
        guard let tmp = PDFDocument(data: data as Data), let p = tmp.page(at: 0) else { return nil }
        p.rotation = page.rotation
        return p
    }

    private static func scaleRect(_ r: CGRect, _ t: CGAffineTransform) -> CGRect { r.applying(t).standardized }

    /// 注釈を変換に合わせて動かす（注釈の中の点は bounds の左下からの位置なので、倍率だけ掛ける）
    static func move(_ a: PDFAnnotation, _ t: CGAffineTransform, _ s: CGFloat) {
        let type = a.type ?? ""
        let start = a.startPoint, end = a.endPoint
        let quads = a.quadrilateralPoints
        let paths = a.paths
        a.bounds = scaleRect(a.bounds, t)
        if let b = a.border, b.lineWidth > 0 { let nb = PDFBorder(); nb.lineWidth = b.lineWidth * s; nb.style = b.style; nb.dashPattern = b.dashPattern; a.border = nb }
        switch type {
        case "Line":
            a.startPoint = CGPoint(x: start.x * s, y: start.y * s)
            a.endPoint = CGPoint(x: end.x * s, y: end.y * s)
        case "Ink":
            for p in paths ?? [] { a.remove(p) }
            for p in paths ?? [] {
                let np = NSBezierPath()
                np.append(p)
                np.transform(using: AffineTransform(scaleByX: s, byY: s))
                np.lineWidth = p.lineWidth * s
                a.add(np)
            }
        case "FreeText":
            if let f = a.font { a.font = NSFont(descriptor: f.fontDescriptor, size: f.pointSize * s) ?? f }
        default: break
        }
        if let q = quads, !q.isEmpty {
            a.quadrilateralPoints = q.map { NSValue(point: NSPoint(x: $0.pointValue.x * s, y: $0.pointValue.y * s)) }
        }
        if let popup = a.popup { popup.bounds = scaleRect(popup.bounds, t) }
    }

    struct Result { var changed = 0; var forms = false }

    /// 指定のページの大きさをそろえる（文書をその場で変える）
    @discardableResult
    static func normalize(_ doc: PDFDocument, pages: [Int], paper: CGSize, onlyShrink: Bool) -> Result {
        var result = Result()
        // リンクとしおりの移動先は、ページを外す前にページの番号で控える
        let records = Compositor.recordDestinations(doc)
        var transforms: [Int: CGAffineTransform] = [:]
        // 元のページは最後まで持っておく（解放されると、後から作るページと同じ番号になることがある）
        var originals: [PDFPage] = []
        for i in pages {
            guard let page = doc.page(at: i), let plan = plan(page, paper: paper, onlyShrink: onlyShrink),
                  let np = redraw(page, transform: plan.transform, size: plan.size) else { continue }
            let annots = page.annotations
            if annots.contains(where: { $0.type == "Widget" }) { result.forms = true }
            // 測定は図形とラベルの組で直す（ほかの注釈と同じには動かさない）
            var measures: [(shape: PDFAnnotation, label: PDFAnnotation?, data: MeasureData)] = []
            var inMeasure = Set<ObjectIdentifier>()
            for a in annots {
                guard let d = Measure.data(of: a) else { continue }
                let label = Measure.group(of: a).flatMap { g in annots.first { $0 !== a && Measure.group(of: $0) == g && $0.type == "FreeText" } }
                measures.append((a, label, d))
                inMeasure.insert(ObjectIdentifier(a))
                if let label { inMeasure.insert(ObjectIdentifier(label)) }
            }
            // ポップアップ：一覧にある本物と、親が持つものが別のオブジェクトのことがある（親が持つものは仮の枠）。
            // 本物を親に付け直してから動かす（そのままだと保存したときに 2 つになったり、位置がずれたりする）
            let pops = annots.filter { $0.type == "Popup" }
            let owners = annots.filter { $0.popup != nil && $0.type != "Popup" }
            var pairs: [(owner: PDFAnnotation, pop: PDFAnnotation)] = []
            for pop in pops {
                let parent = (pop.value(forAnnotationKey: .parent) as? PDFAnnotation).flatMap { p in owners.first { $0 === p } }
                    ?? (owners.count == 1 && pops.count == 1 ? owners[0] : nil)
                if let parent { pairs.append((parent, pop)) }
            }
            for pr in pairs { pr.owner.popup = nil }
            for a in annots {
                page.removeAnnotation(a)
                if !inMeasure.contains(ObjectIdentifier(a)) { move(a, plan.transform, plan.scale) }
                np.addAnnotation(a)
            }
            for pr in pairs { pr.owner.popup = pr.pop }
            for m in measures {
                let pts = Measure.absolute(m.data, origin: m.shape.bounds.origin).map { $0.applying(plan.transform) }
                var sc = m.data.scale
                // 1pt あたりの実寸を直して、測った長さ（実寸）を変えない
                sc.factor /= Double(plan.scale)
                if let r = sc.ratio { sc.ratio = r / Double(plan.scale); sc.label = "1:" + String(format: "%g", (r / Double(plan.scale) * 100).rounded() / 100) }
                // ラベルを消した測定も、図形と測定の情報を同じように直す（ラベルは作るだけで使わない）
                let label = m.label ?? PDFAnnotation(bounds: CGRect(x: 0, y: 0, width: 1, height: 1), forType: .freeText, withProperties: nil)
                Measure.apply(kind: m.data.kind, points: pts, scale: sc, shape: m.shape, label: label)
            }
            transforms[i] = plan.transform
            originals.append(page)
            doc.removePage(at: i)
            doc.insert(np, at: i)
            result.changed += 1
        }
        guard !transforms.isEmpty else { return result }
        // 移動先（リンク・しおり）を新しいページと位置に直す
        Compositor.restoreDestinations(records, in: doc, transforms: transforms)
        withExtendedLifetime(originals) {}
        return result
    }
}
