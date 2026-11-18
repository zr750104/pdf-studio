import AppKit
import PDFKit
import UniformTypeIdentifiers

@objc(PDFStudioDocument)
final class PDFStudioDocument: NSDocument {
    private(set) var pdf = PDFDocument()
    /// 保存時のオプション（パスワード保護など）
    var writeOptions: [PDFDocumentWriteOption: Any] = [:]
    /// 測定の縮尺（開いた文書に測定があれば、その縮尺）
    lazy var measureScale: MeasureScale = {
        for i in 0..<pdf.pageCount {
            for a in pdf.page(at: i)?.annotations ?? [] { if let d = Measure.data(of: a) { return d.scale } }
        }
        return .standard
    }()

    override class var autosavesInPlace: Bool { false }
    override class var readableTypes: [String] { [UTType.pdf.identifier, UTType.tiff.identifier] }
    override class var writableTypes: [String] { [UTType.pdf.identifier] }
    override class func isNativeType(_ type: String) -> Bool { true }

    /// 保存・印刷などのシートを出すウィンドウ。並べて表示の中にいるときは、並べているウィンドウ（隠したウィンドウを出さない）
    override var windowForSheet: NSWindow? {
        (windowControllers.first as? MainWindowController)?.hostWindow ?? super.windowForSheet
    }

    override func makeWindowControllers() {
        addWindowController(MainWindowController(document: self))
    }

    func setInitialPDF(_ doc: PDFDocument) {
        pdf = doc
    }

    // MARK: 読み込み・保存

    override func read(from data: Data, ofType typeName: String) throws {
        guard let doc = PDFDocument(data: data) else {
            throw StudioError.message("PDF として読み込めませんでした。")
        }
        if doc.isLocked {
            var unlocked = false
            let fileName = fileURL?.lastPathComponent ?? L("文書")
            while !unlocked {
                guard let pw = Dialog.password("このPDFはパスワードで保護されています",
                                               message: "\(fileName) を開くパスワードを入力してください。") else {
                    throw NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError)
                }
                unlocked = doc.unlock(withPassword: pw)
                if unlocked {
                    // 保存しても保護が外れないようにパスワードを引き継ぐ
                    writeOptions[.userPasswordOption] = pw
                    writeOptions[.ownerPasswordOption] = pw
                }
            }
        }
        pdf = doc
    }

    override func data(ofType typeName: String) throws -> Data {
        guard let data = Compositor.serialize(pdf, options: writeOptions) else {
            throw StudioError.message("PDF の書き出しに失敗しました。")
        }
        return data
    }

    override func printOperation(withSettings printSettings: [NSPrintInfo.AttributeKey: Any]) throws -> NSPrintOperation {
        let info = printInfo.copy() as! NSPrintInfo
        info.dictionary().addEntries(from: printSettings)
        guard let op = pdf.printOperation(for: info, scalingMode: .pageScaleToFit, autoRotate: true) else {
            throw StudioError.message("印刷を準備できませんでした。")
        }
        return op
    }

    // MARK: 構造変更（スナップショットで取り消し）

    /// ページ操作などの大きな変更。変更前の状態を保存しておき、取り消しで丸ごと戻す。
    func performStructuralChange(_ name: String, _ body: (PDFDocument) throws -> Void) rethrows {
        let snapshot = Compositor.serialize(pdf)
        try body(pdf)
        if let snapshot {
            undoManager?.registerUndo(withTarget: self) { $0.restore(snapshot, name: name) }
            undoManager?.setActionName(L(name))
        } else {
            updateChangeCount(.changeDone)
        }
        NotificationCenter.default.post(name: .studioPagesChanged, object: self)
    }

    private func restore(_ data: Data, name: String) {
        let current = Compositor.serialize(pdf)
        guard let doc = PDFDocument(data: data) else { return }
        replacePDF(doc)
        if let current {
            undoManager?.registerUndo(withTarget: self) { $0.restore(current, name: name) }
            undoManager?.setActionName(L(name))
        }
    }

    /// 文書オブジェクトそのものを入れ替える（取り消し・フラット化など）
    func replacePDF(_ doc: PDFDocument) {
        doc.documentAttributes = doc.documentAttributes ?? pdf.documentAttributes
        pdf = doc
        NotificationCenter.default.post(name: .studioDocumentReplaced, object: self)
    }

    // MARK: 新規文書を開く

    @discardableResult
    static func openNew(_ doc: PDFDocument, title: String) -> PDFStudioDocument {
        let d = PDFStudioDocument()
        d.pdf = doc
        d.displayName = title
        NSDocumentController.shared.addDocument(d)
        d.makeWindowControllers()
        d.showWindows()
        d.updateChangeCount(.changeDone)
        return d
    }
}

final class PDFStudioDocumentController: NSDocumentController {
    override var documentClassNames: [String] { ["PDFStudioDocument"] }
    override var defaultType: String? { UTType.pdf.identifier }
    override func documentClass(forType typeName: String) -> AnyClass? { PDFStudioDocument.self }
    override func typeForContents(of url: URL) throws -> String { UTType.pdf.identifier }
    override func displayName(forType typeName: String) -> String? { "PDF 書類" }

    override func runModalOpenPanel(_ openPanel: NSOpenPanel, forTypes types: [String]?) -> Int {
        openPanel.allowedContentTypes = [.pdf, .tiff]
        return super.runModalOpenPanel(openPanel, forTypes: nil)
    }

    /// TIFF は PDF にしてから、名前のない新しい文書として開く（元の TIFF を PDF で上書きしないように）
    override func openDocument(withContentsOf url: URL, display displayDocument: Bool,
                               completionHandler: @escaping (NSDocument?, Bool, Error?) -> Void) {
        guard TiffImport.isTiff(url) else {
            super.openDocument(withContentsOf: url, display: displayDocument, completionHandler: completionHandler)
            return
        }
        let progress = ProgressSheet(title: L("TIFF を開いています"), total: 1)
        let parent = NSApp.keyWindow
        if let parent { progress.begin(on: parent) }
        let started = Date()
        DispatchQueue.global(qos: .userInitiated).async {
            let result = Result { () -> Data in
                let data = try Data(contentsOf: url, options: .mappedIfSafe)
                return try TiffImport.pdfData(from: data) { done, total in
                    DispatchQueue.main.async { progress.update(done, total: total, L("TIFF を読み込んでいます…")) }
                }
            }
            DispatchQueue.main.async {
                progress.end()
                switch result {
                case .success(let pdfData):
                    guard let doc = PDFDocument(data: pdfData) else {
                        completionHandler(nil, false, StudioError.message(L("TIFF ファイルとして読み込めませんでした")))
                        return
                    }
                    let s = TiffImport.lastStats
                    NSLog("tiff open: pages=%d passthrough=%d g4=%d jpeg=%d %.1fs", s.pages, s.passthrough, s.reencodedG4, s.jpeg, Date().timeIntervalSince(started))
                    self.noteNewRecentDocumentURL(url)
                    let d = PDFStudioDocument.openNew(doc, title: url.deletingPathExtension().lastPathComponent + ".pdf")
                    completionHandler(d, false, nil)
                    if s.failed > 0 { Dialog.alert("読み込めないページがありました", L("\(s.failed) ページを読み込めなかったため、除いて開きました。"), style: .warning) }
                case .failure(let error):
                    completionHandler(nil, false, error)
                }
            }
        }
    }
}
