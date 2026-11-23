import AppKit
import PDFKit

/// ページの作り直し（内容の上に描画を重ねる／ラスタライズする）と、保存用の書き出しを担当
enum Compositor {
    /// ページを新しく作り直す。元の内容（ベクター）または画像化した内容の上に overlay を描く。
    /// 元ページの注釈は keepAnnotation が true のものだけ新ページへ移す。
    static func rebuild(_ page: PDFPage,
                        rasterizeDPI: CGFloat? = nil,
                        keepAnnotation: (PDFAnnotation) -> Bool = { _ in true },
                        overlay: (CGContext, PDFPage) -> Void) -> PDFPage? {
        var box = page.bounds(for: .mediaBox)
        let data = NSMutableData()
        guard let consumer = CGDataConsumer(data: data as CFMutableData),
              let ctx = CGContext(consumer: consumer, mediaBox: &box, nil) else { return nil }
        ctx.beginPage(mediaBox: &box)
        if let dpi = rasterizeDPI {
            if let img = Render.pageContent(page, dpi: dpi) {
                ctx.interpolationQuality = .high
                ctx.draw(img, in: box)
            }
        } else if let cg = page.pageRef {
            ctx.saveGState()
            ctx.drawPDFPage(cg)
            ctx.restoreGState()
        }
        ctx.saveGState()
        overlay(ctx, page)
        ctx.restoreGState()
        ctx.endPage()
        ctx.closePDF()

        guard let tmp = PDFDocument(data: data as Data), let newPage = tmp.page(at: 0) else { return nil }
        for b in [PDFDisplayBox.cropBox, .bleedBox, .trimBox, .artBox] {
            newPage.setBounds(page.bounds(for: b), for: b)
        }
        newPage.rotation = page.rotation
        for a in page.annotations {
            page.removeAnnotation(a)
            if keepAnnotation(a) { newPage.addAnnotation(a) }
        }
        return newPage
    }

    /// しおりを変えた印。PDFKit は、読み込んだ文書のしおりを変えても保存に反映しない（元のしおりのまま書き出す）ので、
    /// 印のある文書はページを複製した新しい文書にしおりを作り直して保存する
    private static var outlineEditedKey = 0
    static func markOutlineEdited(_ doc: PDFDocument) {
        objc_setAssociatedObject(doc, &outlineEditedKey, true, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
    }
    static func outlineEdited(_ doc: PDFDocument) -> Bool { (objc_getAssociatedObject(doc, &outlineEditedKey) as? Bool) ?? false }

    /// リンク・しおりの移動先を、ページの番号で控えたもの。
    /// 読み込んだ文書では、ページを外すとそのページを指す移動先のページが消える（nil になる）ので、外す前に控えておく
    struct DestinationRecord {
        let index: Int
        let point: CGPoint
        let zoom: CGFloat
        let isOutline: Bool
        let set: (PDFDestination) -> Void
    }

    static func recordDestinations(_ doc: PDFDocument, extraPages: [PDFPage] = []) -> [DestinationRecord] {
        var out: [DestinationRecord] = []
        func add(_ d: PDFDestination?, outline: Bool = false, _ set: @escaping (PDFDestination) -> Void) {
            guard let d, let page = d.page else { return }
            let i = doc.index(for: page)
            guard i != NSNotFound else { return }
            out.append(DestinationRecord(index: i, point: d.point, zoom: d.zoom, isOutline: outline, set: set))
        }
        // 文書のページのリンクと、まだ文書に入っていないページ（差し替える新しいページ）のリンク
        let extra = extraPages.flatMap { $0.annotations }
        for a in (0..<doc.pageCount).flatMap({ doc.page(at: $0)?.annotations ?? [] }) + extra where a.type == "Link" {
            add(a.destination ?? (a.action as? PDFActionGoTo)?.destination) { nd in
                if a.destination != nil { a.destination = nd }
                if a.action is PDFActionGoTo || a.destination == nil { a.action = PDFActionGoTo(destination: nd) }
            }
        }
        func walk(_ o: PDFOutline) {
            add(o.destination ?? (o.action as? PDFActionGoTo)?.destination, outline: true) { nd in
                o.destination = nd
                if o.action is PDFActionGoTo { o.action = PDFActionGoTo(destination: nd) }
            }
            for k in 0..<o.numberOfChildren { if let c = o.child(at: k) { walk(c) } }
        }
        if let root = doc.outlineRoot { walk(root) }
        return out
    }

    /// 控えた移動先のうち、差し替えたページを指すものを新しいページと位置に直す（transform：元のページの点 → 新しいページの点）
    static func restoreDestinations(_ records: [DestinationRecord], in doc: PDFDocument, transforms: [Int: CGAffineTransform]) {
        let unspecified = kPDFDestinationUnspecifiedValue
        var outlineFixed = false
        for r in records {
            guard let t = transforms[r.index], let page = doc.page(at: r.index) else { continue }
            // 位置が変わるときだけ印が要る（同じ位置のままなら、PDFKit の普通の保存でしおりは正しく残る）
            if r.isOutline && !t.isIdentity { outlineFixed = true }
            let p = r.point
            let q = CGPoint(x: p.x == unspecified ? 0 : p.x, y: p.y == unspecified ? 0 : p.y).applying(t)
            let nd = PDFDestination(page: page, at: CGPoint(x: p.x == unspecified ? unspecified : q.x, y: p.y == unspecified ? unspecified : q.y))
            nd.zoom = r.zoom
            r.set(nd)
        }
        // しおりの位置を実際に変えたときだけ印を付ける（印があると保存が複製の経路になり、フォームなどが失われる）
        if outlineFixed { markOutlineEdited(doc) }
    }

    /// ページを並べ替える（rows のページを row の前へ）。外して入れ直すと移動先のページが消えるので、
    /// 外す前に控えて、同じページへ付け直す（位置は変わらないので、しおりを変えた印は付けない）
    /// 戻り値：動かしたページの新しい先頭の位置
    @discardableResult
    static func movePages(in doc: PDFDocument, rows: [Int], to row: Int) -> Int {
        let rows = rows.sorted()
        let moved = Set(rows)
        var pagesByIndex: [Int: PDFPage] = [:]
        for r in rows { pagesByIndex[r] = doc.page(at: r) }
        let records = recordDestinations(doc).filter { moved.contains($0.index) }
        let pages = rows.compactMap { doc.page(at: $0) }
        for r in rows.reversed() { doc.removePage(at: r) }
        let target = row - rows.filter { $0 < row }.count
        for (k, p) in pages.enumerated() { doc.insert(p, at: target + k) }
        for rec in records {
            guard let page = pagesByIndex[rec.index], doc.index(for: page) != NSNotFound else { continue }
            let nd = PDFDestination(page: page, at: rec.point)
            nd.zoom = rec.zoom
            rec.set(nd)
        }
        return target
    }

    /// ページを差し替え、リンクとしおりの移動先も新しいページへ付け替える
    static func replacePage(in doc: PDFDocument, at index: Int, with newPage: PDFPage) {
        guard doc.page(at: index) != nil else { return }
        // 新しいページへ先に移された注釈（同じページを指すリンク）も、外す前に控える
        let records = recordDestinations(doc, extraPages: [newPage]).filter { $0.index == index }
        doc.removePage(at: index)
        doc.insert(newPage, at: index)
        restoreDestinations(records, in: doc, transforms: [index: .identity])
    }

    /// 保存用データを作る。画像スタンプはページ内容に焼き込み、その他の注釈は注釈のまま残す。
    static func serialize(_ doc: PDFDocument, options: [PDFDocumentWriteOption: Any] = [:]) -> Data? {
        // 画像・スタンプの注釈（ImageStamp）は、読み込んだ文書のページに付けたままだと保存で落ちる（PDFKit の制限）。
        // ページを複製した新しい文書で保存して、注釈のまま残す（あとで動かせる）。
        // 複製するとフォームの設定（/AcroForm）とページラベルは失われる。ページに焼き込む方法（以前の版）でも
        // ページを差し替えるので同じく失われるため、注釈のまま残せるこの方法にしている（置くときに知らせる）
        var stamps: [Int: [PDFAnnotation]] = [:]
        for i in 0..<doc.pageCount {
            guard let p = doc.page(at: i) else { continue }
            let s = p.annotations.filter { $0 is ImageStampAnnotation }
            if !s.isEmpty { stamps[i] = s }
        }

        var target = doc
        if !stamps.isEmpty {
            // スタンプを一時的に外して素のデータを作る
            for (i, list) in stamps { list.forEach { doc.page(at: i)?.removeAnnotation($0) } }
            let raw = doc.dataRepresentation()
            for (i, list) in stamps { list.forEach { doc.page(at: i)?.addAnnotation($0) } }
            guard let raw, let out = PDFDocument(data: raw) else { return nil }
            for (i, list) in stamps {
                guard let page = out.page(at: i),
                      let np = rebuild(page, overlay: { ctx, _ in
                          for a in list {
                              ctx.saveGState()
                              if let s = a as? ImageStampAnnotation { s.drawBaked(in: ctx) } else { a.draw(with: .mediaBox, in: ctx) }
                              ctx.restoreGState()
                          }
                      }) else { continue }
                replacePage(in: out, at: i, with: np)
            }
            out.documentAttributes = doc.documentAttributes
            target = out
        }
        let hasImageStamps = (0..<target.pageCount).contains { i in target.page(at: i)?.annotations.contains(where: ImageStamp.isImageStamp) ?? false }
        let edited = outlineEdited(doc) || outlineEdited(target)
        if hasImageStamps || edited {
            let out = PDFDocument()
            var map: [ObjectIdentifier: PDFPage] = [:]
            for i in 0..<target.pageCount {
                guard let p = target.page(at: i), let c = p.copy() as? PDFPage else { continue }
                out.insert(c, at: out.pageCount)
                map[ObjectIdentifier(p)] = c
                // しおりは元の文書（編集したもの）から写すので、元の文書のページも同じページに対応させる
                if let dp = doc.page(at: i) { map[ObjectIdentifier(dp)] = c }
            }
            out.documentAttributes = target.documentAttributes
            if let root = outlineEdited(doc) ? doc.outlineRoot : target.outlineRoot { out.outlineRoot = copyOutline(root, map) }
            // 複製したページのリンクは、元の文書のページを指したままなので、複製したページへ付け替える
            for i in 0..<out.pageCount {
                for a in out.page(at: i)?.annotations ?? [] where a.type == "Link" {
                    guard let d = a.destination ?? (a.action as? PDFActionGoTo)?.destination, let pg = d.page,
                          let np = map[ObjectIdentifier(pg)], np !== pg else { continue }
                    let nd = PDFDestination(page: np, at: d.point)
                    nd.zoom = d.zoom
                    if a.destination != nil { a.destination = nd }
                    if a.action is PDFActionGoTo || a.destination == nil { a.action = PDFActionGoTo(destination: nd) }
                }
            }
            target = out
        }
        return write(target, options: options)
    }

    /// フォームの欄、または「1, 2, 3…」以外のページラベルがあるか（ページを複製すると失われるもの）
    static func hasFormOrPageLabels(_ doc: PDFDocument) -> Bool {
        for i in 0..<doc.pageCount {
            guard let p = doc.page(at: i) else { continue }
            if let l = p.label, l != String(i + 1) { return true }
            if p.annotations.contains(where: { $0.type == "Widget" }) { return true }
        }
        return false
    }

    /// しおりを複製し、行き先のページを複製したページにする
    private static func copyOutline(_ o: PDFOutline, _ map: [ObjectIdentifier: PDFPage]) -> PDFOutline {
        let n = PDFOutline()
        n.label = o.label
        n.isOpen = o.isOpen
        if let d = o.destination, let p = d.page, let np = map[ObjectIdentifier(p)] {
            let nd = PDFDestination(page: np, at: d.point)
            nd.zoom = d.zoom
            n.destination = nd
        } else if let a = o.action, !(a is PDFActionGoTo) {
            n.action = a   // ほかのファイルへの移動・URL・名前付きの操作などはそのまま
        }
        for i in 0..<o.numberOfChildren {
            if let c = o.child(at: i) { n.insertChild(copyOutline(c, map), at: n.numberOfChildren) }
        }
        return n
    }

    static func write(_ doc: PDFDocument, options: [PDFDocumentWriteOption: Any]) -> Data? {
        if options.isEmpty { return doc.dataRepresentation() }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("pdfstudio-\(UUID().uuidString).pdf")
        defer { try? FileManager.default.removeItem(at: url) }
        guard doc.write(to: url, withOptions: options) else { return nil }
        return try? Data(contentsOf: url)
    }

    /// 墨消しを適用：マークのあるページを画像化して黒塗りし、下にあった文字情報を完全に除去する
    @discardableResult
    static func applyRedactions(_ doc: PDFDocument, dpi: CGFloat = 200) -> Int {
        var count = 0
        for i in 0..<doc.pageCount {
            guard let page = doc.page(at: i) else { continue }
            let marks = page.annotations.filter(AnnotationMarker.isRedaction)
            if marks.isEmpty { continue }
            let rects = marks.map(\.bounds)
            let np = rebuild(page, rasterizeDPI: dpi, keepAnnotation: { a in
                !AnnotationMarker.isRedaction(a) && !rects.contains(where: { $0.intersects(a.bounds) })
            }, overlay: { ctx, _ in
                ctx.setFillColor(NSColor.black.cgColor)
                rects.forEach { ctx.fill($0) }
            })
            if let np { replacePage(in: doc, at: i, with: np); count += 1 }
        }
        return count
    }

    /// すべての注釈をページ内容に焼き込む（フラット化）。リンクだけは注釈のまま残す。
    static func flattenInPlace(_ doc: PDFDocument) {
        for i in 0..<doc.pageCount {
            guard let page = doc.page(at: i) else { continue }
            let anns = page.annotations.filter { $0.type != "Link" && $0.type != "Popup" }
            if anns.isEmpty { continue }
            let np = rebuild(page, keepAnnotation: { $0.type == "Link" }, overlay: { ctx, _ in
                for a in anns {
                    ctx.saveGState()
                    if let s = a as? ImageStampAnnotation { s.drawBaked(in: ctx) } else { a.draw(with: .mediaBox, in: ctx) }
                    ctx.restoreGState()
                }
            })
            if let np { replacePage(in: doc, at: i, with: np) }
        }
    }
}
