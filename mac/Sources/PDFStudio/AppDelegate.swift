import AppKit
import PDFKit
import UniformTypeIdentifiers

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let recentMenu = NSMenu(title: "最近使った項目を開く")

    func applicationWillFinishLaunching(_ notification: Notification) {
        NSApp.mainMenu = buildMainMenu()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // コマンドライン引数で渡された PDF を開く（開発時用）
        for arg in CommandLine.arguments.dropFirst() where arg.lowercased().hasSuffix(".pdf") {
            NSDocumentController.shared.openDocument(withContentsOf: URL(fileURLWithPath: arg), display: true) { _, _, _ in }
        }
        // エラーの記録と、前回が予期せず終了していたときの報告のおすすめ
        ErrorLog.startSession()
        NSApp.activate(ignoringOtherApps: true)
        // 新しい版のお知らせ（起動が落ち着いてから、1 日 1 回まで）
        DispatchQueue.main.asyncAfter(deadline: .now() + 6) { UpdateCheck.checkAtLaunch() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
            if NSDocumentController.shared.documents.isEmpty { self.showWelcome() }
        }
    }

    func applicationShouldOpenUntitledFile(_ sender: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { showWelcome() }
        return true
    }

    private func showWelcome() {
        let a = NSAlert()
        a.messageText = "PDF Studio"
        a.informativeText = "PDF を開くか、画像・Word・テキストなどから新しい PDF を作成します。"
        a.addButton(withTitle: "PDF を開く…")
        a.addButton(withTitle: "ファイルから PDF を作成…")
        a.addButton(withTitle: "複数の PDF を結合…")
        a.addButton(withTitle: "閉じる")
        switch a.runModal() {
        case .alertFirstButtonReturn: NSDocumentController.shared.openDocument(nil)
        case .alertSecondButtonReturn: createFromFiles(nil)
        case .alertThirdButtonReturn: mergeFiles(nil)
        default: break
        }
    }

    // MARK: - ファイル作成・結合

    @objc func createFromFiles(_ sender: Any?) {
        var types: [UTType] = [.pdf, .image, .plainText, .rtf, .html]
        if let docx = UTType(filenameExtension: "docx") { types.append(docx) }
        if let doc = UTType(filenameExtension: "doc") { types.append(doc) }
        if let odt = UTType(filenameExtension: "odt") { types.append(odt) }
        let urls = Dialog.openFiles(types: types, multiple: true, title: "PDF にするファイルを選んでください（複数可・選択順に結合）")
        guard !urls.isEmpty else { return }
        let doc = Operations.createPDF(from: urls)
        guard doc.pageCount > 0 else { Dialog.alert("PDF を作成できませんでした", "対応していない形式の可能性があります。"); return }
        PDFStudioDocument.openNew(doc, title: urls.count == 1 ? urls[0].deletingPathExtension().lastPathComponent : L("新規 PDF"))
    }

    @objc func mergeFiles(_ sender: Any?) {
        let urls = Dialog.openFiles(types: [.pdf, .image], multiple: true, title: "結合するファイルを選んでください（名前順に結合されます）")
        guard urls.count >= 1 else { return }
        let sorted = urls.sorted { $0.lastPathComponent.localizedStandardCompare($1.lastPathComponent) == .orderedAscending }
        let doc = Operations.createPDF(from: sorted)
        guard doc.pageCount > 0 else { return }
        PDFStudioDocument.openNew(doc, title: L("結合した PDF"))
    }

    @objc func batchProcess(_ sender: Any?) { Batch.start(on: NSApp.keyWindow) }

    @objc func newBlankDocument(_ sender: Any?) {
        let doc = PDFDocument()
        if let p = Operations.blankPage() { doc.insert(p, at: 0) }
        PDFStudioDocument.openNew(doc, title: L("名称未設定"))
    }

    @objc func openRecent(_ sender: NSMenuItem) {
        guard let url = sender.representedObject as? URL else { return }
        NSDocumentController.shared.openDocument(withContentsOf: url, display: true) { _, _, error in
            if let error { NSApp.presentError(error) }
        }
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        guard menu === recentMenu else { return }
        menu.removeAllItems()
        for url in NSDocumentController.shared.recentDocumentURLs {
            let i = I18n.raw { NSMenuItem(title: url.lastPathComponent, action: #selector(openRecent(_:)), keyEquivalent: "") }
            i.representedObject = url
            i.target = self
            i.image = NSWorkspace.shared.icon(forFile: url.path)
            i.image?.size = NSSize(width: 16, height: 16)
            menu.addItem(i)
        }
        if menu.items.isEmpty { menu.addItem(withTitle: "（なし）", action: nil, keyEquivalent: "") }
        menu.addItem(.separator())
        menu.addItem(withTitle: "メニューを消去", action: #selector(NSDocumentController.clearRecentDocuments(_:)), keyEquivalent: "")
    }

    @objc func checkForUpdates(_ sender: Any?) { UpdateCheck.check(manual: true) }
    @objc func openReleases(_ sender: Any?) { NSWorkspace.shared.open(UpdateCheck.releasesPage) }
    @objc func reportProblem(_ sender: Any?) { ErrorLog.report() }
    @objc func toggleErrorPrompt(_ sender: NSMenuItem) {
        ErrorLog.promptEnabled.toggle()
        sender.state = ErrorLog.promptEnabled ? .on : .off
    }

    /// 言語を切り替える（保存して、アプリを開き直すと切り替わる）
    @objc func changeLanguage(_ sender: NSMenuItem) {
        guard let l = sender.representedObject as? String, l != I18n.lang else { return }
        I18n.save(l)
        let a = NSAlert()
        // 選んだ言語で案内する
        a.messageText = I18n.raw { I18n.tr("言語を切り替えるには PDF Studio を開き直してください", l, record: false) }
        a.informativeText = I18n.raw { I18n.tr("今すぐ開き直しますか？ 保存していない変更があれば確認します。", l, record: false) }
        _ = I18n.raw { a.addButton(withTitle: I18n.tr("今すぐ開き直す", l, record: false)) }
        _ = I18n.raw { a.addButton(withTitle: I18n.tr("あとで", l, record: false)) }
        guard a.runModal() == .alertFirstButtonReturn else { return }
        // 終了する（保存の確認で取り消されたら開き直さない）。終了が決まったら applicationWillTerminate で起動し直す
        // 保存の確認は終了の途中で非同期に出るため、印は時刻で持つ（確認で取り消したあと、ずっと後の終了では開き直さない）
        relaunchRequested = Date()
        NSApp.terminate(nil)
    }

    private var relaunchRequested: Date?

    func applicationWillTerminate(_ notification: Notification) {
        ErrorLog.endSession()
        guard let r = relaunchRequested, Date().timeIntervalSince(r) < 120, Bundle.main.bundleURL.pathExtension == "app" else { return }
        // もう 1 つ起動してから終わる（外部のコマンドは使わない）
        let cfg = NSWorkspace.OpenConfiguration()
        cfg.createsNewApplicationInstance = true
        let done = DispatchSemaphore(value: 0)
        NSWorkspace.shared.openApplication(at: Bundle.main.bundleURL, configuration: cfg) { _, _ in done.signal() }
        _ = done.wait(timeout: .now() + 5)
    }

    @objc func showHelp(_ sender: Any?) {
        let text = NSMutableAttributedString()
        let h: [NSAttributedString.Key: Any] = [.font: NSFont.boldSystemFont(ofSize: 15)]
        let b: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 13)]
        let sections: [(String, String)] = [
            ("基本操作", "ツールバー左から：選択 / 手のひら、注釈（ハイライト・下線・取り消し線・付箋・テキストボックス・既存テキスト編集）、図形（手書き・矩形・楕円・直線・矢印）、画像・署名・スタンプ、墨消し・トリミング・リンク、フォーム作成、消しゴム。\nEsc で選択ツールに戻ります。選択中の注釈は Delete で削除、矢印キーで移動（Shift で 10pt）。"),
            ("ページの整理", "左サイドバーのサムネイルをドラッグして並べ替え。右クリックで回転・削除・複製・挿入・抽出。Finder から PDF や画像をサムネイル欄にドロップすると挿入できます。"),
            ("既存テキストの編集", "「既存テキストを編集」ツールで行をクリックすると、元の文字を白で覆って新しい文字を同じ位置に配置します。完全に置き換えるには「文書 > 注釈をフラット化」を実行してください。"),
            ("墨消し", "墨消しツールで範囲をドラッグするか、検索パネルの「すべてに墨消しマーク」でマークし、「文書 > 墨消しを適用」で確定します。対象ページは画像化され、下の文字情報は完全に削除されます。"),
            ("OCR", "「文書 > テキスト認識（OCR）」で、スキャン PDF の文字を認識して検索・コピー可能にします（日本語対応、端末内で処理）。"),
            ("保護", "「文書 > パスワードで保護」で開くパスワードと権限（印刷・コピー・編集）を設定できます。保存時に暗号化されます。"),
            ("書き出し", "「ファイル > 書き出し」から Word（.docx）・RTF・テキスト・画像（PNG/JPEG）に変換。「ファイルサイズを縮小して保存」で画像を圧縮できます。"),
            ("寸法の測定", "ツールバーの定規ツールで距離（ドラッグ）、周長・面積（クリックで頂点、ダブルクリックか Enter で確定）を測ります。「文書 > 測定の縮尺」で 1:100 などの縮尺と単位を、「文書 > 縮尺を合わせる」で図面の寸法線から縮尺を設定できます。測定は選択して頂点をドラッグすると調整できます。"),
            ("タブと並べて表示", "複数の文書はタブで開きます。「表示 > 並べて表示」で、同じウィンドウのタブを左右・上下・最大 4 画面に並べられます。メニューやキーの操作は、枠の付いた画面（最後にクリックした画面）に効きます。"),
            ("スタンプ・画像", "スタンプツールで日本語・英語のスタンプ、印鑑、日付印のほか、自分で作った文字・画像のスタンプを押せます。文字スタンプの下段の {date}・{time}・{name} は押した時の値になります。置いたスタンプ・画像・署名は保存後も動かせます。"),
            ("一括処理", "「ファイル > 一括処理」で、複数のファイルにまとめて OCR・透かし・ページ番号・ベイツ番号（通し番号）・フラット化・圧縮・プロパティ・パスワードを付け、PDF / Word / テキスト / 画像で保存できます。"),
            ("表示", "テンキーの ＋／－ で拡大・縮小します。手のひらツールで払うように動かすと滑ってスクロールします。横に 2 ページ以上入るほど縮小すると、ページを横に並べた一覧になり、ページをクリックすると戻ります。TIFF（複数ページ）も開けます。言語は「PDF Studio > 言語 / Language」で切り替えます。")
        ]
        for (t, s) in sections {
            text.append(NSAttributedString(string: L(t) + "\n", attributes: h))
            text.append(NSAttributedString(string: L(s) + "\n\n", attributes: b))
        }
        ReportWindow.show(title: "PDF Studio ヘルプ", text: text)
    }

    // MARK: - メニュー

    func buildMainMenu() -> NSMenu {
        let main = NSMenu()
        func submenu(_ title: String, _ items: [NSMenuItem]) -> NSMenuItem {
            let top = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            let m = NSMenu(title: title)
            items.forEach { m.addItem($0) }
            top.submenu = m
            main.addItem(top)
            return top
        }
        func item(_ title: String, _ action: Selector?, _ key: String = "", _ mods: NSEvent.ModifierFlags = [.command], tag: Int = 0, target: AnyObject? = nil) -> NSMenuItem {
            let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
            i.keyEquivalentModifierMask = key.isEmpty ? [] : mods
            i.tag = tag
            i.target = target
            return i
        }
        func sep() -> NSMenuItem { .separator() }
        typealias W = MainWindowController

        _ = submenu("PDF Studio", [
            item("PDF Studio について", #selector(NSApplication.orderFrontStandardAboutPanel(_:))),
            item("アップデートを確認...", #selector(checkForUpdates(_:)), target: self),
            sep(),
            item("PDF Studio を隠す", #selector(NSApplication.hide(_:)), "h"),
            item("ほかを隠す", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
            item("すべてを表示", #selector(NSApplication.unhideAllApplications(_:))),
            sep(),
            item("PDF Studio を終了", #selector(NSApplication.terminate(_:)), "q")
        ])

        // 言語（名前はそれぞれの言語のまま表示する）
        let langItem = NSMenuItem(title: "言語 / Language", action: nil, keyEquivalent: "")
        let lm = I18n.raw { NSMenu(title: "Language") }
        for l in I18n.langs {
            let i = I18n.raw { NSMenuItem(title: I18n.names[l] ?? l, action: #selector(changeLanguage(_:)), keyEquivalent: "") }
            i.representedObject = l
            i.target = self
            i.state = l == I18n.lang ? .on : .off
            lm.addItem(i)
        }
        langItem.submenu = lm
        main.items.first?.submenu?.insertItem(langItem, at: 2)
        main.items.first?.submenu?.insertItem(.separator(), at: 3)

        let recent = NSMenuItem(title: "最近使った項目を開く", action: nil, keyEquivalent: "")
        recentMenu.delegate = self
        recent.submenu = recentMenu

        let exportMenu = NSMenuItem(title: "書き出し", action: nil, keyEquivalent: "")
        let em = NSMenu(title: "書き出し")
        [item("Word 文書（.docx）…", #selector(W.exportWord(_:))),
         item("リッチテキスト（.rtf）…", #selector(W.exportRTF(_:))),
         item("テキスト（.txt）…", #selector(W.exportText(_:))),
         item("画像（PNG / JPEG）…", #selector(W.exportImages(_:)))].forEach { em.addItem($0) }
        exportMenu.submenu = em

        _ = submenu("ファイル", [
            item("新規（空白ページ）", #selector(newBlankDocument(_:)), "n", target: self),
            item("ファイルから PDF を作成…", #selector(createFromFiles(_:)), "n", [.command, .shift], target: self),
            item("複数のファイルを結合…", #selector(mergeFiles(_:)), "m", [.command, .shift], target: self),
            item("一括処理...", #selector(batchProcess(_:)), "b", [.command, .shift], target: self),
            sep(),
            item("開く…", #selector(NSDocumentController.openDocument(_:)), "o"),
            recent,
            sep(),
            item("閉じる", #selector(NSWindow.performClose(_:)), "w"),
            item("保存", #selector(NSDocument.save(_:)), "s"),
            item("別名で保存…", #selector(NSDocument.saveAs(_:)), "s", [.command, .shift]),
            item("ファイルサイズを縮小して保存…", #selector(W.saveOptimized(_:))),
            item("保存した状態に戻す", #selector(NSDocument.revertToSaved(_:))),
            sep(),
            exportMenu,
            sep(),
            item("ページ設定…", #selector(NSDocument.runPageLayout(_:)), "p", [.command, .shift]),
            item("プリント…", #selector(NSDocument.printDocument(_:)), "p")
        ])

        _ = submenu("編集", [
            item("取り消す", Selector(("undo:")), "z"),
            item("やり直す", Selector(("redo:")), "z", [.command, .shift]),
            sep(),
            item("カット", #selector(NSText.cut(_:)), "x"),
            item("コピー", #selector(NSText.copy(_:)), "c"),
            item("ペースト", #selector(NSText.paste(_:)), "v"),
            item("削除", #selector(EditorPDFView.delete(_:))),
            item("すべてを選択", #selector(NSText.selectAll(_:)), "a"),
            sep(),
            item("検索…", #selector(W.showSearch(_:)), "f"),
            sep(),
            item("絵文字と記号", #selector(NSApplication.orderFrontCharacterPalette(_:)), " ", [.command, .control])
        ])

        // 並べて表示（同じウィンドウのタブの文書を 1 つのウィンドウに並べる）
        let splitMenu = NSMenuItem(title: "並べて表示", action: nil, keyEquivalent: "")
        let sm = NSMenu(title: "並べて表示")
        let splitKeys = ["1", "2", "3", "4"]
        for m in SplitMode.allCases {
            sm.addItem(item(m.title, #selector(W.setSplitMode(_:)), splitKeys[m.rawValue], [.command, .control], tag: m.rawValue))
        }
        splitMenu.submenu = sm

        let displayModes = ["単一ページ", "単一ページ（連続）", "見開き", "見開き（連続）"].enumerated().map {
            item($0.element, #selector(W.setDisplayMode(_:)), tag: $0.offset)
        }
        _ = submenu("表示", [
            item("拡大", #selector(W.zoomInAction(_:)), "+"),
            item("縮小", #selector(W.zoomOutAction(_:)), "-"),
            item("実際のサイズ", #selector(W.zoomActual(_:)), "0"),
            item("ウィンドウに合わせる", #selector(W.zoomFit(_:)), "9"),
            item("幅に合わせる", #selector(W.zoomFitWidth(_:)), "8"),
            sep()
        ] + displayModes + [
            item("ブック表示（表紙を単独）", #selector(W.toggleBookMode(_:))),
            sep(),
            item("前のページ", #selector(W.previousPage(_:)), String(Character(UnicodeScalar(NSUpArrowFunctionKey)!)), [.command, .option]),
            item("次のページ", #selector(W.nextPage(_:)), String(Character(UnicodeScalar(NSDownArrowFunctionKey)!)), [.command, .option]),
            item("最初のページ", #selector(W.firstPage(_:)), String(Character(UnicodeScalar(NSUpArrowFunctionKey)!))),
            item("最後のページ", #selector(W.lastPage(_:)), String(Character(UnicodeScalar(NSDownArrowFunctionKey)!))),
            item("ページへ移動…", #selector(W.goToPagePrompt(_:)), "g", [.command, .option]),
            sep(),
            splitMenu,
            sep(),
            item("サイドバー", #selector(W.toggleSidebarPanel(_:)), "s", [.command, .control]),
            item("書式バー", #selector(W.toggleInspectorPanel(_:)), "i", [.command, .option]),
            item("フルスクリーン", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control])
        ])

        var toolItems: [NSMenuItem] = []
        for (gi, group) in Tool.groups.enumerated() {
            for t in group {
                let i = item(t.title + (t.keyEquivalent.isEmpty ? "" : "\t\(t.keyEquivalent.uppercased())"), #selector(W.selectTool(_:)), tag: Tool.allCases.firstIndex(of: t)!)
                toolItems.append(i)
            }
            if gi < Tool.groups.count - 1 { toolItems.append(sep()) }
        }
        _ = submenu("ツール", toolItems)

        _ = submenu("ページ", [
            item("右に90°回転", #selector(W.rotateRight(_:)), "r"),
            item("左に90°回転", #selector(W.rotateLeft(_:)), "l"),
            sep(),
            item("空白ページを挿入", #selector(W.insertBlankPage(_:)), "n", [.command, .option]),
            item("ファイルからページを挿入…", #selector(W.insertFromFile(_:)), "i", [.command, .shift]),
            item("ページを複製", #selector(W.duplicatePages(_:)), "d"),
            item("ページの大きさをそろえる…", #selector(W.normalizePageSize(_:))),
            item("ページを抽出…", #selector(W.extractPages(_:)), "e", [.command, .option]),
            item("文書を分割…", #selector(W.splitDocument(_:))),
            sep(),
            item("ページを削除", #selector(W.deletePages(_:)), "\u{8}", [.command, .shift])
        ])

        _ = submenu("文書", [
            item("テキスト認識（OCR）…", #selector(W.runOCR(_:)), "o", [.command, .option]),
            sep(),
            item("透かしを追加…", #selector(W.addWatermark(_:))),
            item("ヘッダーとフッター / ページ番号…", #selector(W.addHeaderFooter(_:))),
            item("ベイツ番号を付与…", #selector(W.addBates(_:))),
            sep(),
            item("墨消しを適用…", #selector(W.applyRedactions(_:))),
            item("注釈をフラット化…", #selector(W.flattenAnnotations(_:))),
            sep(),
            item("パスワードで保護…", #selector(W.setPassword(_:))),
            item("パスワード保護を解除", #selector(W.removePassword(_:))),
            sep(),
            item("測定の縮尺...", #selector(W.measureScaleDialog(_:))),
            item("縮尺を合わせる（キャリブレーション）...", #selector(W.calibrateScale(_:))),
            sep(),
            item("文書を比較…", #selector(W.compareDocuments(_:))),
            item("重ねて比較（図面）…", #selector(W.compareOverlay(_:))),
            item("文書のプロパティ…", #selector(W.editProperties(_:)), "d", [.command, .option])
        ])

        let windowMenu = submenu("ウインドウ", [
            item("しまう", #selector(NSWindow.performMiniaturize(_:)), "m"),
            item("拡大／縮小", #selector(NSWindow.performZoom(_:))),
            sep(),
            item("すべてを手前に移動", #selector(NSApplication.arrangeInFront(_:)))
        ])
        NSApp.windowsMenu = windowMenu.submenu

        let promptItem = item("エラー発生時に報告をすすめる", #selector(toggleErrorPrompt(_:)), target: self)
        promptItem.state = ErrorLog.promptEnabled ? .on : .off
        let help = submenu("ヘルプ", [
            item("PDF Studio ヘルプ", #selector(showHelp(_:)), "?", target: self),
            sep(),
            item("不具合を報告（エラーログを送信）...", #selector(reportProblem(_:)), target: self),
            promptItem,
            sep(),
            item("アップデートを確認...", #selector(checkForUpdates(_:)), target: self),
            item("配布ページを開く", #selector(openReleases(_:)), target: self)
        ])
        NSApp.helpMenu = help.submenu
        return main
    }
}
