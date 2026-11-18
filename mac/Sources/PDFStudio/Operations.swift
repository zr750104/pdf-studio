import AppKit
import PDFKit
import Vision
import CoreText

/// 文書全体に対する処理（UI に依存しない）
enum Operations {

    // MARK: 透かし

    struct WatermarkOptions {
        var text = "社外秘"
        var fontSize: CGFloat = 72
        var color = NSColor.red
        var opacity: CGFloat = 0.25
        var angle: CGFloat = 45
        var behind = false
    }

    static func addWatermark(_ doc: PDFDocument, pages: [Int], _ o: WatermarkOptions) {
        for i in pages {
            guard let page = doc.page(at: i) else { continue }
            let np = Compositor.rebuild(page) { ctx, p in
                let size = DisplaySpace.size(of: p)
                ctx.concatenate(DisplaySpace.transform(for: p))
                ctx.translateBy(x: size.width / 2, y: size.height / 2)
                ctx.rotate(by: o.angle * .pi / 180)
                ctx.setAlpha(o.opacity)
                let line = makeLine(o.text, font: jpFont(bold: true, size: o.fontSize), color: o.color)
                let w = CTLineGetTypographicBounds(line, nil, nil, nil)
                ctx.textPosition = CGPoint(x: -w / 2, y: -o.fontSize * 0.35)
                CTLineDraw(line, ctx)
            }
            if let np { Compositor.replacePage(in: doc, at: i, with: np) }
        }
    }

    // MARK: ヘッダー・フッター / ページ番号 / ベイツ番号

    struct HeaderFooterOptions {
        var headerLeft = "", headerCenter = "", headerRight = ""
        var footerLeft = "", footerCenter = "{page} / {total}", footerRight = ""
        var fontSize: CGFloat = 10
        var color = NSColor.black
        var margin: CGFloat = 28
        var startNumber = 1
    }

    static func expand(_ s: String, page: Int, total: Int, start: Int) -> String {
        s.replacingOccurrences(of: "{page}", with: String(page + start))
            .replacingOccurrences(of: "{total}", with: String(total + start - 1))
            .replacingOccurrences(of: "{date}", with: StampRenderer.dateString())
    }

    static func addHeaderFooter(_ doc: PDFDocument, pages: [Int], _ o: HeaderFooterOptions) {
        let total = pages.count
        for (n, i) in pages.enumerated() {
            guard let page = doc.page(at: i) else { continue }
            let np = Compositor.rebuild(page) { ctx, p in
                let size = DisplaySpace.size(of: p)
                ctx.concatenate(DisplaySpace.transform(for: p))
                let font = jpFont(bold: false, size: o.fontSize)
                let topY = size.height - o.margin
                let botY = o.margin - o.fontSize * 0.3
                let items: [(String, Int, CGFloat)] = [
                    (o.headerLeft, 0, topY), (o.headerCenter, 1, topY), (o.headerRight, 2, topY),
                    (o.footerLeft, 0, botY), (o.footerCenter, 1, botY), (o.footerRight, 2, botY)
                ]
                for (text, align, y) in items where !text.isEmpty {
                    let line = makeLine(expand(text, page: n, total: total, start: o.startNumber), font: font, color: o.color)
                    let w = CTLineGetTypographicBounds(line, nil, nil, nil)
                    let x: CGFloat = align == 0 ? o.margin : (align == 1 ? (size.width - w) / 2 : size.width - o.margin - w)
                    ctx.textPosition = CGPoint(x: x, y: y)
                    CTLineDraw(line, ctx)
                }
            }
            if let np { Compositor.replacePage(in: doc, at: i, with: np) }
        }
    }

    // MARK: OCR（テキスト認識して検索可能にする）

    struct OCRLine { let text: String; let rect: CGRect }

    static func recognize(_ page: PDFPage, languages: [String] = ["ja-JP", "en-US"]) throws -> [OCRLine] {
        let dpi: CGFloat = 300
        guard let img = Render.pageContent(page, dpi: dpi) else { return [] }
        let req = VNRecognizeTextRequest()
        req.recognitionLevel = .accurate
        req.recognitionLanguages = languages
        req.usesLanguageCorrection = true
        try VNImageRequestHandler(cgImage: img, options: [:]).perform([req])
        let box = page.bounds(for: .mediaBox)
        return (req.results ?? []).compactMap { obs in
            guard let t = obs.topCandidates(1).first?.string, !t.isEmpty else { return nil }
            let b = obs.boundingBox
            let r = CGRect(x: box.minX + b.minX * box.width, y: box.minY + b.minY * box.height,
                           width: b.width * box.width, height: b.height * box.height)
            return OCRLine(text: t, rect: r)
        }
    }

    /// 認識結果を透明テキストとしてページに重ねる
    static func applyOCR(_ doc: PDFDocument, index: Int, lines: [OCRLine]) {
        guard let page = doc.page(at: index), !lines.isEmpty else { return }
        let np = Compositor.rebuild(page) { ctx, _ in
            ctx.setTextDrawingMode(.invisible)
            for l in lines {
                let size = max(4, l.rect.height * 0.85)
                let line = makeLine(l.text, font: jpFont(bold: false, size: size), color: .black)
                let w = CTLineGetTypographicBounds(line, nil, nil, nil)
                ctx.saveGState()
                ctx.translateBy(x: l.rect.minX, y: l.rect.minY + l.rect.height * 0.18)
                if w > 0 { ctx.scaleBy(x: l.rect.width / w, y: 1) }
                ctx.textPosition = .zero
                CTLineDraw(line, ctx)
                ctx.restoreGState()
            }
        }
        if let np { Compositor.replacePage(in: doc, at: index, with: np) }
    }

    static func pageHasText(_ page: PDFPage) -> Bool {
        !(page.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    // MARK: テキスト描画ヘルパー

    static func jpFont(bold: Bool, size: CGFloat) -> CTFont {
        CTFontCreateWithName((bold ? "HiraginoSans-W6" : "HiraginoSans-W3") as CFString, size, nil)
    }

    static func makeLine(_ s: String, font: CTFont, color: NSColor) -> CTLine {
        let attr = NSAttributedString(string: s, attributes: [
            NSAttributedString.Key(kCTFontAttributeName as String): font,
            NSAttributedString.Key(kCTForegroundColorAttributeName as String): color.cgColor
        ])
        return CTLineCreateWithAttributedString(attr)
    }

    // MARK: 書き出し

    static func exportImages(_ doc: PDFDocument, to folder: URL, baseName: String, jpeg: Bool, dpi: CGFloat) throws -> Int {
        var n = 0
        for i in 0..<doc.pageCount {
            guard let page = doc.page(at: i) else { continue }
            let img = Render.pageAsDisplayed(page, dpi: dpi)
            guard let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) else { continue }
            let data = jpeg ? rep.representation(using: .jpeg, properties: [.compressionFactor: 0.88])
                            : rep.representation(using: .png, properties: [:])
            let url = folder.appendingPathComponent(String(format: "%@_%03d.%@", baseName, i + 1, jpeg ? "jpg" : "png"))
            try data?.write(to: url)
            n += 1
        }
        return n
    }

    static func attributedText(_ doc: PDFDocument) -> NSAttributedString {
        let out = NSMutableAttributedString()
        for i in 0..<doc.pageCount {
            guard let page = doc.page(at: i) else { continue }
            if let a = page.attributedString { out.append(a) }
            if i < doc.pageCount - 1 { out.append(NSAttributedString(string: "\n\u{000C}")) }
        }
        return out
    }

    static func exportWord(_ doc: PDFDocument, to url: URL) throws {
        let a = attributedText(doc)
        let data = try a.data(from: NSRange(location: 0, length: a.length),
                              documentAttributes: [.documentType: NSAttributedString.DocumentType.officeOpenXML])
        try data.write(to: url)
    }

    static func exportRTF(_ doc: PDFDocument, to url: URL) throws {
        let a = attributedText(doc)
        let data = try a.data(from: NSRange(location: 0, length: a.length),
                              documentAttributes: [.documentType: NSAttributedString.DocumentType.rtf])
        try data.write(to: url)
    }

    static func exportText(_ doc: PDFDocument, to url: URL) throws {
        try (doc.string ?? "").write(to: url, atomically: true, encoding: .utf8)
    }

    // MARK: 作成（画像・文書ファイル → PDF）

    static let a4 = CGSize(width: 595.28, height: 841.89)

    static func createPDF(from urls: [URL]) -> PDFDocument {
        let out = PDFDocument()
        for url in urls {
            let ext = url.pathExtension.lowercased()
            if ext == "pdf", let d = PDFDocument(url: url) {
                for i in 0..<d.pageCount { if let p = d.page(at: i) { out.insert(p, at: out.pageCount) } }
            } else if let img = NSImage(contentsOf: url), ["png", "jpg", "jpeg", "heic", "tif", "tiff", "gif", "bmp", "webp"].contains(ext) {
                if let p = PDFPage(image: img) { out.insert(p, at: out.pageCount) }
            } else if let attr = try? NSAttributedString(url: url, options: [:], documentAttributes: nil),
                      let d = paginate(attr) {
                for i in 0..<d.pageCount { if let p = d.page(at: i) { out.insert(p, at: out.pageCount) } }
            }
        }
        return out
    }

    /// 文字列を A4 ページに流し込んで PDF にする
    static func paginate(_ attr: NSAttributedString, pageSize: CGSize = a4, margin: CGFloat = 56) -> PDFDocument? {
        let text = NSMutableAttributedString(attributedString: attr)
        // フォント未指定部分に日本語フォントを補う
        text.enumerateAttribute(.font, in: NSRange(location: 0, length: text.length)) { v, r, _ in
            if v == nil { text.addAttribute(.font, value: NSFont(name: "HiraginoSans-W3", size: 11) ?? NSFont.systemFont(ofSize: 11), range: r) }
        }
        text.enumerateAttribute(.foregroundColor, in: NSRange(location: 0, length: text.length)) { v, r, _ in
            let c = (v as? NSColor) ?? NSColor.black
            text.addAttribute(NSAttributedString.Key(kCTForegroundColorAttributeName as String), value: c.cgColor, range: r)
        }
        let data = NSMutableData()
        var box = CGRect(origin: .zero, size: pageSize)
        guard let consumer = CGDataConsumer(data: data as CFMutableData),
              let ctx = CGContext(consumer: consumer, mediaBox: &box, nil) else { return nil }
        let fs = CTFramesetterCreateWithAttributedString(text)
        var start = 0
        repeat {
            ctx.beginPage(mediaBox: &box)
            let path = CGPath(rect: box.insetBy(dx: margin, dy: margin), transform: nil)
            let frame = CTFramesetterCreateFrame(fs, CFRange(location: start, length: 0), path, nil)
            CTFrameDraw(frame, ctx)
            let r = CTFrameGetVisibleStringRange(frame)
            ctx.endPage()
            if r.length == 0 { break }
            start += r.length
        } while start < text.length
        ctx.closePDF()
        return PDFDocument(data: data as Data)
    }

    // MARK: - ファイルサイズの縮小

    /// 縮小した PDF のデータ。元より小さくならなければ nil。
    /// strong = false：保存方法を何通りか試し、いちばん小さいものを選ぶ（文字はそのまま）
    /// strong = true：ページを JPEG の画像にする（文字は画像になり、検索・コピーできなくなる）
    static func optimize(_ doc: PDFDocument, original: Int, strong: Bool, dpi: CGFloat = 120, quality: CGFloat = 0.7,
                         options: [PDFDocumentWriteOption: Any] = [:]) -> Data? {
        var candidates: [Data] = []
        if strong {
            if let d = rasterize(doc, dpi: dpi, quality: quality), let re = PDFDocument(data: d) {
                re.documentAttributes = doc.documentAttributes
                if let out = Compositor.write(re, options: options) { candidates.append(out) }
            }
        } else {
            if let d = Compositor.serialize(doc, options: options) { candidates.append(d) }
            var o = options
            o[.saveImagesAsJPEGOption] = true
            if let d = Compositor.serialize(doc, options: o) { candidates.append(d) }
            o[.optimizeImagesForScreenOption] = true
            if let d = Compositor.serialize(doc, options: o) { candidates.append(d) }
        }
        guard let best = candidates.min(by: { $0.count < $1.count }), best.count < original else { return nil }
        return best
    }

    /// 各ページを画像（JPEG）にした PDF。JPEG のデータはそのまま PDF に入る
    static func rasterize(_ doc: PDFDocument, dpi: CGFloat, quality: CGFloat) -> Data? {
        let out = NSMutableData()
        guard let consumer = CGDataConsumer(data: out as CFMutableData),
              let ctx = CGContext(consumer: consumer, mediaBox: nil, nil) else { return nil }
        for i in 0..<doc.pageCount {
            guard let page = doc.page(at: i) else { continue }
            autoreleasepool {
                let img = Render.pageAsDisplayed(page, dpi: dpi)
                guard let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
                      let jpeg = rep.representation(using: .jpeg, properties: [.compressionFactor: quality]),
                      let src = CGImageSourceCreateWithData(jpeg as CFData, nil),
                      let cg = CGImageSourceCreateImageAtIndex(src, 0, nil) else { return }
                // 画面に見えている向き・大きさのページにする
                let crop = page.bounds(for: .cropBox)
                var size = crop.size
                if page.rotation % 180 != 0 { size = CGSize(width: size.height, height: size.width) }
                var box = CGRect(origin: .zero, size: size)
                ctx.beginPage(mediaBox: &box)
                ctx.draw(cg, in: box)
                ctx.endPage()
            }
        }
        ctx.closePDF()
        return out as Data
    }

    static func blankPage(size: CGSize = a4) -> PDFPage? {
        let data = NSMutableData()
        var box = CGRect(origin: .zero, size: size)
        guard let consumer = CGDataConsumer(data: data as CFMutableData),
              let ctx = CGContext(consumer: consumer, mediaBox: &box, nil) else { return nil }
        ctx.beginPage(mediaBox: &box)
        ctx.endPage()
        ctx.closePDF()
        return PDFDocument(data: data as Data)?.page(at: 0)
    }

    // MARK: 分割・抽出

    static func extract(_ doc: PDFDocument, pages: [Int]) -> PDFDocument {
        let out = PDFDocument()
        for i in pages {
            if let p = doc.page(at: i)?.copy() as? PDFPage { out.insert(p, at: out.pageCount) }
        }
        return out
    }

    static func split(_ doc: PDFDocument, groups: [[Int]], folder: URL, baseName: String) throws -> Int {
        guard let data = Compositor.serialize(doc), let src = PDFDocument(data: data) else {
            throw StudioError.message("文書の書き出しに失敗しました")
        }
        for (n, g) in groups.enumerated() {
            let part = extract(src, pages: g)
            let url = folder.appendingPathComponent(String(format: "%@_part%02d.pdf", baseName, n + 1))
            guard part.write(to: url) else { throw StudioError.message("\(url.lastPathComponent) を保存できませんでした") }
        }
        return groups.count
    }

    // MARK: 比較

    /// 2 つの文書のテキストをページごとに比較し、差分を色付きで返す
    static func compare(_ a: PDFDocument, _ b: PDFDocument) -> NSAttributedString {
        let out = NSMutableAttributedString()
        let base: [NSAttributedString.Key: Any] = [.font: NSFont.monospacedSystemFont(ofSize: 12, weight: .regular), .foregroundColor: NSColor.labelColor]
        let head: [NSAttributedString.Key: Any] = [.font: NSFont.boldSystemFont(ofSize: 14), .foregroundColor: NSColor.labelColor]
        let del: [NSAttributedString.Key: Any] = base.merging([.backgroundColor: NSColor.systemRed.withAlphaComponent(0.25)]) { $1 }
        let ins: [NSAttributedString.Key: Any] = base.merging([.backgroundColor: NSColor.systemGreen.withAlphaComponent(0.25)]) { $1 }
        var changed = 0
        for i in 0..<max(a.pageCount, b.pageCount) {
            let la = lines(a.page(at: i)), lb = lines(b.page(at: i))
            let diff = lb.difference(from: la)
            if diff.isEmpty { continue }
            changed += 1
            out.append(NSAttributedString(string: "\n" + L("ページ \(i + 1)") + "\n", attributes: head))
            for c in diff {
                switch c {
                case .remove(_, let s, _): out.append(NSAttributedString(string: "− \(s)\n", attributes: del))
                case .insert(_, let s, _): out.append(NSAttributedString(string: "＋ \(s)\n", attributes: ins))
                }
            }
        }
        let summary = L(changed == 0 ? "差分はありませんでした。" : "\(changed) ページで差分が見つかりました（赤: 旧文書のみ / 緑: 新文書のみ）") + "\n"
        out.insert(NSAttributedString(string: L("旧: \(a.pageCount) ページ ／ 新: \(b.pageCount) ページ") + "\n" + summary, attributes: head), at: 0)
        return out
    }

    private static func lines(_ page: PDFPage?) -> [String] {
        (page?.string ?? "").components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
    }
}
