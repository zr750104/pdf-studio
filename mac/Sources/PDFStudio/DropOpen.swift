import AppKit
import PDFKit

/// 文書の画面にファイルをドロップしたときの処理。
/// PDF・TIFF はそのまま開き、画像・Word・テキストは 1 ファイルずつ PDF にして新しい文書で開く。
/// 開けないファイルは名前を出して知らせる（黙って無視しない）
enum DropOpen {
    enum Kind: Equatable { case open, image, richText, plainText }

    static let imageExts: Set<String> = ["png", "jpg", "jpeg", "gif", "bmp", "webp", "heic"]
    static let richExts: Set<String> = ["docx", "rtf", "html", "htm"]
    // 文字だけのファイルは拡張子で絞る（.json や .js などまで PDF にしないように）
    static let plainExts: Set<String> = ["txt", "md", "csv"]

    static func kind(of url: URL) -> Kind? {
        let ext = url.pathExtension.lowercased()
        if ext == "pdf" || TiffImport.isTiff(url) { return .open }
        if imageExts.contains(ext) { return .image }
        if richExts.contains(ext) { return .richText }
        if plainExts.contains(ext) { return .plainText }
        return nil
    }

    /// テキストの文字コードを判定して読む（BOM 付き UTF-8 / UTF-16、UTF-8、Shift_JIS の順）
    static func readText(_ data: Data) -> String? {
        if data.starts(with: [0xEF, 0xBB, 0xBF]) { return String(data: data.dropFirst(3), encoding: .utf8) }
        if data.starts(with: [0xFF, 0xFE]) || data.starts(with: [0xFE, 0xFF]) { return String(data: data, encoding: .utf16) }
        return String(data: data, encoding: .utf8) ?? String(data: data, encoding: .shiftJIS)
    }

    /// 1 つのファイルを PDF にする（開くファイル・対応していないファイル・中身が読めないファイルは nil）
    static func pdf(from url: URL) -> PDFDocument? {
        switch kind(of: url) {
        case .image:
            guard let img = NSImage(contentsOf: url), let page = PDFPage(image: img) else { return nil }
            let doc = PDFDocument()
            doc.insert(page, at: 0)
            return doc
        case .richText:
            guard let attr = try? NSAttributedString(url: url, options: [:], documentAttributes: nil), attr.length > 0 else { return nil }
            return Operations.paginate(attr)
        case .plainText:
            guard let data = try? Data(contentsOf: url), let text = readText(data) else { return nil }
            let font = NSFont(name: "HiraginoSans-W3", size: 11) ?? NSFont.systemFont(ofSize: 11)
            return Operations.paginate(NSAttributedString(string: text.isEmpty ? " " : text, attributes: [.font: font, .foregroundColor: NSColor.black]))
        case .open, nil:
            return nil
        }
    }

    /// ドロップされたファイルを、開くもの・PDF にしたもの・開けなかったもの（名前と理由）に分ける
    static func prepare(_ urls: [URL]) -> (open: [URL], made: [(PDFDocument, String)], skipped: [String]) {
        var open: [URL] = [], made: [(PDFDocument, String)] = [], skipped: [String] = []
        for url in urls {
            let name = url.lastPathComponent
            switch kind(of: url) {
            case .open: open.append(url)
            case nil: skipped.append("\(name): " + L("対応していない形式"))
            default:
                if let doc = pdf(from: url), doc.pageCount > 0 { made.append((doc, url.deletingPathExtension().lastPathComponent + ".pdf")) }
                else { skipped.append("\(name): " + L("読み込めませんでした")) }
            }
        }
        return (open, made, skipped)
    }

    /// ドロップされたファイルを開く
    static func open(_ urls: [URL]) {
        let r = prepare(urls)
        if !r.skipped.isEmpty {
            Dialog.alert(L("次のファイルは PDF にできませんでした"),
                         r.skipped.joined(separator: "\n") + "\n\n" + L("対応している形式: PDF・画像（PNG / JPEG / GIF / BMP / WebP / HEIC / TIFF）・Word（.docx）・RTF・HTML・テキスト（.txt / .md / .csv）"),
                         style: .warning)
        }
        for url in r.open {
            NSDocumentController.shared.openDocument(withContentsOf: url, display: true) { _, _, error in
                if let error, (error as NSError).code != NSUserCancelledError { NSApp.presentError(error) }
            }
        }
        // 作った PDF は保存していないので、閉じるときに確かめる
        for (doc, title) in r.made { PDFStudioDocument.openNew(doc, title: title) }
    }

    /// ドラッグの中のファイル（フォルダーは除く）
    static func fileURLs(_ info: NSDraggingInfo) -> [URL] {
        let urls = info.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []
        return urls.filter { !$0.hasDirectoryPath }
    }
}
