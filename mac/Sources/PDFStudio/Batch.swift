import AppKit
import PDFKit

/// 一括処理：複数のファイルにまとめて OCR・透かし・ページ番号・ベイツ番号（通し番号）・フラット化・圧縮・
/// プロパティ・パスワード保護を行い、PDF / Word / テキスト / 画像で保存する。開いている文書には触らない。
enum Batch {
    enum Output: Int, CaseIterable {
        case pdf, docx, txt, png, jpeg
        var title: String { ["PDF", "Word (.docx)", "テキスト (.txt)", "画像 (PNG)", "画像 (JPEG)"][rawValue] }
    }

    struct Options {
        var ocr = false
        var watermark: Operations.WatermarkOptions?
        var pageNumbers = false
        var bates: (prefix: String, start: Int, digits: Int)?
        var flatten = false
        var compress = false
        var title = ""
        var author = ""
        var password = ""
        var output = Output.pdf
        var suffix = "_processed"
        var dpi: CGFloat = 150
    }

    struct Result {
        var done: [URL] = []
        var failed: [(String, String)] = []   // ファイル名, 理由
    }

    /// 1 つのファイルを読み込む（PDF・TIFF・画像）。パスワード付きの PDF は扱わない
    static func load(_ url: URL) throws -> PDFDocument {
        if TiffImport.isTiff(url) {
            let data = try Data(contentsOf: url, options: .mappedIfSafe)
            guard let d = PDFDocument(data: try TiffImport.pdfData(from: data)) else { throw StudioError.message(L("TIFF ファイルとして読み込めませんでした")) }
            return d
        }
        if url.pathExtension.lowercased() == "pdf" {
            guard let d = PDFDocument(url: url) else { throw StudioError.message(L("PDF として読み込めませんでした。")) }
            if d.isLocked { throw StudioError.message(L("パスワードで保護されています")) }
            return d
        }
        let d = Operations.createPDF(from: [url])
        guard d.pageCount > 0 else { throw StudioError.message(L("対応していない形式の可能性があります。")) }
        return d
    }

    /// まとめて処理する。progress(終わった数, 全体の数, ファイル名)。cancelled() が true になったら止める
    static func run(_ urls: [URL], _ o: Options, to folder: URL,
                    progress: (Int, Int, String) -> Void = { _, _, _ in }, cancelled: () -> Bool = { false }) -> Result {
        var result = Result()
        var batesNext = o.bates?.start ?? 1
        let fm = FileManager.default
        for (k, url) in urls.enumerated() {
            if cancelled() { break }
            progress(k, urls.count, url.lastPathComponent)
            do {
                let doc = try load(url)
                let all = Array(0..<doc.pageCount)
                if o.ocr {
                    for i in all {
                        guard let page = doc.page(at: i), !Operations.pageHasText(page) else { continue }
                        if cancelled() { break }
                        let lines = (try? Operations.recognize(page)) ?? []
                        if !lines.isEmpty { Operations.applyOCR(doc, index: i, lines: lines) }
                    }
                }
                if let w = o.watermark { Operations.addWatermark(doc, pages: all, w) }
                if o.pageNumbers { Operations.addHeaderFooter(doc, pages: all, Operations.HeaderFooterOptions()) }
                if let b = o.bates {
                    // ファイルをまたいだ通し番号
                    for i in all {
                        var h = Operations.HeaderFooterOptions()
                        h.footerCenter = ""
                        h.footerRight = b.prefix + String(format: "%0\(max(1, b.digits))d", batesNext)
                        Operations.addHeaderFooter(doc, pages: [i], h)
                        batesNext += 1
                    }
                }
                if o.flatten { Compositor.flattenInPlace(doc) }
                var attrs = doc.documentAttributes ?? [:]
                if !o.title.isEmpty { attrs[PDFDocumentAttribute.titleAttribute.rawValue] = o.title }
                if !o.author.isEmpty { attrs[PDFDocumentAttribute.authorAttribute.rawValue] = o.author }
                doc.documentAttributes = attrs

                let base = url.deletingPathExtension().lastPathComponent + o.suffix
                func unique(_ name: String) -> URL {
                    var u = folder.appendingPathComponent(name)
                    var n = 2
                    while fm.fileExists(atPath: u.path) {
                        u = folder.appendingPathComponent((name as NSString).deletingPathExtension + " (\(n))." + (name as NSString).pathExtension)
                        n += 1
                    }
                    return u
                }
                switch o.output {
                case .pdf:
                    var opts: [PDFDocumentWriteOption: Any] = [:]
                    if !o.password.isEmpty { opts[.userPasswordOption] = o.password; opts[.ownerPasswordOption] = o.password }
                    var data = Compositor.serialize(doc, options: opts)
                    if o.compress, o.password.isEmpty, let d = data, let small = Operations.optimize(doc, original: d.count, strong: false) { data = small }
                    guard let data else { throw StudioError.message(L("PDF の書き出しに失敗しました。")) }
                    let out = unique(base + ".pdf")
                    try data.write(to: out)
                    result.done.append(out)
                case .docx:
                    let out = unique(base + ".docx")
                    try Operations.exportWord(doc, to: out)
                    result.done.append(out)
                case .txt:
                    let out = unique(base + ".txt")
                    try Operations.exportText(doc, to: out)
                    result.done.append(out)
                case .png, .jpeg:
                    let n = try Operations.exportImages(doc, to: folder, baseName: base, jpeg: o.output == .jpeg, dpi: o.dpi)
                    if n == 0 { throw StudioError.message(L("書き出しに失敗しました")) }
                    result.done.append(folder.appendingPathComponent(base))
                }
            } catch {
                result.failed.append((url.lastPathComponent, error.localizedDescription))
            }
        }
        progress(urls.count, urls.count, "")
        return result
    }

    // MARK: - 画面

    /// 一括処理の流れ：ファイルを選ぶ → 処理を選ぶ → 保存先を選ぶ → 実行 → 結果
    static func start(on window: NSWindow?) {
        let urls = Dialog.openFiles(types: [.pdf, .tiff, .image], multiple: true, title: "一括処理するファイルを選んでください（複数可）")
        guard !urls.isEmpty else { return }
        let f = FormBuilder()
        let ocr = f.check("OCR（文字のないページの文字を認識）", false)
        let wm = f.check("透かしを入れる", false)
        let wmText = f.text("透かしの文字", L("社外秘"), width: 200)
        let pn = f.check("ページ番号（下中央「1 / 10」）", false)
        let bates = f.check("ベイツ番号（ファイルをまたいだ通し番号、右下）", false)
        let batesPrefix = f.text("ベイツ番号の接頭辞", "ABC", width: 120)
        let batesStart = f.number("開始番号", 1)
        let flatten = f.check("注釈をフラット化", false)
        let compress = f.check("ファイルサイズを縮小", false)
        let title = f.text("タイトル（空欄で変えない）", "", width: 200)
        let author = f.text("作成者（空欄で変えない）", "", width: 200)
        let pw = f.secure("パスワード（空欄で付けない）")
        let output = f.popup("保存形式", Output.allCases.map(\.title))
        let suffix = f.text("ファイル名に付ける文字", L("_処理済み"), width: 140)
        f.note("元のファイルは変更しません。結果は選んだフォルダーに新しいファイルとして保存します。パスワードは PDF で保存するときだけ付きます。")
        guard f.run(title: "一括処理", message: L("\(urls.count) 個のファイル"), ok: "次へ") else { return }
        guard let folder = Dialog.chooseFolder(title: "保存先のフォルダーを選んでください") else { return }
        var o = Options()
        o.ocr = ocr.state == .on
        if wm.state == .on, !wmText.stringValue.isEmpty { var w = Operations.WatermarkOptions(); w.text = wmText.stringValue; o.watermark = w }
        o.pageNumbers = pn.state == .on
        if bates.state == .on { o.bates = (batesPrefix.stringValue, Int(batesStart.doubleValueOrNil ?? 1), 6) }
        o.flatten = flatten.state == .on
        o.compress = compress.state == .on
        o.title = title.stringValue
        o.author = author.stringValue
        o.password = pw.stringValue
        o.output = Output(rawValue: output.indexOfSelectedItem) ?? .pdf
        o.suffix = suffix.stringValue

        let progress = ProgressSheet(title: L("一括処理しています…"), total: urls.count)
        if let window { progress.begin(on: window) }
        DispatchQueue.global(qos: .userInitiated).async {
            let r = run(urls, o, to: folder, progress: { done, total, name in
                DispatchQueue.main.async { I18n.raw { progress.update(done, total: total, name) } }
            }, cancelled: { progress.cancelled })
            DispatchQueue.main.async {
                progress.end()
                var msg = L("\(r.done.count) 個のファイルを保存しました")
                if !r.failed.isEmpty {
                    msg += "\n\n" + L("できなかったファイル:") + "\n" + r.failed.prefix(10).map { "・\($0.0): \($0.1)" }.joined(separator: "\n")
                }
                let a = NSAlert()
                a.messageText = "一括処理が終わりました"
                I18n.raw { a.informativeText = msg }
                a.addButton(withTitle: "フォルダーを開く")
                a.addButton(withTitle: "閉じる")
                if a.runModal() == .alertFirstButtonReturn { NSWorkspace.shared.open(folder) }
            }
        }
    }
}
