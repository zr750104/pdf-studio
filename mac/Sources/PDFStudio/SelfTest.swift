import AppKit
import PDFKit

/// `PDFStudio --selftest <出力フォルダ>` で主要機能を UI なしで検証する
enum SelfTest {
    static var failures = 0

    static func check(_ ok: Bool, _ name: String) {
        print(ok ? "✅ \(name)" : "❌ \(name)")
        if !ok { failures += 1 }
    }

    static func run() {
        setbuf(stdout, nil)
        let args = CommandLine.arguments
        let outDir = URL(fileURLWithPath: args.firstIndex(of: "--selftest").flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil } ?? NSTemporaryDirectory())
        try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
        // テスト中のエラーはユーザーのログに書かない
        ErrorLog.isSelftest = true
        ErrorLog.overrideURL = outDir.appendingPathComponent("errors.log")

        // 1. テキストから PDF を作成
        let body = (1...3).map { "第\($0)章 PDF Studio のテスト\n" + String(repeating: "これは日本語の本文です。The quick brown fox jumps over the lazy dog. 機密番号 SECRET-\($0)23 を含みます。\n", count: 40) }.joined(separator: "\n")
        let attr = NSAttributedString(string: body, attributes: [.font: NSFont(name: "HiraginoSans-W3", size: 12)!])
        guard let doc = Operations.paginate(attr) else { check(false, "PDF作成"); return }
        check(doc.pageCount >= 3, "テキストから PDF 作成 (\(doc.pageCount) ページ)")
        check((doc.string ?? "").contains("日本語の本文"), "作成した PDF から日本語テキストを抽出")

        // 2. 各種注釈
        let p0 = doc.page(at: 0)!
        let editor = EditorPDFView(frame: NSRect(x: 0, y: 0, width: 800, height: 1000))
        editor.document = doc
        func border(_ w: CGFloat) -> PDFBorder { let b = PDFBorder(); b.lineWidth = w; return b }
        let sq = PDFAnnotation(bounds: CGRect(x: 60, y: 600, width: 150, height: 80), forType: .square, withProperties: nil)
        sq.color = .systemRed; sq.interiorColor = NSColor.systemYellow.withAlphaComponent(0.3); sq.border = border(3)
        p0.addAnnotation(sq)
        let line = PDFAnnotation(bounds: CGRect(x: 240, y: 580, width: 200, height: 120), forType: .line, withProperties: nil)
        line.startPoint = CGPoint(x: 10, y: 10); line.endPoint = CGPoint(x: 190, y: 110); line.endLineStyle = .closedArrow
        line.color = .systemBlue; line.interiorColor = .systemBlue; line.border = border(3)
        p0.addAnnotation(line)
        let ft = PDFAnnotation(bounds: CGRect(x: 60, y: 520, width: 300, height: 40), forType: .freeText, withProperties: nil)
        ft.contents = "テキストボックスの注釈"; ft.font = NSFont(name: "HiraginoSans-W6", size: 18); ft.fontColor = .systemGreen
        ft.color = .clear; ft.border = border(0)
        p0.addAnnotation(ft)
        let ink = PDFAnnotation(bounds: CGRect(x: 380, y: 450, width: 150, height: 100), forType: .ink, withProperties: nil)
        let path = NSBezierPath(); path.move(to: CGPoint(x: 5, y: 5)); path.curve(to: CGPoint(x: 145, y: 95), controlPoint1: CGPoint(x: 140, y: 0), controlPoint2: CGPoint(x: 0, y: 100))
        ink.add(path); ink.color = .purple; ink.border = border(4)
        p0.addAnnotation(ink)
        if let sel = doc.findString("The quick brown fox", withOptions: []).first {
            let b = sel.bounds(for: p0)
            let hl = PDFAnnotation(bounds: b, forType: .highlight, withProperties: nil)
            hl.color = NSColor.systemYellow.withAlphaComponent(0.5)
            hl.quadrilateralPoints = [NSValue(point: NSPoint(x: 0, y: b.height)), NSValue(point: NSPoint(x: b.width, y: b.height)),
                                      NSValue(point: .zero), NSValue(point: NSPoint(x: b.width, y: 0))]
            p0.addAnnotation(hl)
        }
        if let stamp = StampRenderer.make(.approved) {
            p0.addAnnotation(ImageStamp.make(image: stamp, bounds: ImageStamp.rect(for: stamp, centeredAt: CGPoint(x: 470, y: 720), width: 110))!)
        }
        if let hanko = StampRenderer.hanko("山田") {
            p0.addAnnotation(ImageStamp.make(image: hanko, bounds: CGRect(x: 480, y: 600, width: 50, height: 50))!)
        }
        if let dh = StampRenderer.dateHanko(top: "総務部", name: "佐藤") {
            p0.addAnnotation(ImageStamp.make(image: dh, bounds: CGRect(x: 400, y: 600, width: 60, height: 60), opacity: 0.5)!)
        }
        let w = PDFAnnotation(bounds: CGRect(x: 60, y: 460, width: 180, height: 22), forType: .widget, withProperties: nil)
        w.widgetFieldType = .text; w.fieldName = "name"; w.widgetStringValue = "入力値"; w.backgroundColor = NSColor(calibratedRed: 0.88, green: 0.93, blue: 1, alpha: 1)
        p0.addAnnotation(w)

        guard let data = Compositor.serialize(doc), let re = PDFDocument(data: data) else { check(false, "保存"); return }
        let types = Set(re.page(at: 0)!.annotations.compactMap(\.type))
        check(["Square", "Line", "FreeText", "Ink", "Highlight", "Widget"].allSatisfy(types.contains), "注釈の保存と再読み込み \(types.sorted())")
        // 画像・スタンプは焼き込まず、保存後もスタンプ注釈として動かせる（見た目も残る）
        let stamps = re.page(at: 0)!.annotations.filter { ImageStamp.isImageStamp($0) }
        check(stamps.count == 3 && stamps.allSatisfy { $0.type == "Stamp" } && p0.annotations.contains { ImageStamp.isImageStamp($0) && abs(ImageStamp.opacity($0) - 0.5) < 0.01 }, "画像スタンプは保存後も注釈のまま (\(stamps.count) 件)")
        if let st = stamps.first(where: { abs(($0.bounds.midX) - 470) < 1 }) {
            // スタンプの中心あたりに赤い色が描かれている（見た目がある）
            let img = Render.pageAsDisplayed(re.page(at: 0)!, dpi: 72)
            if let rep = img.tiffRepresentation.flatMap(NSBitmapImageRep.init(data:)) {
                var red = 0
                let pageH = Int(re.page(at: 0)!.bounds(for: .cropBox).height)
                for x in Int(st.bounds.minX)..<Int(st.bounds.maxX) {
                    for y in Int(st.bounds.minY)..<Int(st.bounds.maxY) where x % 2 == 0 && y % 2 == 0 {
                        if let c = rep.colorAt(x: x, y: pageH - y), c.redComponent > 0.6, c.greenComponent < 0.35 { red += 1 }
                    }
                }
                check(red > 20, "保存したスタンプの見た目が表示される (赤 \(red) 点)")
            }
            // 開き直したあとも、動かして保存できる
            st.bounds = st.bounds.offsetBy(dx: -100, dy: 0)
            let again = re.dataRepresentation().flatMap(PDFDocument.init(data:))
            let moved = again?.page(at: 0)?.annotations.first { ImageStamp.isImageStamp($0) && abs($0.bounds.midX - 370) < 1 }
            check(moved != nil, "開き直したスタンプを動かして保存できる")
        }
        try? data.write(to: outDir.appendingPathComponent("1_annotations.pdf"))
        savePNG(re.page(at: 0)!, outDir.appendingPathComponent("1_annotations.png"))

        // 3. 透かし・ヘッダー/フッター
        Operations.addWatermark(re, pages: Array(0..<re.pageCount), .init())
        Operations.addHeaderFooter(re, pages: Array(0..<re.pageCount), .init(headerLeft: "PDF Studio テスト", headerRight: "{date}"))
        check(re.page(at: 0)!.annotations.contains { $0.type == "FreeText" }, "透かし後も注釈が残る")
        check((re.page(at: 1)!.string ?? "").contains("2 / "), "ページ番号の追加")
        savePNG(re.page(at: 0)!, outDir.appendingPathComponent("2_watermark.png"))

        // 4. 墨消し
        let target = re.findString("SECRET-123", withOptions: [])
        check(!target.isEmpty, "墨消し対象を検索")
        let ocrIndex = target.first?.pages.first.map { re.index(for: $0) } ?? 0
        for s in target { for pg in s.pages { pg.addAnnotation(editor.makeRedactionMark(s.bounds(for: pg))) } }
        let n = Compositor.applyRedactions(re)
        check(n > 0 && !(re.string ?? "").contains("SECRET-123"), "墨消し後に文字が抽出できない")
        savePNG(re.page(at: 0)!, outDir.appendingPathComponent("3_redacted.png"))

        // 5. OCR（墨消しで画像化されたページを認識）
        let before = Operations.pageHasText(re.page(at: ocrIndex)!)
        if let lines = try? Operations.recognize(re.page(at: ocrIndex)!) {
            Operations.applyOCR(re, index: ocrIndex, lines: lines)
            let txt = re.page(at: ocrIndex)!.string ?? ""
            check(!lines.isEmpty && txt.contains("日本語"), "OCR で日本語を認識 (\(lines.count) 行, 認識前テキスト有無=\(before))")
            check(re.findString("quick brown", withOptions: .caseInsensitive).count > 0, "OCR 結果を検索できる")
        } else {
            check(false, "OCR 実行")
        }
        savePNG(re.page(at: ocrIndex)!, outDir.appendingPathComponent("4_ocr.png"))

        // 6. フラット化
        Compositor.flattenInPlace(re)
        check(re.page(at: 0)!.annotations.filter { $0.type != "Link" }.isEmpty, "フラット化で注釈が焼き込まれる")
        savePNG(re.page(at: 0)!, outDir.appendingPathComponent("5_flattened.png"))

        // 7. パスワード保護
        let pwData = Compositor.serialize(re, options: [.userPasswordOption: "pass123", .ownerPasswordOption: "owner456"])
        let locked = pwData.flatMap { PDFDocument(data: $0) }
        check(locked?.isLocked == true, "パスワードで暗号化")
        check(locked?.unlock(withPassword: "pass123") == true, "パスワードで解除")

        // 8. 書き出し
        do {
            try Operations.exportWord(re, to: outDir.appendingPathComponent("6_export.docx"))
            let back = try NSAttributedString(url: outDir.appendingPathComponent("6_export.docx"), options: [:], documentAttributes: nil)
            check(back.string.contains("日本語"), "Word (.docx) 書き出し")
        } catch { check(false, "Word 書き出し: \(error)") }
        let imgs = (try? Operations.exportImages(re, to: outDir, baseName: "7_page", jpeg: true, dpi: 72)) ?? 0
        check(imgs == re.pageCount, "画像書き出し (\(imgs) 枚)")

        // 9. ページ操作・分割・比較・圧縮
        let ex = Operations.extract(re, pages: [2, 0])
        check(ex.pageCount == 2, "ページ抽出")
        let splitDir = outDir.appendingPathComponent("split")
        try? FileManager.default.createDirectory(at: splitDir, withIntermediateDirectories: true)
        check((try? Operations.split(re, groups: [[0], [1, 2]], folder: splitDir, baseName: "s")) == 2, "文書の分割")
        let cmp = Operations.compare(doc, re)
        check(cmp.string.contains(L("ページ 1")), "文書の比較 (\(L("ページ 1")))")
        // 圧縮保存：元より大きくならない（以前は 20 倍に増えていた）
        let plain = Compositor.serialize(re)?.count ?? 0
        let std = Operations.optimize(re, original: plain, strong: false)
        check(std == nil || std!.count < plain, "標準の圧縮で大きくならない (\(plain) → \(std?.count ?? plain) bytes)")
        // スキャン相当の重いページ（細かい画像）は「強力」で小さくなり、ページ数は同じ
        let heavy = PDFDocument()
        for k in 0..<3 {
            let img = NSImage(size: NSSize(width: 1240, height: 1754))
            img.lockFocus()
            for y in stride(from: 0, to: 1754, by: 3) { NSColor(calibratedWhite: CGFloat((y * 7 + k) % 255) / 255, alpha: 1).setFill(); NSRect(x: 0, y: y, width: 1240, height: 3).fill() }
            img.unlockFocus()
            if let p = PDFPage(image: img) { heavy.insert(p, at: heavy.pageCount) }
        }
        let heavySize = Compositor.serialize(heavy)?.count ?? 0
        let strong = Operations.optimize(heavy, original: heavySize, strong: true, dpi: 72, quality: 0.5)
        check(strong != nil && strong!.count < heavySize && PDFDocument(data: strong!)?.pageCount == 3, "強力な圧縮で小さくなる (\(heavySize) → \(strong?.count ?? 0) bytes)")
        let blank = Operations.blankPage()
        check(blank != nil, "空白ページ作成")

        tiffTests(outDir: outDir)
        dropTests(outDir: outDir)
        outlineTests()
        updateTests()
        uiTextTests(doc: doc, outDir: outDir)
        interactionTests(doc: doc)
        splitTests(outDir: outDir)
        measureTests(outDir: outDir)
        stampTests()
        errorLogTests(outDir: outDir)
        batchTests(outDir: outDir)
        gridTests(doc: doc, outDir: outDir)
        reviewFixTests(outDir: outDir)
        loadedDocTests(outDir: outDir)

        if !I18n.missing.isEmpty { print("未翻訳 \(I18n.missing.count) 件: \(I18n.missing.sorted().joined(separator: " / "))") }
        print(failures == 0 ? "\nすべてのテストに合格しました（出力: \(outDir.path)）" : "\n\(failures) 件失敗")
    }

    /// 新しい版を探す（配布ページの一覧から Mac 版の zip を選ぶ。Windows 版のファイルは見ない）
    static func updateTests() {
        let json = """
        [{"draft":false,"prerelease":false,"html_url":"https://github.com/zr750104/pdf-studio/releases/tag/v1.5.19","assets":[{"name":"PDF-Studio-Setup-1.5.19.exe"},{"name":"latest.yml"},{"name":"PDF-Studio-Mac-2.1.0.zip"}]},
         {"draft":false,"prerelease":false,"html_url":"https://example/old","assets":[{"name":"PDF-Studio-Mac-2.0.0.zip"}]},
         {"draft":true,"prerelease":false,"html_url":"https://example/draft","assets":[{"name":"PDF-Studio-Mac-9.0.0.zip"}]}]
        """
        let f = UpdateCheck.newestMac(in: Data(json.utf8))
        check(f?.version == "2.1.0" && f?.page.absoluteString.hasSuffix("v1.5.19") == true, "新しい Mac 版を見つける (\(f?.version ?? "なし"))")
        check(UpdateCheck.isNewer("2.0.10", than: "2.0.9") && !UpdateCheck.isNewer("2.0.0", than: "2.0") && !UpdateCheck.isNewer("1.9", than: "2.0.0"), "版の比較")
        check(UpdateCheck.newestMac(in: Data("[{\"assets\":[{\"name\":\"PDF-Studio-Setup-1.5.18.exe\"}]}]".utf8)) == nil, "Mac 版がなければお知らせしない")
    }

    /// 試験用ファイルの場所（ソースの test/fixtures）
    static var fixtures: URL {
        if let d = ProcessInfo.processInfo.environment["PDFSTUDIO_FIXTURES"] { return URL(fileURLWithPath: d) }
        return URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("test/fixtures")
    }

    /// 画像を灰色の画素の配列にする（比較用）
    static func grayPixels(_ img: CGImage, _ w: Int, _ h: Int) -> [UInt8] {
        var buf = [UInt8](repeating: 255, count: w * h)
        buf.withUnsafeMutableBytes { p in
            let ctx = CGContext(data: p.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)!
            ctx.setFillColor(gray: 1, alpha: 1)
            ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
            ctx.interpolationQuality = .none
            ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
        }
        return buf
    }

    /// TIFF を開く（G4 はそのまま埋め込み、ほかは圧縮し直す）。画素が ImageIO で読んだものと同じか
    static func tiffTests(outDir: URL) {
        let fm = FileManager.default
        var files = ["multipage.tif", "fax_g4.tif"]
        files += ((try? fm.contentsOfDirectory(atPath: fixtures.appendingPathComponent("tiffvar").path)) ?? []).filter { $0.hasSuffix(".tif") }.sorted().map { "tiffvar/" + $0 }
        for f in files {
            let url = fixtures.appendingPathComponent(f)
            guard let data = try? Data(contentsOf: url), let src = CGImageSourceCreateWithData(data as CFData, nil) else { check(false, "TIFF を読む \(f)"); continue }
            guard let pdfData = try? TiffImport.pdfData(from: data), let pdf = PDFDocument(data: pdfData) else { check(false, "TIFF を PDF にする \(f)"); continue }
            let n = CGImageSourceGetCount(src)
            var worst = 0.0
            for i in 0..<min(n, pdf.pageCount) {
                guard let ref = CGImageSourceCreateImageAtIndex(src, i, nil), let page = pdf.page(at: i) else { continue }
                let w = min(600, ref.width), h = max(1, ref.height * w / max(1, ref.width))
                let thumb = page.thumbnail(of: NSSize(width: w, height: h), for: .mediaBox)
                guard let mine = thumb.cgImage(forProposedRect: nil, context: nil, hints: nil) else { continue }
                let a = grayPixels(ref, w, h), b = grayPixels(mine, w, h)
                // 平均の明るさの差（0〜255）。JPEG にしたページは少し違ってよい
                let diff = zip(a, b).reduce(0.0) { $0 + abs(Double($1.0) - Double($1.1)) } / Double(a.count)
                worst = max(worst, diff)
            }
            let s = TiffImport.lastStats
            check(pdf.pageCount == n && worst < 12, "TIFF の画素が元と同じ \(f) (\(pdf.pageCount)/\(n) ページ, 差 \(String(format: "%.1f", worst)), そのまま \(s.passthrough)・G4 \(s.reencodedG4)・JPEG \(s.jpeg))")
        }
        // G4 の FAX はそのまま埋め込む（展開しない）
        if let data = try? Data(contentsOf: fixtures.appendingPathComponent("fax_g4.tif")), (try? TiffImport.pdfData(from: data)) != nil {
            let s = TiffImport.lastStats
            check(s.jpeg == 0 && s.passthrough + s.reencodedG4 == s.pages, "白黒の TIFF は白黒のまま（G4）入れる (そのまま \(s.passthrough)・G4 \(s.reencodedG4) / \(s.pages))")
        }
        // TIFF を開いただけなら変更ありにしない（閉じるときに確かめない）。編集したら変更ありになる。ほかの新しい文書は変更あり
        do {
            let t = PDFStudioDocument.makeNew(PDFDocument(), title: "view.pdf", edited: false)
            let viewOnly = !t.isDocumentEdited
            t.updateChangeCount(.changeDone)
            let made = PDFStudioDocument.makeNew(PDFDocument(), title: "made.pdf")
            check(viewOnly && t.isDocumentEdited && made.isDocumentEdited, "TIFF を開いただけなら閉じるときに確かめない（編集したら確かめる、作った文書は確かめる）")
        }
        // 大きな TIFF（ユーザーと同じ 256 ページの白黒スキャン）の速さ。PDFSTUDIO_BENCH_TIFF で指定したときだけ
        if let bench = ProcessInfo.processInfo.environment["PDFSTUDIO_BENCH_TIFF"], let data = try? Data(contentsOf: URL(fileURLWithPath: bench), options: .mappedIfSafe) {
            let t = Date()
            let pdfData = try? TiffImport.pdfData(from: data)
            let conv = Date().timeIntervalSince(t)
            let t2 = Date()
            let pdf = pdfData.flatMap { PDFDocument(data: $0) }
            let p0 = pdf?.page(at: 0)?.thumbnail(of: NSSize(width: 1200, height: 1700), for: .mediaBox)
            let first = Date().timeIntervalSince(t2)
            let t3 = Date()
            _ = pdf?.page(at: 200)?.thumbnail(of: NSSize(width: 1200, height: 1700), for: .mediaBox)
            check(pdf != nil && p0 != nil && conv + first < 5, "256 ページの TIFF を速く開く (変換 \(String(format: "%.2f", conv)) 秒・最初のページ \(String(format: "%.2f", first)) 秒・201 ページ目 \(String(format: "%.2f", Date().timeIntervalSince(t3))) 秒, \(pdf?.pageCount ?? 0) ページ, \((pdfData?.count ?? 0) / 1_000_000) MB, そのまま \(TiffImport.lastStats.passthrough))")
        }
    }

    /// ドロップ：PDF・TIFF は開く、画像・Word・テキストは 1 ファイルずつ PDF にする、ほかは名前を出して知らせる
    static func dropTests(outDir: URL) {
        let dir = outDir.appendingPathComponent("drop")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let img = NSImage(size: NSSize(width: 200, height: 100), flipped: false) { r in NSColor.red.setFill(); r.fill(); return true }
        let png = dir.appendingPathComponent("画像.png")
        if let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) { try? rep.representation(using: .png, properties: [:])?.write(to: png) }
        let sjis = dir.appendingPathComponent("メモ.txt")
        try? "シフトJISの本文です。".data(using: .shiftJIS)?.write(to: sjis)
        let html = dir.appendingPathComponent("page.html")
        try? "<html><body><h1>見出し</h1><p>本文</p></body></html>".data(using: .utf8)?.write(to: html)
        let json = dir.appendingPathComponent("data.json")
        try? "{\"a\": 1}".data(using: .utf8)?.write(to: json)
        let brokenPng = dir.appendingPathComponent("壊れた.png")
        try? Data([1, 2, 3]).write(to: brokenPng)
        let urls = [png, sjis, html, json, brokenPng, dir.appendingPathComponent("a.pdf"), dir.appendingPathComponent("b.TIF")]
        let r = DropOpen.prepare(urls)
        check(r.open.map(\.lastPathComponent) == ["a.pdf", "b.TIF"], "ドロップ：PDF と TIFF はそのまま開く (\(r.open.map(\.lastPathComponent)))")
        check(r.made.map(\.1) == ["画像.pdf", "メモ.pdf", "page.pdf"] && r.made.allSatisfy { $0.0.pageCount >= 1 },
              "ドロップ：画像・テキスト・HTML は 1 ファイルずつ PDF にする (\(r.made.map { "\($0.1)=\($0.0.pageCount)" }))")
        check((r.made.dropFirst().first?.0.string ?? "").contains("シフトJISの本文"), "ドロップ：Shift_JIS のテキストを読める")
        check(r.skipped.count == 2 && r.skipped[0].hasPrefix("data.json") && r.skipped[1].hasPrefix("壊れた.png"),
              "ドロップ：開けないファイルは名前を出して知らせる (\(r.skipped))")
    }

    /// しおりの編集：並べ替え・段の上げ下げ・名前の変更・削除。どれも元に戻せ、保存して開き直しても形が残る
    static func outlineTests() {
        let doc = PDFDocument()
        for i in 0..<3 { if let p = Operations.blankPage() { doc.insert(p, at: i) } }
        let root = PDFOutline()
        doc.outlineRoot = root
        var marks: [PDFOutline] = []
        for (i, name) in ["A", "B", "C"].enumerated() {
            let o = PDFOutline()
            o.label = name
            o.destination = PDFDestination(page: doc.page(at: i)!, at: CGPoint(x: 0, y: 800))
            root.insertChild(o, at: i)
            marks.append(o)
        }
        let (a, b, c) = (marks[0], marks[1], marks[2])
        let d = PDFStudioDocument.makeNew(doc, title: "outline.pdf", edited: false)
        guard let um = d.undoManager else { check(false, "しおり：取り消しの準備"); return }
        um.groupsByEvent = false
        func step(_ body: () -> Void) { um.beginUndoGrouping(); body(); um.endUndoGrouping() }
        func shape(_ o: PDFOutline? = nil) -> String {
            let n = o ?? d.pdf.outlineRoot!
            return (0..<n.numberOfChildren).map { i -> String in
                let x = n.child(at: i)!
                return (x.label ?? "?") + (x.numberOfChildren > 0 ? "(" + shape(x) + ")" : "")
            }.joined(separator: ",")
        }
        var ok = true
        var log: [String] = []
        func expect(_ s: String) { log.append(shape()); if shape() != s { ok = false } }
        step { OutlineEdit.move(c, by: -1, in: d) }; expect("A,C,B")
        let edited = d.isDocumentEdited
        step { OutlineEdit.indent(c, in: d) }; expect("A(C),B")
        let topCantMove = !OutlineEdit.move(a, by: -1, in: d) && !OutlineEdit.indent(a, in: d) && !OutlineEdit.outdent(a, in: d)
        step { OutlineEdit.outdent(c, in: d) }; expect("A,C,B")
        step { OutlineEdit.indent(b, in: d) }; expect("A,C(B)")
        step { OutlineEdit.rename(b, to: "B2", in: d) }; expect("A,C(B2)")
        step { OutlineEdit.remove(a, in: d) }; expect("C(B2)")
        // 保存して開き直す
        let saved = Compositor.serialize(d.pdf).flatMap(PDFDocument.init(data:))
        let reopened = saved.map { s in PDFStudioDocument.makeNew(s, title: "re.pdf", edited: false) }
        var savedShape = ""
        if let r = reopened?.pdf.outlineRoot {
            savedShape = (0..<r.numberOfChildren).map { r.child(at: $0)!.label ?? "?" }.joined(separator: ",") + "/" + (r.child(at: 0)?.child(at: 0)?.label ?? "-")
        }
        let destOk = (saved?.outlineRoot?.child(at: 0)?.child(at: 0)?.destination?.page).map { saved!.index(for: $0) } == 1
        for _ in 0..<6 { um.undo() }
        log.append(shape())
        let undone = shape() == "A,B,C"
        um.redo(); um.redo()
        let redone = shape() == "A(C),B"
        check(ok && edited && topCantMove && undone && redone && savedShape == "C/B2" && destOk,
              "しおり：並べ替え・段の上げ下げ・名前の変更・削除を元に戻せ、保存しても形が残る (\(log.joined(separator: " → ")), やり直し \(shape()), 保存後 \(savedShape), 移動先 \(destOk))")
    }

    /// 実際のマウス・キーのイベントで操作する（テンキーの拡大・縮小、手のひらの慣性スクロール）
    static func interactionTests(doc: PDFDocument) {
        let d = PDFStudioDocument()
        d.setInitialPDF(doc)
        d.makeWindowControllers()
        d.showWindows()
        guard let wc = d.windowControllers.first as? MainWindowController, let win = wc.window,
              let clip = wc.editor.documentView?.enclosingScrollView?.contentView else { check(false, "操作テストの準備"); return }
        win.setFrame(NSRect(x: 0, y: 0, width: 1400, height: 900), display: true)
        let ed = wc.editor
        func pump(_ s: Double) { RunLoop.main.run(until: Date().addingTimeInterval(s)) }
        pump(0.5)
        func key(_ code: UInt16, numpad: Bool) -> NSEvent {
            NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: numpad ? [.numericPad] : [], timestamp: 0, windowNumber: win.windowNumber,
                             context: nil, characters: code == 69 ? "+" : "-", charactersIgnoringModifiers: code == 69 ? "+" : "-", isARepeat: false, keyCode: code)!
        }
        ed.autoScales = false
        ed.scaleFactor = 1
        ed.keyDown(with: key(69, numpad: true))
        let up = ed.scaleFactor
        ed.keyDown(with: key(78, numpad: true))
        check(up > 1.01 && abs(ed.scaleFactor - 1) < 0.01, "テンキーの ＋／－ で拡大・縮小 (\(String(format: "%.2f", up)) → \(String(format: "%.2f", ed.scaleFactor)))")

        // 手のひらで払って離すと滑る
        ed.tool = .hand
        if let mid = ed.document?.page(at: 3) { ed.go(to: mid) }
        pump(0.2)
        func mouse(_ type: NSEvent.EventType, _ y: CGFloat, _ t: TimeInterval) -> NSEvent {
            NSEvent.mouseEvent(with: type, location: NSPoint(x: 600, y: y), modifierFlags: [], timestamp: t,
                               windowNumber: win.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
        }
        func drag(release: TimeInterval) -> CGFloat {
            let t0 = ProcessInfo.processInfo.systemUptime
            ed.mouseDown(with: mouse(.leftMouseDown, 300, t0))
            ed.mouseDragged(with: mouse(.leftMouseDragged, 360, t0 + 0.02))
            ed.mouseDragged(with: mouse(.leftMouseDragged, 420, t0 + 0.04))
            let before = clip.bounds.origin.y
            ed.mouseUp(with: mouse(.leftMouseUp, 420, t0 + release))
            return before
        }
        // 手を上に動かすと、文書の先（下のほう）が見えてくる
        let pageBefore = ed.currentPage.flatMap { ed.document?.index(for: $0) } ?? 0
        let topBefore = ed.convert(NSPoint(x: 600, y: ed.bounds.maxY - 5), to: ed.currentPage!).y
        let y0 = drag(release: 0.05)
        let gliding = ed.isGliding
        pump(0.4)
        let moved = abs(clip.bounds.origin.y - y0)
        check(gliding && moved > 100, "手のひらで払うと滑る (離したあと \(Int(moved)) pt)")
        let pageAfter = ed.currentPage.flatMap { ed.document?.index(for: $0) } ?? 0
        check(pageAfter > pageBefore || (pageAfter == pageBefore && ed.convert(NSPoint(x: 600, y: ed.bounds.maxY - 5), to: ed.currentPage!).y < topBefore), "手の動きに合わせて文書が動く (ページ \(pageBefore + 1) → \(pageAfter + 1)、上端 \(Int(topBefore)) → \(Int(ed.convert(NSPoint(x: 600, y: ed.bounds.maxY - 5), to: ed.currentPage!).y))、flipped=\(clip.isFlipped))")
        pump(2.5)
        check(!ed.isGliding, "滑ったあと止まる")
        // 離す前に止めていたら滑らない
        if let mid = ed.document?.page(at: 3) { ed.go(to: mid) }
        pump(0.2)
        let y1 = drag(release: 0.3)
        pump(0.3)
        check(!ed.isGliding && abs(clip.bounds.origin.y - y1) < 1, "止めてから離すと滑らない")
        // 滑っている途中にキーを押すと止まる
        if let mid = ed.document?.page(at: 3) { ed.go(to: mid) }
        pump(0.2)
        _ = drag(release: 0.05)
        pump(0.05)
        ed.keyDown(with: key(53, numpad: false))
        check(!ed.isGliding, "滑っている途中にキーを押すと止まる")
        ed.tool = .select
        win.close()
    }

    /// 並べて表示：タブの文書を 1 つのウィンドウに並べ、操作はその画面の文書に届く
    static func splitTests(outDir: URL) {
        func pump(_ s: Double) { RunLoop.main.run(until: Date().addingTimeInterval(s)) }
        func makeDoc(_ title: String, pages: Int) -> PDFStudioDocument {
            let pdf = PDFDocument()
            for _ in 0..<pages { if let p = Operations.blankPage() { pdf.insert(p, at: pdf.pageCount) } }
            let d = PDFStudioDocument()
            d.setInitialPDF(pdf)
            d.displayName = title
            d.makeWindowControllers()
            return d
        }
        let docs = [makeDoc("A", pages: 2), makeDoc("B", pages: 3), makeDoc("C", pages: 4)]
        let wcs = docs.compactMap { $0.windowControllers.first as? MainWindowController }
        guard wcs.count == 3, let w0 = wcs[0].window else { check(false, "並べて表示の準備"); return }
        w0.setFrame(NSRect(x: 0, y: 0, width: 1400, height: 900), display: true)
        docs[0].showWindows()
        for wc in wcs.dropFirst() { if let w = wc.window { w0.addTabbedWindow(w, ordered: .above) } }
        pump(0.5)
        check((w0.tabbedWindows?.count ?? 0) == 3, "3 つの文書をタブで開く (\(w0.tabbedWindows?.count ?? 0))")

        // 左右に 2 画面
        wcs[0].applySplit(.horizontal)
        pump(0.5)
        let root = w0.contentView as? SplitRootView
        let panes = root?.panes ?? []
        let widths = panes.map { Int($0.frame.width) }
        check(panes.count == 2 && wcs[0].splitMode == .horizontal && abs((widths.first ?? 0) - (widths.last ?? 0)) < 40 && (widths.first ?? 0) > 600,
              "左右に 2 画面 (幅 \(widths))")
        // 並べた相手（タブの順で次の文書）
        guard let partner = wcs[0].splitPanes.first, let pdoc = partner.document as? PDFStudioDocument else { check(false, "並べた相手"); return }
        check(partner.embeddedIn === wcs[0] && !(partner.window?.isVisible ?? true) && (w0.tabbedWindows?.count ?? 1) == 2, "並べた文書のウィンドウは隠れ、タブから外れる (見える: \(partner.window?.isVisible ?? true)、タブ \(w0.tabbedWindows?.count ?? 1))")
        if let rep = root?.bitmapImageRepForCachingDisplay(in: root!.bounds) {
            root!.cacheDisplay(in: root!.bounds, to: rep)
            try? rep.representation(using: .png, properties: [:])?.write(to: outDir.appendingPathComponent("split_\(I18n.lang).png"))
        }
        // メニューの操作（拡大）は、その画面の文書に届く
        let e0 = wcs[0].editor, e1 = partner.editor
        e0.autoScales = false; e1.autoScales = false
        e0.scaleFactor = 1; e1.scaleFactor = 1
        _ = e1.tryToPerform(#selector(MainWindowController.zoomInAction(_:)), with: nil)
        check(e1.scaleFactor > 1.01 && abs(e0.scaleFactor - 1) < 0.01, "右の画面の操作は右の文書に効く (左 \(String(format: "%.2f", e0.scaleFactor)) / 右 \(String(format: "%.2f", e1.scaleFactor)))")
        check(e1.undoManager === pdoc.undoManager && e0.undoManager === docs[0].undoManager, "取り消しはその画面の文書のもの")
        // 操作中の画面に枠
        let ok = w0.makeFirstResponder(e1)
        wcs[0].updateActivePane()
        // 並べて表示しているウィンドウは、別のタブから相手に選ばない（中の文書が行方不明にならないように）
        let others = wcs.filter { $0 !== wcs[0] && $0 !== partner }
        check(others.allSatisfy { !$0.tabPartners().contains { $0 === wcs[0] || $0 === partner } }, "並べて表示中のウィンドウは、ほかのタブの相手にしない")
        check(pdoc.windowForSheet === w0, "並べた文書の保存・印刷のシートは、並べているウィンドウに出る")
        check(panes.count == 2 && !panes[0].isActive && panes[1].isActive, "操作中の画面に枠が付く (\(ok), \(String(describing: w0.firstResponder.map { type(of: $0) })))")
        // ページを削除する操作も、その文書だけに効く
        let before = pdoc.pdf.pageCount
        _ = e1.tryToPerform(#selector(MainWindowController.insertBlankPage(_:)), with: nil)
        check(pdoc.pdf.pageCount == before + 1 && docs[0].pdf.pageCount == 2, "ページの挿入はその画面の文書だけ (A \(docs[0].pdf.pageCount) / 相手 \(before) → \(pdoc.pdf.pageCount) ページ)")

        // 上下・すべて
        wcs[0].applySplit(.vertical)
        pump(0.4)
        let vp = (w0.contentView as? SplitRootView)?.panes ?? []
        check(vp.count == 2 && vp[0].frame.width > 1000 && w0.frame.width >= 1399, "上下に 2 画面 (\(vp.map { "\(Int($0.frame.width))x\(Int($0.frame.height))" }))")
        wcs[0].applySplit(.grid)
        pump(0.4)
        let gp = (w0.contentView as? SplitRootView)?.panes ?? []
        check(gp.count == 3 && wcs.allSatisfy { $0 === wcs[0] || $0.embeddedIn === wcs[0] }, "すべて並べる (\(gp.count) 画面)")
        // 1 画面に戻すと、タブに戻る
        wcs[0].applySplit(.single)
        pump(0.4)
        check(!(w0.contentView is SplitRootView) && w0.contentViewController === wcs[0].rootController && (w0.tabbedWindows?.count ?? 0) == 3
              && wcs.allSatisfy { $0.embeddedIn == nil } && wcs[1].window?.contentViewController === wcs[1].rootController,
              "1 画面に戻すとタブに戻る (タブ \(w0.tabbedWindows?.count ?? 0))")
        // 並べている文書を 1 つ外す
        wcs[0].applySplit(.grid)
        pump(0.3)
        wcs[0].removePane(wcs[2])
        pump(0.3)
        check(wcs[0].splitPanes.count == 1 && wcs[2].embeddedIn == nil && wcs[2].window?.contentViewController === wcs[2].rootController, "並べた文書を 1 つ外す")
        wcs[0].applySplit(.single)
        for d in docs { d.updateChangeCount(.changeCleared); d.close() }
    }

    /// 寸法の測定（距離・周長・面積・縮尺・キャリブレーション・頂点の調整・保存）
    static func measureTests(outDir: URL) {
        func pump(_ s: Double) { RunLoop.main.run(until: Date().addingTimeInterval(s)) }
        // 計算
        let mm = MeasureScale.standard
        check(Measure.value(kind: "distance", points: [.zero, CGPoint(x: 72, y: 0)], scale: mm).text == "25.4 mm", "72pt は 25.4 mm（1:1）")
        let m100 = MeasureScale(factor: MeasureScale.factor(ratio: 100, unit: "m"), unit: "m", label: "1:100", ratio: 100, decimals: 2)
        let sq = [CGPoint.zero, CGPoint(x: 72, y: 0), CGPoint(x: 72, y: 72), CGPoint(x: 0, y: 72)]
        check(Measure.value(kind: "area", points: sq, scale: m100).text == "6.45 m²", "1 インチ角は 1:100 で 6.45 m² (\(Measure.value(kind: "area", points: sq, scale: m100).text))")
        check(Measure.value(kind: "perimeter", points: sq, scale: mm).text == "76.2 mm", "周長（開いた折れ線 3 辺）")

        // 画面で操作する
        let pdf = PDFDocument()
        for _ in 0..<2 { if let p = Operations.blankPage() { pdf.insert(p, at: pdf.pageCount) } }
        let d = PDFStudioDocument()
        d.setInitialPDF(pdf)
        d.makeWindowControllers()
        d.showWindows()
        guard let wc = d.windowControllers.first as? MainWindowController, let win = wc.window, let page = pdf.page(at: 0) else { check(false, "測定の準備"); return }
        win.setFrame(NSRect(x: 0, y: 0, width: 1400, height: 900), display: true)
        let ed = wc.editor
        ed.autoScales = false
        ed.scaleFactor = 1
        ed.go(to: CGRect(x: 0, y: 500, width: 100, height: 100), on: page)
        pump(0.4)
        func wp(_ p: CGPoint) -> NSPoint { ed.convert(ed.convert(p, from: page), to: nil) }
        func ev(_ t: NSEvent.EventType, _ p: CGPoint, clicks: Int = 1) -> NSEvent {
            NSEvent.mouseEvent(with: t, location: wp(p), modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                               windowNumber: win.windowNumber, context: nil, eventNumber: 0, clickCount: clicks, pressure: 1)!
        }
        func drag(_ a: CGPoint, _ b: CGPoint) {
            ed.mouseDown(with: ev(.leftMouseDown, a))
            ed.mouseDragged(with: ev(.leftMouseDragged, CGPoint(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2)))
            ed.mouseDragged(with: ev(.leftMouseDragged, b))
            ed.mouseUp(with: ev(.leftMouseUp, b))
        }
        func click(_ p: CGPoint, clicks: Int = 1) {
            ed.mouseDown(with: ev(.leftMouseDown, p, clicks: clicks))
            ed.mouseUp(with: ev(.leftMouseUp, p, clicks: clicks))
        }
        let measures = { page.annotations.filter { Measure.data(of: $0) != nil } }
        // ラベルの数値（マウスの座標の丸めで少しずれてよい）
        func num(_ s: String?) -> Double { Double((s ?? "").components(separatedBy: " ").first?.replacingOccurrences(of: ",", with: "") ?? "") ?? -1 }
        func near(_ s: String?, _ v: Double, _ tol: Double = 0.25) -> Bool { abs(num(s) - v) <= tol }
        // 距離
        ed.tool = .measureDistance
        drag(CGPoint(x: 100, y: 600), CGPoint(x: 172, y: 600))
        let dist = measures().first
        let distLabel = dist.flatMap { Measure.label(in: ed.groupMembers(of: $0)) }
        check(dist != nil && near(distLabel?.contents, 25.4) && distLabel?.contents?.hasSuffix(" mm") == true && page.annotations.count == 2, "距離を測る（ドラッグ、\(distLabel?.contents ?? "なし")）")
        // 面積（クリックで頂点、ダブルクリックで確定）
        ed.tool = .measureArea
        click(CGPoint(x: 100, y: 400)); click(CGPoint(x: 172, y: 400)); click(CGPoint(x: 172, y: 472))
        click(CGPoint(x: 100, y: 472)); click(CGPoint(x: 100, y: 472), clicks: 2)
        let area = measures().first { Measure.data(of: $0)?.kind == "area" }
        let areaLabel = area.flatMap { Measure.label(in: ed.groupMembers(of: $0)) }
        check(area.flatMap(Measure.data(of:))?.points.count == 4 && areaLabel?.contents == "645.2 mm²", "面積を測る（クリック 4 点＋ダブルクリック、\(areaLabel?.contents ?? "なし")）")
        // 周長（Enter で確定、Backspace で 1 つ戻る）
        ed.tool = .measurePerimeter
        click(CGPoint(x: 300, y: 400)); click(CGPoint(x: 372, y: 400)); click(CGPoint(x: 500, y: 300))
        let bs = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: win.windowNumber, context: nil, characters: "\u{7f}", charactersIgnoringModifiers: "\u{7f}", isARepeat: false, keyCode: 51)!
        ed.keyDown(with: bs)
        click(CGPoint(x: 372, y: 472))
        let enter = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: win.windowNumber, context: nil, characters: "\r", charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 36)!
        ed.keyDown(with: enter)
        let per = measures().first { Measure.data(of: $0)?.kind == "perimeter" }
        let perLabel = per.flatMap { Measure.label(in: ed.groupMembers(of: $0)) }
        check(per.flatMap(Measure.data(of:))?.points.count == 3 && perLabel?.contents == "50.8 mm", "周長を測る（Backspace で戻して Enter で確定、\(perLabel?.contents ?? "なし")）")
        pump(0.2)
        if let cv = win.contentView, let rep = cv.bitmapImageRepForCachingDisplay(in: cv.bounds) {
            cv.cacheDisplay(in: cv.bounds, to: rep)
            try? rep.representation(using: .png, properties: [:])?.write(to: outDir.appendingPathComponent("measure.png"))
        }
        savePNG(page, outDir.appendingPathComponent("measure_page.png"))

        // 頂点をドラッグして調整し、取り消す
        if let dist, let distLabel {
            ed.tool = .select
            ed.selectAnnotation(dist)
            drag(CGPoint(x: 172, y: 600), CGPoint(x: 244, y: 600))
            let adjusted = distLabel.contents
            let original = num(distLabel.contents)
            d.undoManager?.undo()
            check(near(adjusted, 50.8, 0.5) && near(distLabel.contents, 25.4) && original > 50, "頂点をドラッグして調整・取り消し (\(adjusted ?? "") → \(distLabel.contents ?? ""))")
            // まとめて動かしても、頂点は一緒に動く（値は変わらない）
            let labelX = distLabel.bounds.minX
            let valueBefore = distLabel.contents
            let x0 = Measure.data(of: dist).map { Measure.absolute($0, origin: dist.bounds.origin)[0].x } ?? 0
            drag(CGPoint(x: 136, y: 600), CGPoint(x: 156, y: 640))
            let x1 = Measure.data(of: dist).map { Measure.absolute($0, origin: dist.bounds.origin)[0].x } ?? 0
            check(abs(distLabel.bounds.minX - labelX - 20) < 1.5 && distLabel.contents == valueBefore && abs(x1 - x0 - 20) < 1.5,
                  "測定を動かすとラベルも動き、値は同じ (ラベル \(String(format: "%.1f", distLabel.bounds.minX - labelX)) pt、頂点 \(String(format: "%.1f", x1 - x0)) pt)")
        }
        // 縮尺を変えると既存の測定も変わる
        let changed = ed.setMeasureScale(m100, all: true)
        check(changed == 3 && near(distLabel?.contents, 2.54, 0.02) && distLabel?.contents?.hasSuffix(" m") == true, "縮尺 1:100 (m) を既存の測定に適用 (\(changed) 件, \(distLabel?.contents ?? ""))")
        d.undoManager?.undo()
        check(near(distLabel?.contents, 25.4) && distLabel?.contents?.hasSuffix(" mm") == true, "縮尺の変更を取り消す (\(distLabel?.contents ?? ""))")
        // キャリブレーション：基準線の長さ（pt）を受け取る
        var calibrated: CGFloat = 0
        ed.tool = .measureDistance
        ed.calibrating = { calibrated = $0 }
        let before = page.annotations.count
        drag(CGPoint(x: 100, y: 200), CGPoint(x: 244, y: 200))
        check(abs(calibrated - 144) < 0.5 && page.annotations.count == before && ed.calibrating == nil, "キャリブレーションの基準線 (\(String(format: "%.1f", calibrated)) pt、測定は増えない)")
        // 保存して開き直しても、測定として調整できる
        if let data = pdf.dataRepresentation(), let re = PDFDocument(data: data), let rp = re.page(at: 0) {
            let ms = rp.annotations.filter { Measure.data(of: $0) != nil }
            let labels = rp.annotations.filter { Measure.group(of: $0) != nil && $0.type == "FreeText" }.compactMap(\.contents).sorted()
            check(ms.count == 3 && labels.contains { near($0, 25.4) } && labels.contains("645.2 mm²"), "保存しても測定のまま残る (\(ms.count) 件: \(labels))")
        }
        d.updateChangeCount(.changeCleared)
        d.close()
    }

    /// 読み込んだ文書（ファイルから開いた文書）での測定・スタンプ・TIFF の保存と、TIFF を開く流れ
    static func loadedDocTests(outDir: URL) {
        func pump(_ s: Double) { RunLoop.main.run(until: Date().addingTimeInterval(s)) }
        func render(_ p: PDFPage) -> NSBitmapImageRep? { Render.pageAsDisplayed(p, dpi: 72).tiffRepresentation.flatMap(NSBitmapImageRep.init(data:)) }
        // 測定 3 つ（＋画像スタンプ 1 つ）を、ファイルから開いた文書に置いて保存し、開き直す
        for withStamp in [false, true] {
            let base = PDFDocument(); base.insert(Operations.blankPage()!, at: 0)
            guard let loaded = PDFDocument(data: base.dataRepresentation()!), let page = loaded.page(at: 0) else { continue }
            let kinds: [(String, [CGPoint])] = [("distance", [CGPoint(x: 100, y: 700), CGPoint(x: 172, y: 700)]),
                                                ("perimeter", [CGPoint(x: 100, y: 500), CGPoint(x: 172, y: 500), CGPoint(x: 172, y: 572)]),
                                                ("area", [CGPoint(x: 300, y: 300), CGPoint(x: 372, y: 300), CGPoint(x: 372, y: 372), CGPoint(x: 300, y: 372)])]
            for (k, pts) in kinds {
                let m = Measure.make(kind: k, points: pts, scale: .standard, color: .red, lineWidth: 1)
                page.addAnnotation(m.shape); page.addAnnotation(m.label)
            }
            if withStamp, let img = StampRenderer.make(.approved), let st = ImageStamp.make(image: img, bounds: CGRect(x: 350, y: 650, width: 120, height: 76)) { page.addAnnotation(st) }
            let saved1 = Compositor.serialize(loaded).flatMap(PDFDocument.init(data:))
            let p1 = saved1?.page(at: 0)
            let ms1 = p1?.annotations.filter { Measure.data(of: $0) != nil } ?? []
            // 開き直した文書で縮尺を変え、頂点を動かして、もう一度保存して開き直す
            let before = p1.flatMap(render)   // 調整する前の見た目
            var rescaled = false
            if let p1 {
                for shape in ms1 {
                    guard let g = Measure.group(of: shape), let label = p1.annotations.first(where: { $0.userName == g && $0 !== shape && $0.type == "FreeText" }), let d = Measure.data(of: shape) else { continue }
                    var pts = Measure.absolute(d, origin: shape.bounds.origin)
                    if d.kind == "distance" { pts[1].x += 72 }
                    let m100 = MeasureScale(factor: MeasureScale.factor(ratio: 100, unit: "m"), unit: "m", label: "1:100", ratio: 100, decimals: 2)
                    Measure.apply(kind: d.kind, points: pts, scale: m100, shape: shape, label: label)
                    rescaled = true
                }
            }
            let saved2 = saved1.flatMap { Compositor.serialize($0) }.flatMap(PDFDocument.init(data:))
            let p2 = saved2?.page(at: 0)
            let ms2 = p2?.annotations.filter { Measure.data(of: $0) != nil } ?? []
            let labels2 = p2?.annotations.filter { Measure.group(of: $0) != nil && $0.type == "FreeText" }.compactMap(\.contents).sorted() ?? []
            let after = p2.flatMap(render)
            // 距離のラベルのあたりの見た目が変わっている（古い見た目のままではない）
            var changedPixels = 0
            if let before, let after {
                for x in stride(from: 100, to: 260, by: 2) { for y in stride(from: 842 - 715, to: 842 - 685, by: 2) {
                    if let a = before.colorAt(x: x, y: y), let b = after.colorAt(x: x, y: y), abs(a.redComponent - b.redComponent) + abs(a.greenComponent - b.greenComponent) > 0.3 { changedPixels += 1 }
                } }
            }
            let stamps2 = p2?.annotations.filter(ImageStamp.isImageStamp).count ?? 0
            check(ms1.count == 3 && ms2.count == 3 && rescaled && labels2.contains("5.08 m") && changedPixels > 5 && (!withStamp || stamps2 == 1),
                  "ファイルから開いた文書で測定を保存・調整して保存し直す\(withStamp ? "（スタンプあり）" : "") (\(ms1.count)→\(ms2.count) 件、\(labels2)、見た目の変化 \(changedPixels)、スタンプ \(stamps2))")
        }

        // TIFF を開く流れ（文書の仕組みから開く）：名前のない新しい文書になり、元の TIFF は上書きしない
        let tiffURL = fixtures.appendingPathComponent("multipage.tif")
        var opened: NSDocument?
        var done = false
        NSDocumentController.shared.openDocument(withContentsOf: tiffURL, display: true) { d, _, _ in opened = d; done = true }
        for _ in 0..<100 where !done { pump(0.05) }
        let od = opened as? PDFStudioDocument
        // 見ただけなら変更ありにしない（閉じるときに確かめない。元の TIFF は残っている）
        check(od?.pdf.pageCount == 3 && od?.fileURL == nil && od?.isDocumentEdited == false && od?.displayName == "multipage.pdf",
              "TIFF を開くと名前のない PDF の文書になり、閉じるときに確かめない (\(od?.pdf.pageCount ?? 0) ページ、\(od?.displayName ?? "なし")、保存先 \(od?.fileURL?.lastPathComponent ?? "なし"))")
        od?.updateChangeCount(.changeCleared)
        od?.close()

        // 256 ページの TIFF にスタンプを置いて保存する（PDFSTUDIO_BENCH_TIFF のときだけ）
        if let bench = ProcessInfo.processInfo.environment["PDFSTUDIO_BENCH_TIFF"], let data = try? Data(contentsOf: URL(fileURLWithPath: bench), options: .mappedIfSafe),
           let pdfData = try? TiffImport.pdfData(from: data), let doc = PDFDocument(data: pdfData) {
            var t = Date()
            let plain = Compositor.serialize(doc)
            let plainTime = Date().timeIntervalSince(t)
            if let img = StampRenderer.make(.approved), let p0 = doc.page(at: 0), let st = ImageStamp.make(image: img, bounds: CGRect(x: 100, y: 100, width: 150, height: 95)) { p0.addAnnotation(st) }
            t = Date()
            let withStamp = Compositor.serialize(doc)
            let stampTime = Date().timeIntervalSince(t)
            let re = withStamp.flatMap(PDFDocument.init(data:))
            var same = true
            for i in [0, 200] {
                guard let a = doc.page(at: i), let b = re?.page(at: i) else { same = false; continue }
                let x = a.thumbnail(of: NSSize(width: 300, height: 400), for: .mediaBox), y = b.thumbnail(of: NSSize(width: 300, height: 400), for: .mediaBox)
                if i == 200, x.tiffRepresentation != y.tiffRepresentation {
                    let ra = x.tiffRepresentation.flatMap(NSBitmapImageRep.init(data:)), rb = y.tiffRepresentation.flatMap(NSBitmapImageRep.init(data:))
                    var diff = 0
                    for px in stride(from: 0, to: 300, by: 5) { for py in stride(from: 0, to: 400, by: 5) { if let c1 = ra?.colorAt(x: px, y: py), let c2 = rb?.colorAt(x: px, y: py), abs(c1.redComponent - c2.redComponent) > 0.2 { diff += 1 } } }
                    if diff > 10 { same = false }
                }
            }
            let mb = { (d: Data?) in (d?.count ?? 0) / 1_000_000 }
            let stampKept = re?.page(at: 0)?.annotations.contains(where: ImageStamp.isImageStamp) ?? false
            check(re?.pageCount == 256 && stampKept && same && mb(withStamp) < 70 && stampTime < 20,
                  "256 ページの TIFF にスタンプを置いて保存 (\(re?.pageCount ?? 0) ページ、\(mb(withStamp)) MB・\(String(format: "%.1f", stampTime)) 秒、スタンプなし \(mb(plain)) MB・\(String(format: "%.1f", plainTime)) 秒、ページの見た目 \(same ? "同じ" : "違う"))")
        }
    }

    /// レビューで見つかった不具合の確認
    static func reviewFixTests(outDir: URL) {
        // フォームとページラベルのある PDF に画像スタンプを置いて保存しても、フォームとページラベルが残る
        var out = Data()
        var offs: [Int] = []
        func a(_ s: String) { out.append(s.data(using: .isoLatin1)!) }
        func b(_ n: Int) { offs.append(out.count); a("\(n) 0 obj\n") }
        a("%PDF-1.4\n")
        b(1); a("<< /Type /Catalog /Pages 2 0 R /PageLabels << /Nums [0 << /S /r >> 1 << /S /D /St 5 >>] >> /AcroForm << /Fields [5 0 R] >> >>\nendobj\n")
        b(2); a("<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] >>\nendobj\n")
        b(3); a("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Annots [5 0 R] >>\nendobj\n")
        b(4); a("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] >>\nendobj\n")
        b(5); a("<< /Type /Annot /Subtype /Widget /FT /Tx /T (name) /V (abc) /Rect [20 250 200 270] /P 3 0 R >>\nendobj\n")
        let x = out.count
        a("xref\n0 \(offs.count + 1)\n0000000000 65535 f \n"); for o in offs { a(String(format: "%010d 00000 n \n", o)) }
        a("trailer\n<< /Size \(offs.count + 1) /Root 1 0 R >>\nstartxref\n\(x)\n%%EOF\n")
        if let form = PDFDocument(data: out), let p0 = form.page(at: 0), let img = StampRenderer.make(.approved),
           let st = ImageStamp.make(image: img, bounds: CGRect(x: 60, y: 60, width: 120, height: 76)) {
            p0.addAnnotation(st)
            let saved = Compositor.serialize(form) ?? Data()
            let raw = String(data: saved, encoding: .isoLatin1) ?? ""
            let re = PDFDocument(data: saved)
            let labels = [re?.page(at: 0)?.label ?? "", re?.page(at: 1)?.label ?? ""]
            let widget = re?.page(at: 0)?.annotations.contains { $0.type == "Widget" } ?? false
            // スタンプはページに焼き込まれて見える
            var red = 0
            if let page = re?.page(at: 0), let rep = Render.pageAsDisplayed(page, dpi: 72).tiffRepresentation.flatMap(NSBitmapImageRep.init(data:)) {
                for x in stride(from: 60, to: 180, by: 3) { for y in stride(from: 300 - 136, to: 300 - 60, by: 3) { if let c = rep.colorAt(x: x, y: y), c.redComponent > 0.6, c.greenComponent < 0.35 { red += 1 } } }
            }
            // PDFKit の制限でフォームの設定（/AcroForm）とページラベルは残らない（置くときに知らせる）。欄とスタンプは残る
            let stampKept = re?.page(at: 0)?.annotations.contains(where: ImageStamp.isImageStamp) ?? false
            check(Compositor.hasFormOrPageLabels(form) && widget && stampKept && red > 10, "フォームのある文書でも、欄とスタンプは保存後に残る (ラベル \(labels)、AcroForm \(raw.contains("/AcroForm"))、欄 \(widget)、スタンプ \(stampKept))")
        } else { check(false, "フォームの試験 PDF") }

        // グレーの画像も白くならずに見える
        let ctx = CGContext(data: nil, width: 40, height: 20, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)!
        ctx.setFillColor(CGColor(gray: 0.2, alpha: 1)); ctx.fill(CGRect(x: 0, y: 0, width: 40, height: 20))
        let gdoc = PDFDocument(); gdoc.insert(Operations.blankPage(size: CGSize(width: 200, height: 200))!, at: 0)
        if let gimg = ctx.makeImage(), let st = ImageStamp.make(image: gimg, bounds: CGRect(x: 50, y: 50, width: 100, height: 50)) {
            gdoc.page(at: 0)?.addAnnotation(st)
            let rep = Render.pageAsDisplayed(gdoc.page(at: 0)!, dpi: 72).tiffRepresentation.flatMap(NSBitmapImageRep.init(data:))
            let c = rep?.colorAt(x: 100, y: 125)
            check((c?.redComponent ?? 1) < 0.5, "グレーの画像を置いても白くならない (明るさ \(String(format: "%.2f", c?.redComponent ?? 1)))")
        }

        // 数でない入力は使わない（nan・inf で止まらない）
        let tf = NSTextField(string: "nan")
        let tf2 = NSTextField(string: "1e30")
        check(tf.doubleValueOrNil == nil && tf2.doubleValueOrNil == nil, "数でない・大きすぎる入力は使わない")
        // 不具合報告：引用符の中・外付けディスクの名前も伏せる
        let s = ErrorLog.sanitize("“山田商事 見積書” couldn't be opened /Volumes/Client Secret/Plans 資料.pptx")
        check(!s.contains("山田") && !s.contains("Client Secret") && !s.contains("資料"), "報告の個人情報（引用符の中・ディスク名・pptx）を伏せる (\(s))")

        // 縮尺の変更を取り消すと、文書の縮尺も戻り、やり直せる
        let mdoc = PDFStudioDocument()
        let mp = PDFDocument(); mp.insert(Operations.blankPage()!, at: 0)
        mdoc.setInitialPDF(mp)
        mdoc.makeWindowControllers()
        if let ed = (mdoc.windowControllers.first as? MainWindowController)?.editor, let page = mp.page(at: 0) {
            let m = Measure.make(kind: "distance", points: [CGPoint(x: 100, y: 100), CGPoint(x: 172, y: 100)], scale: .standard, color: .red, lineWidth: 1)
            page.addAnnotation(m.shape); page.addAnnotation(m.label)
            let m100 = MeasureScale(factor: MeasureScale.factor(ratio: 100, unit: "m"), unit: "m", label: "1:100", ratio: 100, decimals: 2)
            ed.setMeasureScale(m100, all: true)
            mdoc.undoManager?.undo()
            let afterUndo = (m.label.contents ?? "", ed.measureScale.label)
            mdoc.undoManager?.redo()
            let afterRedo = (m.label.contents ?? "", ed.measureScale.label)
            check(afterUndo == ("25.4 mm", "1:1") && afterRedo == ("2.54 m", "1:100"), "縮尺の取り消し・やり直し (\(afterUndo) → \(afterRedo))")
        }
        mdoc.updateChangeCount(.changeCleared)
        mdoc.close()
    }

    /// 縮小したときの横並び表示
    static func gridTests(doc: PDFDocument, outDir: URL) {
        func pump(_ s: Double) { RunLoop.main.run(until: Date().addingTimeInterval(s)) }
        let d = PDFStudioDocument()
        d.setInitialPDF(doc)
        d.makeWindowControllers()
        d.showWindows()
        guard let wc = d.windowControllers.first as? MainWindowController, let win = wc.window else { check(false, "横並びの準備"); return }
        win.setFrame(NSRect(x: 0, y: 0, width: 1400, height: 900), display: true)
        let ed = wc.editor
        pump(0.3)
        check(!ed.isShowingGrid, "ページ全体を表示では横並びにしない")
        ed.autoScales = false
        ed.scaleFactor = 1
        pump(0.2)
        check(!ed.isShowingGrid, "100% では横並びにしない")
        ed.scaleFactor = 0.3
        pump(0.6)
        check(ed.isShowingGrid, "縮小すると横並び表示になる (倍率 \(String(format: "%.2f", ed.scaleFactor)))")
        if let g = ed.grid, let rep = g.bitmapImageRepForCachingDisplay(in: g.bounds) {
            g.cacheDisplay(in: g.bounds, to: rep)
            try? rep.representation(using: .png, properties: [:])?.write(to: outDir.appendingPathComponent("grid.png"))
        }
        // テンキーの ＋ で拡大すると元に戻る
        for _ in 0..<8 {
            let e = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [.numericPad], timestamp: 0, windowNumber: win.windowNumber, context: nil,
                                     characters: "+", charactersIgnoringModifiers: "+", isARepeat: false, keyCode: 69)!
            ed.keyDown(with: e)
        }
        pump(0.3)
        check(!ed.isShowingGrid, "拡大すると元の表示に戻る (倍率 \(String(format: "%.2f", ed.scaleFactor)))")
        ed.scaleFactor = 0.3
        pump(0.3)
        ed.leaveGrid(at: 3)
        pump(0.3)
        let cur = ed.currentPage.flatMap { doc.index(for: $0) } ?? -1
        check(!ed.isShowingGrid && cur == 3 && ed.scaleFactor > 0.8, "横並びでページを選ぶと、そのページを幅に合わせて表示 (ページ \(cur + 1))")
        d.updateChangeCount(.changeCleared)
        win.close()
    }

    /// 一括処理（ファイルをまたいだベイツ番号・透かし・プロパティ・形式）
    static func batchTests(outDir: URL) {
        let fm = FileManager.default
        let src = outDir.appendingPathComponent("batch-src"), dst = outDir.appendingPathComponent("batch-out")
        for d in [src, dst] { try? fm.removeItem(at: d); try? fm.createDirectory(at: d, withIntermediateDirectories: true) }
        var urls: [URL] = []
        for (k, pages) in [2, 3].enumerated() {
            let body = (1...pages).map { "Batch file \(k) page \($0)\n" + String(repeating: "line\n", count: 70) }.joined()
            if let d = Operations.paginate(NSAttributedString(string: body, attributes: [.font: NSFont.systemFont(ofSize: 12)])) {
                let u = src.appendingPathComponent("doc\(k).pdf")
                d.write(to: u)
                urls.append(u)
            }
        }
        urls.append(fixtures.appendingPathComponent("multipage.tif"))
        let broken = src.appendingPathComponent("broken.pdf")
        try? Data("not a pdf".utf8).write(to: broken)
        urls.append(broken)
        var o = Batch.Options()
        var w = Operations.WatermarkOptions(); w.text = "BATCHMARK"
        o.watermark = w
        o.bates = ("ABC", 1, 6)
        o.title = "Batch Title"
        o.suffix = "_out"
        let r = Batch.run(urls, o, to: dst)
        let outs = r.done.compactMap { PDFDocument(url: $0) }
        let texts = outs.map { $0.string ?? "" }
        let pageCounts = outs.map(\.pageCount)
        check(r.done.count == 3 && r.failed.count == 1 && r.failed[0].0 == "broken.pdf", "一括処理：3 件保存・壊れたファイルは知らせる (保存 \(r.done.count)、失敗 \(r.failed.map(\.0)))")
        // 各ファイルの最初のベイツ番号は、前のファイルまでのページ数 + 1
        var firstExpected: [String] = []
        var n = 1
        for c in pageCounts { firstExpected.append(String(format: "ABC%06d", n)); n += c }
        let lastBates = String(format: "ABC%06d", n - 1)
        let firsts = outs.map { $0.page(at: 0)?.string ?? "" }
        check(texts.count == 3 && zip(firsts, firstExpected).allSatisfy { $0.contains($1) } && texts[2].contains(lastBates) && texts.allSatisfy { $0.contains("BATCHMARK") },
              "ベイツ番号がファイルをまたいで続き、透かしが入る (ページ数 \(pageCounts)、各先頭 \(firstExpected)、最後 \(lastBates)、透かし \(texts.map { $0.contains("BATCHMARK") }))")
        check(outs.first.flatMap { $0.documentAttributes?[PDFDocumentAttribute.titleAttribute] as? String } == "Batch Title", "一括処理でタイトルを設定")
        var t = Batch.Options()
        t.output = .txt
        t.suffix = "_txt"
        let rt = Batch.run(Array(urls.prefix(1)), t, to: dst)
        let txt = rt.done.first.flatMap { try? String(contentsOf: $0, encoding: .utf8) } ?? ""
        check(rt.done.first?.pathExtension == "txt" && txt.contains("Batch file 0"), "一括処理でテキストに書き出す")
    }

    /// 不具合の記録と報告（個人情報を伏せる、URL に収まる）
    static func errorLogTests(outDir: URL) {
        ErrorLog.isSelftest = true
        ErrorLog.overrideURL = outDir.appendingPathComponent("errors-test.log")
        try? FileManager.default.removeItem(at: ErrorLog.overrideURL!)
        let home = NSHomeDirectory()
        let s = ErrorLog.sanitize("\(home)/Documents/見積書 2026.pdf を開けません user@example.com scan.tif /Users/someone/x")
        check(!s.contains(home) && !s.contains("見積書") && !s.contains("scan.tif") && !s.contains("@example") && !s.contains("someone") && s.contains("<path>.pdf"), "ログの個人情報を伏せる (\(s))")
        for k in 0..<30 { ErrorLog.record("test", "エラー \(k) " + String(repeating: "x", count: 400), prompt: false) }
        let body = ErrorLog.buildBody()
        let url = ErrorLog.reportURL()?.absoluteString ?? ""
        check(body.count <= ErrorLog.maxBody && body.contains("エラー 29") && !body.contains("エラー 0 ") && url.contains("issues/new") && !url.contains(NSUserName()),
              "報告の下書きは新しいエラーから入り、URL に収まる (\(body.count) 文字)")
        ErrorLog.overrideURL = outDir.appendingPathComponent("errors.log")
    }

    /// スタンプ（英語・自分で作ったスタンプ・日付などの自動入力）
    static func stampTests() {
        check(CustomStamps.english.count == 16 && CustomStamps.english.allSatisfy { StampRenderer.textStamp($0.0, color: $0.1, withDate: $0.2) != nil }, "英語のスタンプ 16 種類")
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let savedName = UserDefaults.standard.string(forKey: CustomStamps.nameKey)
        UserDefaults.standard.set("山田", forKey: CustomStamps.nameKey)
        let e = CustomStamps.expand("{date} {time} {name}", now: now)
        check(e.hasPrefix(StampRenderer.dateString(now)) && e.hasSuffix("山田") && e.contains(":"), "下段の {date} {time} {name} を押すときの値にする (\(e))")
        if let savedName { UserDefaults.standard.set(savedName, forKey: CustomStamps.nameKey) } else { UserDefaults.standard.removeObject(forKey: CustomStamps.nameKey) }
        // 作ったスタンプの保存と削除（ユーザーのスタンプは元に戻す）
        let before = CustomStamps.all()
        let item = CustomStamps.Item(kind: "text", text: "テスト済", color: "#1a4dbf", sub: "{date}", file: nil, name: nil)
        CustomStamps.add(item)
        let added = CustomStamps.all().contains(item)
        let img = CustomStamps.image(item)
        CustomStamps.remove(item)
        check(added && img != nil && CustomStamps.all() == before, "作ったスタンプを保存・削除する")
    }

    /// 画面とメニューの文字が表示言語になっているか（日本語以外のとき、日本語が残っていない）
    static func uiTextTests(doc: PDFDocument, outDir: URL) {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let menu = AppDelegate().buildMainMenu()
        var texts: [String] = []
        func walk(_ m: NSMenu) {
            for i in m.items {
                // 言語の名前はそれぞれの言語のまま
                if i.title == "言語 / Language" || i.submenu?.title == "Language" { continue }
                texts.append(i.title)
                if let s = i.submenu { texts.append(s.title); walk(s) }
            }
        }
        walk(menu)
        let d = PDFStudioDocument()
        d.setInitialPDF(doc)
        d.makeWindowControllers()
        d.showWindows()
        if let win = d.windowControllers.first?.window {
            win.setFrame(NSRect(x: 0, y: 0, width: 1400, height: 900), display: true)
            RunLoop.main.run(until: Date().addingTimeInterval(1))
            func walkView(_ v: NSView) {
                if let t = v.toolTip { texts.append(t) }
                if let b = v as? NSButton { texts.append(b.title) }
                if let f = v as? NSTextField, !f.isEditable { texts.append(f.stringValue) }
                if let f = v as? NSTextField, let p = f.placeholderString { texts.append(p) }
                if let s = v as? NSSegmentedControl { for k in 0..<s.segmentCount { texts.append(s.label(forSegment: k) ?? ""); texts.append(s.toolTip(forSegment: k) ?? "") } }
                if let p = v as? NSPopUpButton { texts.append(contentsOf: p.itemTitles) }
                if let tv = v as? NSTableView { texts.append(contentsOf: tv.tableColumns.map { $0.title }) }
                v.subviews.forEach(walkView)
            }
            if let cv = win.contentView {
                walkView(cv)
                if let rep = cv.bitmapImageRepForCachingDisplay(in: cv.bounds) {
                    cv.cacheDisplay(in: cv.bounds, to: rep)
                    try? rep.representation(using: .png, properties: [:])?.write(to: outDir.appendingPathComponent("ui_\(I18n.lang).png"))
                }
                // 書式バー：テキスト・矩形ツールのとき
                if let wc = d.windowControllers.first as? MainWindowController {
                    for t in [Tool.text, .rect, .measureArea] {
                        wc.editor.tool = t
                        RunLoop.main.run(until: Date().addingTimeInterval(0.2))
                        walkView(cv)
                        let r = NSRect(x: 0, y: cv.bounds.height - 80, width: cv.bounds.width, height: 80)
                        if let rep = cv.bitmapImageRepForCachingDisplay(in: r) {
                            cv.cacheDisplay(in: r, to: rep)
                            try? rep.representation(using: .png, properties: [:])?.write(to: outDir.appendingPathComponent("formatbar_\(t.rawValue)_\(I18n.lang).png"))
                        }
                    }
                    wc.editor.tool = .select
                }
            }
            win.close()
        }
        let jp = Set(texts.filter { I18n.hasJapanese($0) && !$0.contains("PDF Studio のテスト") })
        if I18n.lang == "ja" {
            check(texts.contains("ファイル"), "日本語の画面（\(texts.count) 個の文字）")
        } else {
            check(jp.isEmpty, "画面とメニューが表示言語になっている（\(I18n.lang)、\(texts.count) 個の文字、日本語のまま: \(jp.sorted().prefix(10).joined(separator: " / "))）")
        }
    }

    static func savePNG(_ page: PDFPage, _ url: URL) {
        let img = Render.pageAsDisplayed(page, dpi: 100)
        if let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) {
            try? rep.representation(using: .png, properties: [:])?.write(to: url)
        }
    }

    /// `--snapshot <pdf> <png>`：ウィンドウを開いて画面を PNG に保存（UI 確認用）
    static func snapshot(pdf: String, png: String) {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        app.mainMenu = NSMenu()
        guard let pdfDoc = PDFDocument(url: URL(fileURLWithPath: pdf)) else { print("PDF を開けません"); return }
        let d = PDFStudioDocument()
        d.setInitialPDF(pdfDoc)
        d.makeWindowControllers()
        d.showWindows()
        guard let wc = d.windowControllers.first as? MainWindowController, let win = wc.window else { return }
        win.setFrame(NSRect(x: 0, y: 0, width: 1400, height: 900), display: true)
        wc.editor.tool = .highlight
        if let p = pdfDoc.page(at: 0), let a = p.annotations.first(where: { $0.type == "FreeText" }) {
            wc.editor.tool = .select
            wc.editor.selectAnnotation(a)
        }
        RunLoop.main.run(until: Date().addingTimeInterval(1.5))
        if let view = win.contentView, let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) {
            view.cacheDisplay(in: view.bounds, to: rep)
            try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: png))
        }
        print("snapshot: \(png)")
    }
}
