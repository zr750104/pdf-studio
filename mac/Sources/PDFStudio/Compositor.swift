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

    /// ページを差し替え、しおりのリンク先も新しいページへ付け替える
    static func replacePage(in doc: PDFDocument, at index: Int, with newPage: PDFPage) {
        guard let old = doc.page(at: index) else { return }
        doc.removePage(at: index)
        doc.insert(newPage, at: index)
        if let root = doc.outlineRoot { remap(root, from: old, to: newPage); markOutlineEdited(doc) }
    }

    private static func remap(_ outline: PDFOutline, from old: PDFPage, to new: PDFPage) {
        if let d = outline.destination, d.page === old {
            outline.destination = PDFDestination(page: new, at: d.point)
        }
        for i in 0..<outline.numberOfChildren {
            if let c = outline.child(at: i) { remap(c, from: old, to: new) }
        }
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
        let edited = outlineEdited(doc)
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
            if let root = edited ? doc.outlineRoot : target.outlineRoot { out.outlineRoot = copyOutline(root, map) }
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
            n.destination = PDFDestination(page: np, at: d.point)
        } else if let a = o.action as? PDFActionURL {
            n.action = a
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
