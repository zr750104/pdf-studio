import AppKit
import PDFKit
import UniformTypeIdentifiers

final class MainWindowController: NSWindowController, NSWindowDelegate, NSMenuItemValidation {
    let editor = EditorPDFView()
    let sidebar = SidebarViewController()
    let inspector = InspectorViewController()
    private let split = NSSplitViewController()
    private var sidebarItem: NSSplitViewItem!
    /// 書式バー（ツールバーの下）の高さ。隠すときは 0
    private var formatBarHeight: NSLayoutConstraint!
    private let studio: PDFStudioDocument
    private var toolButtons: [Tool: NSButton] = [:]
    private let pageField = NSTextField(string: "1")
    private let pageCountLabel = NSTextField(labelWithString: "/ 1")
    private let zoomLabel = NSTextField(labelWithString: "100%")
    private var centerItem: NSSplitViewItem!

    // 並べて表示（SplitPanes.swift）
    /// この画面の中身（ツールバー・サイドバー・ページ）。並べて表示のときはほかのウィンドウに移す
    private(set) var rootController = NSViewController()
    /// この画面を並べているウィンドウ（並べられていなければ nil）
    weak var embeddedIn: MainWindowController?
    var splitMode: SplitMode = .single
    var splitPanes: [MainWindowController] = []
    var paneContainers: [PaneContainer] = []
    var savedLayout: [(Bool, Bool)] = []
    var paneOriginalNextResponder: NSResponder?
    var splitObservation: NSKeyValueObservation?
    var splitTimer: Timer?
    var sidebarCollapsed: Bool { sidebarItem.isCollapsed }
    var inspectorCollapsed: Bool { inspector.view.isHidden }

    /// 書式バーを出す・隠す
    func setFormatBarHidden(_ hidden: Bool) {
        inspector.view.isHidden = hidden
        formatBarHeight.constant = hidden ? 0 : InspectorViewController.barHeight
    }

    /// 並べて表示のときは、並べた側のサイドバーを閉じて狭くても使えるようにする
    func setCompactForSplit(_ on: Bool, keepSidebar: Bool) {
        if on {
            if !keepSidebar { sidebarItem.isCollapsed = true }
            centerItem.minimumThickness = 200
        } else {
            centerItem.minimumThickness = 400
        }
    }

    func restoreLayout(_ s: (Bool, Bool)) {
        setCompactForSplit(false, keepSidebar: true)
        sidebarItem.isCollapsed = s.0
        setFormatBarHidden(s.1)
    }

    init(document: PDFStudioDocument) {
        studio = document
        let win = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1320, height: 880),
                           styleMask: [.titled, .closable, .miniaturizable, .resizable],
                           backing: .buffered, defer: false)
        win.minSize = NSSize(width: 900, height: 560)
        win.tabbingMode = .preferred
        super.init(window: win)
        win.delegate = self
        buildUI()
        win.setContentSize(NSSize(width: 1320, height: 880))
        win.center()
        win.setFrameAutosaveName("PDFStudioMainWindow")
    }

    required init?(coder: NSCoder) { nil }

    // MARK: - 画面構成

    private func buildUI() {
        editor.studioDocument = studio
        editor.document = studio.pdf
        editor.autoScales = true
        editor.displayMode = .singlePageContinuous
        editor.displaysPageBreaks = true
        editor.pageShadowsEnabled = true
        editor.backgroundColor = NSColor(named: "controlBackgroundColor") ?? .underPageBackgroundColor

        sidebar.editor = editor
        sidebar.studio = studio
        sidebar.controller = self
        inspector.editor = editor

        sidebarItem = NSSplitViewItem(sidebarWithViewController: sidebar)
        sidebarItem.minimumThickness = 190
        sidebarItem.maximumThickness = 380
        sidebarItem.canCollapse = true
        let center = NSViewController()
        center.view = editor
        centerItem = NSSplitViewItem(viewController: center)
        centerItem.minimumThickness = 400
        split.splitViewItems = [sidebarItem, centerItem]

        let root = rootController
        let rootView = NSView()
        root.view = rootView
        root.addChild(split)
        root.addChild(inspector)
        let bar = makeToolStrip()
        bar.translatesAutoresizingMaskIntoConstraints = false
        split.view.translatesAutoresizingMaskIntoConstraints = false
        let fbar = inspector.view
        fbar.translatesAutoresizingMaskIntoConstraints = false
        rootView.addSubview(bar)
        rootView.addSubview(fbar)
        rootView.addSubview(split.view)
        formatBarHeight = fbar.heightAnchor.constraint(equalToConstant: InspectorViewController.barHeight)
        NSLayoutConstraint.activate([
            bar.topAnchor.constraint(equalTo: rootView.topAnchor),
            bar.leadingAnchor.constraint(equalTo: rootView.leadingAnchor),
            bar.trailingAnchor.constraint(equalTo: rootView.trailingAnchor),
            bar.heightAnchor.constraint(equalToConstant: 44),
            fbar.topAnchor.constraint(equalTo: bar.bottomAnchor),
            fbar.leadingAnchor.constraint(equalTo: rootView.leadingAnchor),
            fbar.trailingAnchor.constraint(equalTo: rootView.trailingAnchor),
            formatBarHeight,
            split.view.topAnchor.constraint(equalTo: fbar.bottomAnchor),
            split.view.leadingAnchor.constraint(equalTo: rootView.leadingAnchor),
            split.view.trailingAnchor.constraint(equalTo: rootView.trailingAnchor),
            split.view.bottomAnchor.constraint(equalTo: rootView.bottomAnchor)
        ])
        window?.contentViewController = root

        sidebar.configure()
        inspector.configure()

        let nc = NotificationCenter.default
        nc.addObserver(self, selector: #selector(pageChanged), name: .PDFViewPageChanged, object: editor)
        nc.addObserver(self, selector: #selector(pageChanged), name: .PDFViewScaleChanged, object: editor)
        nc.addObserver(self, selector: #selector(toolChanged), name: .studioToolChanged, object: editor)
        nc.addObserver(self, selector: #selector(documentReplaced), name: .studioDocumentReplaced, object: studio)
        nc.addObserver(self, selector: #selector(pagesChanged), name: .studioPagesChanged, object: studio)
        toolChanged()
        pageChanged()
    }

    private func makeToolStrip() -> NSView {
        let bg = NSVisualEffectView()
        bg.material = .titlebar
        bg.blendingMode = .withinWindow
        let stack = NSStackView()
        stack.orientation = .horizontal
        stack.spacing = 2
        stack.edgeInsets = NSEdgeInsets(top: 0, left: 10, bottom: 0, right: 10)

        func iconButton(_ symbol: String, _ tip: String, _ action: Selector) -> NSButton {
            let img = NSImage(systemSymbolName: symbol, accessibilityDescription: tip) ?? NSImage(systemSymbolName: "questionmark", accessibilityDescription: tip)!
            let b = NSButton(image: img, target: self, action: action)
            b.bezelStyle = .recessed
            b.showsBorderOnlyWhileMouseInside = true
            b.toolTip = tip
            b.widthAnchor.constraint(equalToConstant: 30).isActive = true
            return b
        }
        func separator() -> NSView {
            let b = NSBox()
            b.boxType = .separator
            b.heightAnchor.constraint(equalToConstant: 22).isActive = true
            let wrap = NSView()
            wrap.addSubview(b)
            b.translatesAutoresizingMaskIntoConstraints = false
            NSLayoutConstraint.activate([
                wrap.widthAnchor.constraint(equalToConstant: 12),
                b.centerXAnchor.constraint(equalTo: wrap.centerXAnchor),
                b.centerYAnchor.constraint(equalTo: wrap.centerYAnchor),
                b.widthAnchor.constraint(equalToConstant: 1)
            ])
            return wrap
        }

        stack.addArrangedSubview(iconButton("sidebar.left", "サイドバーの表示/非表示", #selector(toggleSidebarPanel(_:))))
        stack.addArrangedSubview(separator())
        for (gi, group) in Tool.groups.enumerated() {
            for t in group {
                let b = iconButton(t.symbol, t.title + (t.keyEquivalent.isEmpty ? "" : "（\(t.keyEquivalent.uppercased())）"), #selector(toolButtonClicked(_:)))
                b.setButtonType(.pushOnPushOff)
                b.tag = Tool.allCases.firstIndex(of: t)!
                toolButtons[t] = b
                stack.addArrangedSubview(b)
            }
            if gi < Tool.groups.count - 1 { stack.addArrangedSubview(separator()) }
        }
        // 狭いとき（並べて表示など）は、後ろのツールから隠す。ページ移動・拡大縮小は最後まで残す
        let toolViews = stack.arrangedSubviews
        for (k, v) in toolViews.enumerated() where k > 0 {
            let p = 900 - Float(k) * 10
            stack.setVisibilityPriority(NSStackView.VisibilityPriority(rawValue: max(100, p)), for: v)
        }

        let spacer = NSView()
        spacer.setContentHuggingPriority(.init(1), for: .horizontal)
        stack.addArrangedSubview(spacer)

        pageField.alignment = .center
        pageField.widthAnchor.constraint(equalToConstant: 44).isActive = true
        pageField.target = self
        pageField.action = #selector(pageFieldEntered)
        zoomLabel.alignment = .center
        zoomLabel.widthAnchor.constraint(equalToConstant: 46).isActive = true
        zoomLabel.font = NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .regular)
        for v in [iconButton("chevron.up", "前のページ", #selector(previousPage(_:))),
                  iconButton("chevron.down", "次のページ", #selector(nextPage(_:))),
                  pageField, pageCountLabel, separator(),
                  iconButton("minus.magnifyingglass", "縮小", #selector(zoomOutAction(_:))),
                  zoomLabel,
                  iconButton("plus.magnifyingglass", "拡大", #selector(zoomInAction(_:))),
                  iconButton("arrow.up.left.and.arrow.down.right", "ウィンドウに合わせる", #selector(zoomFit(_:))),
                  separator(),
                  iconButton("textformat", "書式バーの表示/非表示", #selector(toggleInspectorPanel(_:)))] as [NSView] {
            stack.addArrangedSubview(v)
        }

        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.detachesHiddenViews = true
        stack.setClippingResistancePriority(.defaultLow, for: .horizontal)
        bg.addSubview(stack)
        let line = NSBox()
        line.boxType = .separator
        line.translatesAutoresizingMaskIntoConstraints = false
        bg.addSubview(line)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: bg.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: bg.trailingAnchor),
            stack.topAnchor.constraint(equalTo: bg.topAnchor),
            stack.bottomAnchor.constraint(equalTo: bg.bottomAnchor),
            line.leadingAnchor.constraint(equalTo: bg.leadingAnchor),
            line.trailingAnchor.constraint(equalTo: bg.trailingAnchor),
            line.bottomAnchor.constraint(equalTo: bg.bottomAnchor)
        ])
        return bg
    }

    // MARK: - 状態の反映

    @objc private func toolChanged() {
        for (t, b) in toolButtons { b.state = t == editor.tool ? .on : .off }
    }

    @objc private func pageChanged() {
        let count = studio.pdf.pageCount
        pageCountLabel.stringValue = "/ \(count)"
        if let p = editor.currentPage { pageField.stringValue = String(studio.pdf.index(for: p) + 1) }
        zoomLabel.stringValue = "\(Int((editor.scaleFactor * 100).rounded()))%"
    }

    @objc private func documentReplaced() { reattach() }
    @objc private func pagesChanged() { reattach() }

    private func reattach() {
        let index = editor.currentPage.map { studio.pdf.index(for: $0) } ?? 0
        let scale = editor.scaleFactor
        let auto = editor.autoScales
        editor.selectAnnotation(nil)
        editor.document = nil
        editor.document = studio.pdf
        if !auto { editor.scaleFactor = scale } else { editor.autoScales = true }
        if index != NSNotFound, let p = studio.pdf.page(at: min(index, max(0, studio.pdf.pageCount - 1))) { editor.go(to: p) }
        sidebar.reloadAll()
        pageChanged()
    }

    func windowWillClose(_ notification: Notification) {
        // 並べられている画面の文書が閉じたら、並べているウィンドウから外す
        if let host = embeddedIn { host.removePane(self) }
        if splitMode != .single || !splitPanes.isEmpty { exitSplit() }
        NotificationCenter.default.removeObserver(self)
    }

    /// 並べて表示しているウィンドウを閉じるときは、並べた文書をタブに戻してから閉じる
    func windowShouldClose(_ sender: NSWindow) -> Bool { true }

    // MARK: - 文書の操作（並べて表示の中では、その画面の文書に対して行う）

    private var studioDoc: NSDocument { studio }
    @objc(saveDocument:) func saveDocumentAction(_ sender: Any?) { studioDoc.save(sender) }
    @objc(saveDocumentAs:) func saveDocumentAsAction(_ sender: Any?) { studioDoc.saveAs(sender) }
    @objc(revertDocumentToSaved:) func revertAction(_ sender: Any?) { studioDoc.revertToSaved(sender) }
    @objc(printDocument:) func printAction(_ sender: Any?) { studioDoc.printDocument(sender) }
    @objc(runPageLayout:) func pageLayoutAction(_ sender: Any?) { studioDoc.runPageLayout(sender) }
    @objc func undo(_ sender: Any?) { studioDoc.undoManager?.undo() }
    @objc func redo(_ sender: Any?) { studioDoc.undoManager?.redo() }

    /// 閉じる（並べて表示の中の文書なら、その文書だけを閉じる）
    @objc func performClose(_ sender: Any?) {
        if let host = embeddedIn {
            host.removePane(self)
            window?.performClose(sender)
        } else if splitMode != .single {
            exitSplit()
            window?.performClose(sender)
        } else {
            window?.performClose(sender)
        }
    }

    // MARK: - 表示

    @objc func toolButtonClicked(_ sender: NSButton) { editor.tool = Tool.allCases[sender.tag] }
    @objc func selectTool(_ sender: NSMenuItem) { editor.tool = Tool.allCases[sender.tag] }

    @objc func toggleSidebarPanel(_ sender: Any?) { sidebarItem.animator().isCollapsed.toggle() }
    @objc func toggleInspectorPanel(_ sender: Any?) { setFormatBarHidden(!inspector.view.isHidden) }

    @objc func zoomInAction(_ sender: Any?) { editor.zoomIn(sender) }
    @objc func zoomOutAction(_ sender: Any?) { editor.zoomOut(sender) }
    @objc func zoomFit(_ sender: Any?) { editor.autoScales = true }
    @objc func zoomActual(_ sender: Any?) { editor.scaleFactor = 1 }
    @objc func zoomFitWidth(_ sender: Any?) {
        guard let p = editor.currentPage else { return }
        let w = DisplaySpace.size(of: p).width
        editor.scaleFactor = max(0.1, (editor.bounds.width - 40) / w)
    }

    @objc func setDisplayMode(_ sender: NSMenuItem) {
        let modes: [PDFDisplayMode] = [.singlePage, .singlePageContinuous, .twoUp, .twoUpContinuous]
        editor.displayMode = modes[sender.tag]
    }

    @objc func toggleBookMode(_ sender: Any?) { editor.displaysAsBook.toggle() }

    @objc func previousPage(_ sender: Any?) { editor.goToPreviousPage(sender) }
    @objc func nextPage(_ sender: Any?) { editor.goToNextPage(sender) }
    @objc func firstPage(_ sender: Any?) { editor.goToFirstPage(sender) }
    @objc func lastPage(_ sender: Any?) { editor.goToLastPage(sender) }

    @objc private func pageFieldEntered() {
        if let n = Int(pageField.stringValue), let p = studio.pdf.page(at: n - 1) { editor.go(to: p) } else { pageChanged() }
        hostWindow?.makeFirstResponder(editor)
    }

    @objc func goToPagePrompt(_ sender: Any?) {
        guard let s = Dialog.text("ページへ移動", message: "1〜\(studio.pdf.pageCount)", multiline: false),
              let n = Int(s), let p = studio.pdf.page(at: n - 1) else { return }
        editor.go(to: p)
    }

    @objc func showSearch(_ sender: Any?) {
        if sidebarItem.isCollapsed { sidebarItem.isCollapsed = false }
        sidebar.show(3)
    }

    @objc override func performTextFinderAction(_ sender: Any?) { showSearch(sender) }

    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        switch menuItem.action {
        case #selector(setSplitMode(_:)):
            menuItem.state = menuItem.tag == splitHost.splitMode.rawValue ? .on : .off
        case #selector(undo(_:)):
            if let um = studioDoc.undoManager {
                menuItem.title = um.undoMenuItemTitle
                return um.canUndo
            }
            return false
        case #selector(redo(_:)):
            if let um = studioDoc.undoManager {
                menuItem.title = um.redoMenuItemTitle
                return um.canRedo
            }
            return false
        case #selector(saveDocumentAction(_:)), #selector(saveDocumentAsAction(_:)), #selector(printAction(_:)), #selector(pageLayoutAction(_:)):
            return true
        case #selector(revertAction(_:)):
            return studioDoc.fileURL != nil && studioDoc.isDocumentEdited
        case #selector(selectTool(_:)):
            menuItem.state = Tool.allCases[menuItem.tag] == editor.tool ? .on : .off
        case #selector(setDisplayMode(_:)):
            let modes: [PDFDisplayMode] = [.singlePage, .singlePageContinuous, .twoUp, .twoUpContinuous]
            menuItem.state = modes[menuItem.tag] == editor.displayMode ? .on : .off
        case #selector(toggleBookMode(_:)):
            menuItem.state = editor.displaysAsBook ? .on : .off
        case #selector(removePassword(_:)):
            return !studio.writeOptions.isEmpty
        case #selector(deletePages(_:)):
            return studio.pdf.pageCount > 1
        default: break
        }
        return true
    }

    // MARK: - ページ操作

    private var targetPages: [Int] { sidebar.pages.selectedIndexes }

    @objc func rotateRight(_ sender: Any?) { rotate(90) }
    @objc func rotateLeft(_ sender: Any?) { rotate(-90) }

    private func rotate(_ deg: Int) {
        let idx = targetPages
        studio.performStructuralChange("ページの回転") { pdf in
            for i in idx { if let p = pdf.page(at: i) { p.rotation = ((p.rotation + deg) % 360 + 360) % 360 } }
        }
        sidebar.pages.table.selectRowIndexes(IndexSet(idx), byExtendingSelection: false)
    }

    @objc func deletePages(_ sender: Any?) {
        let idx = targetPages
        guard !idx.isEmpty else { return }
        guard idx.count < studio.pdf.pageCount else { Dialog.alert("すべてのページは削除できません"); return }
        guard Dialog.confirm("\(idx.count) ページを削除しますか？", "ページ: " + idx.map { String($0 + 1) }.joined(separator: ", "), ok: "削除") else { return }
        studio.performStructuralChange("ページの削除") { pdf in
            for i in idx.sorted(by: >) { pdf.removePage(at: i) }
        }
    }

    @objc func duplicatePages(_ sender: Any?) {
        let idx = targetPages.sorted()
        guard let last = idx.last else { return }
        studio.performStructuralChange("ページの複製") { pdf in
            let copies = idx.compactMap { pdf.page(at: $0)?.copy() as? PDFPage }
            for (k, p) in copies.enumerated() { pdf.insert(p, at: last + 1 + k) }
        }
    }

    @objc func insertBlankPage(_ sender: Any?) {
        let after = targetPages.max() ?? (studio.pdf.pageCount - 1)
        let size = studio.pdf.page(at: max(0, after)).map { $0.bounds(for: .mediaBox).size } ?? Operations.a4
        guard let page = Operations.blankPage(size: size) else { return }
        studio.performStructuralChange("空白ページの挿入") { pdf in pdf.insert(page, at: after + 1) }
        if let p = studio.pdf.page(at: after + 1) { editor.go(to: p) }
    }

    @objc func insertFromFile(_ sender: Any?) {
        let urls = Dialog.openFiles(types: [.pdf, .image], multiple: true, title: "挿入する PDF / 画像を選んでください")
        guard !urls.isEmpty else { return }
        let src = Operations.createPDF(from: urls)
        guard src.pageCount > 0 else { Dialog.alert("挿入できるページがありませんでした"); return }
        let after = targetPages.max() ?? (studio.pdf.pageCount - 1)
        studio.performStructuralChange("ページの挿入") { pdf in
            for i in 0..<src.pageCount { if let p = src.page(at: i) { pdf.insert(p, at: after + 1 + i) } }
        }
    }

    @objc func extractPages(_ sender: Any?) {
        let f = FormBuilder()
        let sel = targetPages.sorted()
        let range = f.text("ページ範囲", sel.isEmpty ? "" : compactRange(sel), placeholder: "例: 1-3, 5")
        let remove = f.check("抽出したページを元の文書から削除する", false)
        guard f.run(title: "ページを抽出", message: "抽出したページは新しい文書として開きます。") else { return }
        guard let idx = PageRange.parse(range.stringValue, pageCount: studio.pdf.pageCount), !idx.isEmpty else {
            Dialog.alert("ページ範囲が正しくありません"); return
        }
        guard let data = Compositor.serialize(studio.pdf), let src = PDFDocument(data: data) else { return }
        let out = Operations.extract(src, pages: idx)
        let base = studio.displayName ?? L("文書")
        PDFStudioDocument.openNew(out, title: "\(base) \(L("抽出"))")
        if remove.state == .on, idx.count < studio.pdf.pageCount {
            studio.performStructuralChange("ページの抽出") { pdf in
                for i in idx.sorted(by: >) { pdf.removePage(at: i) }
            }
        }
    }

    private func compactRange(_ idx: [Int]) -> String {
        var parts: [String] = []
        var i = 0
        while i < idx.count {
            var j = i
            while j + 1 < idx.count && idx[j + 1] == idx[j] + 1 { j += 1 }
            parts.append(i == j ? "\(idx[i] + 1)" : "\(idx[i] + 1)-\(idx[j] + 1)")
            i = j + 1
        }
        return parts.joined(separator: ", ")
    }

    @objc func splitDocument(_ sender: Any?) {
        let total = studio.pdf.pageCount
        let f = FormBuilder()
        let mode = f.popup("分割方法", ["指定ページ数ごと", "範囲を指定", "1 ページずつ"])
        let n = f.number("ページ数", 2)
        let ranges = f.text("範囲", "", placeholder: "例: 1-3, 4-8, 9-")
        f.note("「範囲を指定」ではカンマ区切りの各範囲が 1 ファイルになります。")
        guard f.run(title: "文書を分割", message: "全 \(total) ページ") else { return }
        var groups: [[Int]] = []
        switch mode.indexOfSelectedItem {
        case 0:
            let k = max(1, Int(n.doubleValueOrNil ?? 1))
            groups = stride(from: 0, to: total, by: k).map { Array($0..<min(total, $0 + k)) }
        case 1:
            for part in ranges.stringValue.split(separator: ",") {
                guard let g = PageRange.parse(String(part), pageCount: total), !g.isEmpty else {
                    Dialog.alert("範囲「\(part)」が正しくありません"); return
                }
                groups.append(g)
            }
        default:
            groups = (0..<total).map { [$0] }
        }
        guard !groups.isEmpty, let folder = Dialog.chooseFolder(title: "分割したファイルの保存先") else { return }
        do {
            let c = try Operations.split(studio.pdf, groups: groups, folder: folder, baseName: baseName)
            Dialog.alert("\(c) 個のファイルに分割しました", folder.path)
            NSWorkspace.shared.activateFileViewerSelecting([folder])
        } catch {
            Dialog.alert("分割に失敗しました", error.localizedDescription, style: .warning)
        }
    }

    private var baseName: String {
        (studio.fileURL?.deletingPathExtension().lastPathComponent) ?? (studio.displayName ?? "document")
    }

    // MARK: - 文書の加工

    @objc func addWatermark(_ sender: Any?) {
        var o = Operations.WatermarkOptions()
        let f = FormBuilder()
        let text = f.text("文字", o.text)
        let size = f.number("サイズ (pt)", Double(o.fontSize))
        let color = f.color("色", o.color)
        let opacity = f.number("不透明度 (%)", 25)
        let angle = f.number("角度 (°)", 45)
        let range = f.text("ページ範囲", "", placeholder: "空欄ですべて")
        guard f.run(title: "透かしを追加") else { return }
        guard let pages = PageRange.parse(range.stringValue, pageCount: studio.pdf.pageCount) else { Dialog.alert("ページ範囲が正しくありません"); return }
        o.text = text.stringValue
        o.fontSize = CGFloat(size.doubleValueOrNil ?? 72)
        o.color = color.color
        o.opacity = CGFloat((opacity.doubleValueOrNil ?? 25) / 100)
        o.angle = CGFloat(angle.doubleValueOrNil ?? 45)
        guard !o.text.isEmpty else { return }
        studio.performStructuralChange("透かし") { Operations.addWatermark($0, pages: pages, o) }
    }

    @objc func addHeaderFooter(_ sender: Any?) {
        var o = Operations.HeaderFooterOptions()
        let f = FormBuilder()
        let hl = f.text("ヘッダー 左", "", width: 220)
        let hc = f.text("ヘッダー 中央", "", width: 220)
        let hr = f.text("ヘッダー 右", "", width: 220)
        let fl = f.text("フッター 左", "", width: 220)
        let fc = f.text("フッター 中央", o.footerCenter, width: 220)
        let fr = f.text("フッター 右", "", width: 220)
        let size = f.number("文字サイズ", 10)
        let margin = f.number("余白 (pt)", 28)
        let start = f.number("開始番号", 1)
        let color = f.color("色", .black)
        let range = f.text("ページ範囲", "", placeholder: "空欄ですべて")
        f.note("{page} = ページ番号、{total} = 総ページ数、{date} = 今日の日付")
        guard f.run(title: "ヘッダーとフッター / ページ番号") else { return }
        guard let pages = PageRange.parse(range.stringValue, pageCount: studio.pdf.pageCount) else { Dialog.alert("ページ範囲が正しくありません"); return }
        o.headerLeft = hl.stringValue; o.headerCenter = hc.stringValue; o.headerRight = hr.stringValue
        o.footerLeft = fl.stringValue; o.footerCenter = fc.stringValue; o.footerRight = fr.stringValue
        o.fontSize = CGFloat(size.doubleValueOrNil ?? 10)
        o.margin = CGFloat(margin.doubleValueOrNil ?? 28)
        o.startNumber = Int(start.doubleValueOrNil ?? 1)
        o.color = color.color
        studio.performStructuralChange("ヘッダーとフッター") { Operations.addHeaderFooter($0, pages: pages, o) }
    }

    @objc func addBates(_ sender: Any?) {
        let f = FormBuilder()
        let prefix = f.text("接頭辞", "ABC", width: 160)
        let start = f.number("開始番号", 1)
        let digits = f.number("桁数", 6)
        let pos = f.popup("位置", ["右下", "中央下", "左下", "右上"])
        let range = f.text("ページ範囲", "", placeholder: "空欄ですべて")
        guard f.run(title: "ベイツ番号を付与") else { return }
        guard let pages = PageRange.parse(range.stringValue, pageCount: studio.pdf.pageCount) else { return }
        let s = Int(start.doubleValueOrNil ?? 1), d = Int(digits.doubleValueOrNil ?? 6)
        studio.performStructuralChange("ベイツ番号") { pdf in
            for (n, i) in pages.enumerated() {
                var o = Operations.HeaderFooterOptions()
                o.footerCenter = ""
                let text = prefix.stringValue + String(format: "%0\(d)d", s + n)
                switch pos.indexOfSelectedItem {
                case 0: o.footerRight = text
                case 1: o.footerCenter = text
                case 2: o.footerLeft = text
                default: o.headerRight = text
                }
                Operations.addHeaderFooter(pdf, pages: [i], o)
            }
        }
    }

    @objc func applyRedactions(_ sender: Any?) {
        let count = (0..<studio.pdf.pageCount).reduce(0) { $0 + (studio.pdf.page(at: $1)?.annotations.filter(AnnotationMarker.isRedaction).count ?? 0) }
        guard count > 0 else {
            Dialog.alert("墨消しマークがありません", "ツールバーの「墨消し」で範囲を指定するか、検索パネルの「すべてに墨消しマーク」を使ってください。")
            return
        }
        guard Dialog.confirm("\(count) 箇所の墨消しを適用しますか？",
                             "対象ページは画像化され、マーク部分の文字・画像情報は完全に削除されます（元に戻すことは可能）。必要に応じて後で OCR を実行してください。",
                             ok: "墨消しを適用") else { return }
        editor.selectAnnotation(nil)
        studio.performStructuralChange("墨消し") { Compositor.applyRedactions($0) }
    }

    @objc func flattenAnnotations(_ sender: Any?) {
        guard Dialog.confirm("注釈とフォームをページに焼き込みますか？", "注釈は編集できなくなり、どのビューアでも同じ見た目で表示されます。") else { return }
        editor.selectAnnotation(nil)
        studio.performStructuralChange("フラット化") { Compositor.flattenInPlace($0) }
    }

    @objc func runOCR(_ sender: Any?) {
        let f = FormBuilder()
        let lang = f.popup("言語", ["日本語 + 英語", "英語のみ"])
        let skip = f.check("すでに文字のあるページはスキップする", true)
        let range = f.text("ページ範囲", "", placeholder: "空欄ですべて")
        guard f.run(title: "テキスト認識（OCR）", message: "スキャンした PDF の文字を認識し、検索・コピーできるようにします。") else { return }
        guard let pages = PageRange.parse(range.stringValue, pageCount: studio.pdf.pageCount) else { return }
        let targets = pages.filter { i in
            guard let p = studio.pdf.page(at: i) else { return false }
            return skip.state == .off || !Operations.pageHasText(p)
        }
        guard !targets.isEmpty else { Dialog.alert("OCR が必要なページはありません", "すべてのページにすでに文字情報があります。"); return }
        let langs = lang.indexOfSelectedItem == 0 ? ["ja-JP", "en-US"] : ["en-US"]
        let pageObjects = targets.compactMap { i in studio.pdf.page(at: i).map { (i, $0) } }

        let progress = ProgressSheet(title: "テキストを認識しています…", total: pageObjects.count)
        if let w = hostWindow { progress.begin(on: w) }
        DispatchQueue.global(qos: .userInitiated).async {
            var results: [(Int, [Operations.OCRLine])] = []
            for (k, (i, page)) in pageObjects.enumerated() {
                if progress.cancelled { break }
                let lines = (try? Operations.recognize(page, languages: langs)) ?? []
                results.append((i, lines))
                DispatchQueue.main.async { progress.update(k + 1, "ページ \(i + 1)") }
            }
            DispatchQueue.main.async {
                progress.end()
                let found = results.reduce(0) { $0 + $1.1.count }
                guard found > 0 else { Dialog.alert("文字が見つかりませんでした"); return }
                self.studio.performStructuralChange("OCR") { pdf in
                    for (i, lines) in results { Operations.applyOCR(pdf, index: i, lines: lines) }
                }
                Dialog.alert("OCR が完了しました", "\(results.count) ページで \(found) 行のテキストを認識しました。検索やコピーができます。")
            }
        }
    }

    // MARK: - 保護・プロパティ

    @objc func setPassword(_ sender: Any?) {
        let f = FormBuilder()
        let user = f.secure("開くパスワード")
        let user2 = f.secure("確認入力")
        let owner = f.secure("権限パスワード")
        let print = f.check("印刷を許可", true)
        let copy = f.check("テキスト・画像のコピーを許可", true)
        let edit = f.check("編集・注釈を許可", true)
        f.note("開くパスワードは空欄にもできます（その場合は権限の制限のみ）。権限パスワードを空欄にすると開くパスワードと同じになります。保存時に適用されます。")
        guard f.run(title: "パスワードで保護（AES 暗号化）") else { return }
        guard user.stringValue == user2.stringValue else { Dialog.alert("開くパスワードが一致しません"); return }
        let ownerPW = owner.stringValue.isEmpty ? user.stringValue : owner.stringValue
        guard !ownerPW.isEmpty else { Dialog.alert("パスワードを入力してください"); return }
        var perms: UInt = PDFAccessPermissions.allowsContentAccessibility.rawValue
        if print.state == .on { perms |= PDFAccessPermissions.allowsHighQualityPrinting.rawValue | PDFAccessPermissions.allowsLowQualityPrinting.rawValue }
        if copy.state == .on { perms |= PDFAccessPermissions.allowsContentCopying.rawValue }
        if edit.state == .on {
            perms |= PDFAccessPermissions.allowsDocumentChanges.rawValue | PDFAccessPermissions.allowsDocumentAssembly.rawValue
                | PDFAccessPermissions.allowsCommenting.rawValue | PDFAccessPermissions.allowsFormFieldEntry.rawValue
        }
        var opts: [PDFDocumentWriteOption: Any] = [.ownerPasswordOption: ownerPW, .accessPermissionsOption: NSNumber(value: perms)]
        if !user.stringValue.isEmpty { opts[.userPasswordOption] = user.stringValue }
        studio.writeOptions = opts
        studio.updateChangeCount(.changeDone)
        Dialog.alert("保護を設定しました", "保存すると暗号化されたPDFとして書き出されます。")
    }

    @objc func removePassword(_ sender: Any?) {
        guard Dialog.confirm("パスワード保護を解除しますか？", "保存すると暗号化なしのPDFになります。") else { return }
        studio.writeOptions = [:]
        studio.updateChangeCount(.changeDone)
    }

    @objc func editProperties(_ sender: Any?) {
        let pdf = studio.pdf
        var attrs = pdf.documentAttributes ?? [:]
        func get(_ k: PDFDocumentAttribute) -> String { (attrs[k.rawValue] as? String) ?? (attrs[k] as? String) ?? "" }
        let f = FormBuilder()
        let title = f.text("タイトル", get(.titleAttribute))
        let author = f.text("作成者", get(.authorAttribute))
        let subject = f.text("サブタイトル", get(.subjectAttribute))
        let keywords = f.text("キーワード", ((attrs[PDFDocumentAttribute.keywordsAttribute.rawValue] as? [String]) ?? []).joined(separator: ", "))
        let size = (studio.fileURL.flatMap { try? $0.resourceValues(forKeys: [.fileSizeKey]).fileSize }).map {
            ByteCountFormatter.string(fromByteCount: Int64($0), countStyle: .file)
        } ?? "未保存"
        let first = pdf.page(at: 0)?.bounds(for: .cropBox).size ?? .zero
        f.note("""
        ページ数: \(pdf.pageCount)　PDF バージョン: \(pdf.majorVersion).\(pdf.minorVersion)
        ページサイズ: \(Int(first.width * 25.4 / 72)) × \(Int(first.height * 25.4 / 72)) mm　ファイルサイズ: \(size)
        作成アプリ: \(get(.creatorAttribute))　PDF 変換: \(get(.producerAttribute))
        暗号化: \(pdf.isEncrypted || !studio.writeOptions.isEmpty ? "あり" : "なし")
        """)
        guard f.run(title: "文書のプロパティ") else { return }
        attrs[PDFDocumentAttribute.titleAttribute.rawValue] = title.stringValue
        attrs[PDFDocumentAttribute.authorAttribute.rawValue] = author.stringValue
        attrs[PDFDocumentAttribute.subjectAttribute.rawValue] = subject.stringValue
        attrs[PDFDocumentAttribute.keywordsAttribute.rawValue] = keywords.stringValue.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
        attrs[PDFDocumentAttribute.modificationDateAttribute.rawValue] = Date()
        pdf.documentAttributes = attrs
        studio.updateChangeCount(.changeDone)
    }

    // MARK: - 書き出し・圧縮・比較

    @objc func saveOptimized(_ sender: Any?) {
        let f = FormBuilder()
        let mode = f.popup("方法", ["標準（不要なデータを除いて保存）", "強力（ページを画像化して圧縮）"])
        let dpi = f.number("解像度 (dpi)", 120)
        let quality = f.number("画質 (1-100)", 70)
        f.note("「強力」は文字が画像になるため、検索・コピーができなくなります（必要なら後で OCR を実行してください）。")
        guard f.run(title: "ファイルサイズを縮小して保存") else { return }
        guard let url = Dialog.saveFile(name: baseName + L("_圧縮.pdf"), type: .pdf) else { return }
        // 比べる元の大きさ：保存済みのファイル、なければ今の内容を普通に保存した大きさ
        let fileSize = studio.fileURL.flatMap { try? $0.resourceValues(forKeys: [.fileSizeKey]).fileSize }
        let before = fileSize ?? Compositor.serialize(studio.pdf, options: studio.writeOptions)?.count ?? 0
        let strong = mode.indexOfSelectedItem == 1
        let d = min(600, max(36, CGFloat(dpi.doubleValueOrNil ?? 120)))
        let q = min(100, max(1, CGFloat(quality.doubleValueOrNil ?? 70))) / 100
        guard let data = Operations.optimize(studio.pdf, original: before, strong: strong, dpi: d, quality: q, options: studio.writeOptions) else {
            Dialog.alert("これ以上小さくできませんでした", strong ? "" : "「強力」を選ぶと、ページを画像にして小さくできることがあります。")
            return
        }
        do {
            try data.write(to: url)
            let fmt = { (n: Int) in ByteCountFormatter.string(fromByteCount: Int64(n), countStyle: .file) }
            Dialog.alert("圧縮して保存しました", "\(fmt(before)) → \(fmt(data.count))\n\(url.path)")
        } catch {
            Dialog.alert("保存に失敗しました", error.localizedDescription, style: .warning)
        }
    }

    @objc func exportImages(_ sender: Any?) {
        let f = FormBuilder()
        let fmt = f.popup("形式", ["PNG", "JPEG"])
        let dpi = f.number("解像度 (dpi)", 150)
        guard f.run(title: "画像として書き出し"), let folder = Dialog.chooseFolder(title: "画像の保存先フォルダ") else { return }
        do {
            let n = try Operations.exportImages(studio.pdf, to: folder, baseName: baseName, jpeg: fmt.indexOfSelectedItem == 1,
                                                dpi: CGFloat(dpi.doubleValueOrNil ?? 150))
            Dialog.alert("\(n) 枚の画像を書き出しました", folder.path)
        } catch {
            Dialog.alert("書き出しに失敗しました", error.localizedDescription, style: .warning)
        }
    }

    @objc func exportWord(_ sender: Any?) { export(ext: "docx", type: UTType(filenameExtension: "docx") ?? .data, Operations.exportWord) }
    @objc func exportRTF(_ sender: Any?) { export(ext: "rtf", type: .rtf, Operations.exportRTF) }
    @objc func exportText(_ sender: Any?) { export(ext: "txt", type: .plainText, Operations.exportText) }

    private func export(ext: String, type: UTType, _ body: (PDFDocument, URL) throws -> Void) {
        guard let url = Dialog.saveFile(name: "\(baseName).\(ext)", type: type) else { return }
        do {
            try body(studio.pdf, url)
            NSWorkspace.shared.activateFileViewerSelecting([url])
        } catch {
            Dialog.alert("書き出しに失敗しました", error.localizedDescription, style: .warning)
        }
    }

    // MARK: - 測定の縮尺

    static let scaleRatios: [Double] = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000]

    func toast(_ s: String) { Toast.show(L(s), in: hostWindow) }

    @objc func measureScaleDialog(_ sender: Any?) {
        let cur = editor.measureScale
        let ratio = cur.ratio ?? 1
        let f = FormBuilder()
        let presetIndex = Self.scaleRatios.firstIndex(of: ratio) ?? Self.scaleRatios.count
        let preset = f.popup("縮尺", Self.scaleRatios.map { "1 : \(FormBuilder.format($0))" } + ["その他（下の欄に入力）"], selected: presetIndex)
        let custom = f.number("その他の縮尺 1 :", ratio)
        let unit = f.popup("単位", MeasureScale.unitOrder.map { MeasureScale.unitNames[$0] ?? $0 }, selected: MeasureScale.unitOrder.firstIndex(of: cur.unit) ?? 0)
        let decimals = f.number("小数点以下の桁数", Double(cur.decimals))
        let all = f.check("この文書の既存の測定にも適用する", true)
        f.note("図面の寸法から縮尺を合わせるときは「文書 > 縮尺を合わせる（キャリブレーション）」を使います。")
        let unitName = L(MeasureScale.unitNames[cur.unit] ?? cur.unit)
        guard f.run(title: "測定の縮尺", message: "現在の縮尺: \(cur.label)（\(unitName)）\n図面の縮尺を選ぶと、紙の上の長さを実際の長さに換算して表示します。") else { return }
        let n = preset.indexOfSelectedItem < Self.scaleRatios.count ? Self.scaleRatios[preset.indexOfSelectedItem] : (custom.doubleValueOrNil ?? 0)
        guard n > 0 else { Dialog.alert("縮尺が正しくありません"); return }
        let u = MeasureScale.unitOrder[max(0, unit.indexOfSelectedItem)]
        let dec = Int(min(4, max(0, (decimals.doubleValueOrNil ?? 1).rounded())))
        let label = "1:\(FormBuilder.format(n))"
        let changed = editor.setMeasureScale(MeasureScale(factor: MeasureScale.factor(ratio: n, unit: u), unit: u, label: label, ratio: n, decimals: dec), all: all.state == .on)
        toast(changed > 0 ? "縮尺を 1:\(FormBuilder.format(n)) にし、\(changed) 件の測定を更新しました" : "縮尺を 1:\(FormBuilder.format(n)) にしました")
    }

    /// キャリブレーション：長さの分かっている線を引いてもらい、縮尺を決める
    @objc func calibrateScale(_ sender: Any?) {
        editor.tool = .measureDistance
        editor.calibrating = { [weak self] paperPt in self?.finishCalibration(paperPt) }
        toast("長さが分かっている線（図面の寸法線など）の両端をドラッグしてください。Esc で中止します。")
    }

    func finishCalibration(_ paperPt: CGFloat) {
        let cur = editor.measureScale
        let paperMm = Double(paperPt) * MeasureScale.mmPerPt
        let f = FormBuilder()
        let len = f.number("実際の長さ", 0)
        len.stringValue = ""
        let unit = f.popup("単位", MeasureScale.unitOrder.map { MeasureScale.unitNames[$0] ?? $0 }, selected: MeasureScale.unitOrder.firstIndex(of: cur.unit) ?? 0)
        let decimals = f.number("小数点以下の桁数", Double(cur.decimals))
        let all = f.check("この文書の既存の測定にも適用する", true)
        let paperText = String(format: "%.2f", paperMm)
        guard f.run(title: "縮尺を合わせる", message: "引いた線の紙の上の長さ: \(paperText) mm\nこの線の実際の長さを入力してください。") else { return }
        let u = MeasureScale.unitOrder[max(0, unit.indexOfSelectedItem)]
        guard let l = len.doubleValueOrNil, l > 0, paperMm > 0 else { Dialog.alert("長さが正しくありません"); return }
        // 紙の上の 1 mm が実際の何 mm か
        let ratio = (l / (MeasureScale.units[u] ?? 1)) / paperMm
        let nice = ratio >= 10 ? ratio.rounded() : (ratio * 100).rounded() / 100
        let dec = Int(min(4, max(0, (decimals.doubleValueOrNil ?? 1).rounded())))
        let changed = editor.setMeasureScale(MeasureScale(factor: MeasureScale.factor(ratio: ratio, unit: u), unit: u, label: "1:\(FormBuilder.format(nice))", ratio: ratio, decimals: dec), all: all.state == .on)
        toast(changed > 0 ? "縮尺を 1:\(FormBuilder.format(nice)) に合わせました（\(changed) 件の測定を更新）" : "縮尺を 1:\(FormBuilder.format(nice)) に合わせました")
    }

    @objc func compareDocuments(_ sender: Any?) {
        guard let url = Dialog.openFiles(types: [.pdf], multiple: false, title: "比較する（新しい）PDF を選んでください").first,
              let other = PDFDocument(url: url) else { return }
        let report = Operations.compare(studio.pdf, other)
        let oldName = studio.displayName ?? ""
        ReportWindow.show(title: "比較: \(oldName) ↔ \(url.lastPathComponent)", text: report)
    }

    /// 図面の重ね合わせ比較：今の文書（古い版）と選んだファイル（新しい版）を重ね、違いを色分けした PDF を新しい文書で開く
    @objc func compareOverlay(_ sender: Any?) {
        // ページの画像を新しい PDF に書き出すので、コピーが許されている文書だけ
        guard studio.pdf.allowsCopying else {
            Dialog.alert("この文書は重ねて比較できません", L("文書の作成者がコピーを許可していません。"), style: .warning)
            return
        }
        guard let url = Dialog.openFiles(types: [.pdf, .tiff], multiple: false, title: "重ねて比較する（新しい版の）ファイルを選んでください").first else { return }
        // 表示中の文書には裏から触らない（写しを作って裏で描く）
        guard let oldData = studio.pdf.dataRepresentation() else { return }
        let base = (studio.displayName as NSString?)?.deletingPathExtension ?? L("文書")
        let progress = ProgressSheet(title: L("重ねて比較しています"), total: 1)
        if let w = hostWindow ?? window { progress.begin(on: w) }
        DispatchQueue.global(qos: .userInitiated).async {
            let result = Result { () -> (doc: PDFDocument, pages: Int, changed: Int, notes: [String])? in
                guard let old = PDFDocument(data: oldData) else { throw StudioError.message(L("PDF として読み込めませんでした。")) }
                let other: PDFDocument?
                if TiffImport.isTiff(url) {
                    other = PDFDocument(data: try TiffImport.pdfData(from: try Data(contentsOf: url, options: .mappedIfSafe)))
                } else {
                    other = PDFDocument(url: url)
                }
                guard let other else { throw StudioError.message(L("比較するファイルを開けませんでした")) }
                if other.isLocked { throw StudioError.message(L("パスワードで保護された文書とは比較できません")) }
                return Overlay.compare(old, other, progress: { done, total in
                    DispatchQueue.main.async { progress.update(done, total: total, L("{n} / {t} ページ").replacingOccurrences(of: "{n}", with: "\(done)").replacingOccurrences(of: "{t}", with: "\(total)")) }
                }, cancelled: { progress.cancelled })
            }
            DispatchQueue.main.async {
                progress.end()
                switch result {
                case .failure(let e): Dialog.alert("重ねて比較できませんでした", e.localizedDescription, style: .warning)
                case .success(nil): break  // 中止
                case .success(let r?):
                    let summary = L("{n} ページのうち {c} ページに違いがあります").replacingOccurrences(of: "{n}", with: "\(r.pages)").replacingOccurrences(of: "{c}", with: "\(r.changed)")
                    Dialog.alert("重ねて比較しました", summary + (r.notes.isEmpty ? "" : "\n\n" + r.notes.joined(separator: "\n")) + "\n\n" + L("回転や拡大縮小の違いは補正しません"))
                    if r.doc.pageCount > 0 { PDFStudioDocument.openNew(r.doc, title: "\(base)_\(L("重ねて比較")).pdf") }
                }
            }
        }
    }
}

// MARK: - 進捗シート

final class ProgressSheet {
    private let panel: NSPanel
    private let bar = NSProgressIndicator()
    private let label = NSTextField(labelWithString: "")
    private(set) var cancelled = false
    private var cancelTarget: ClosureTarget?
    private weak var parent: NSWindow?

    init(title: String, total: Int) {
        panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 380, height: 120), styleMask: [.titled], backing: .buffered, defer: false)
        let t = NSTextField(labelWithString: title)
        t.font = NSFont.boldSystemFont(ofSize: 13)
        bar.isIndeterminate = false
        bar.minValue = 0
        bar.maxValue = Double(max(1, total))
        let cancel = NSButton(title: "中止", target: nil, action: nil)
        let stack = NSStackView(views: [t, bar, label, cancel])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.edgeInsets = NSEdgeInsets(top: 16, left: 20, bottom: 16, right: 20)
        bar.widthAnchor.constraint(equalToConstant: 340).isActive = true
        panel.contentView = stack
        cancelTarget = ClosureTarget { [weak self] in self?.cancelled = true }
        cancel.target = cancelTarget
        cancel.action = #selector(ClosureTarget.fire)
    }

    /// 全体の数も合わせて進み具合を出す
    func update(_ done: Int, total: Int, _ text: String) {
        bar.maxValue = Double(max(1, total))
        update(done, text)
    }

    func begin(on window: NSWindow) {
        parent = window
        window.beginSheet(panel)
    }

    func update(_ done: Int, _ text: String) {
        bar.doubleValue = Double(done)
        label.stringValue = "\(Int(done))/\(Int(bar.maxValue))  \(text)"
    }

    func end() { parent?.endSheet(panel) }
}

// MARK: - レポート表示ウィンドウ（比較結果など）

enum ReportWindow {
    private static var windows: [NSWindow] = []

    static func show(title: String, text: NSAttributedString) {
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 720, height: 600), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        w.title = title
        w.isReleasedWhenClosed = false
        let scroll = NSTextView.scrollableTextView()
        if let tv = scroll.documentView as? NSTextView {
            tv.isEditable = false
            tv.textContainerInset = NSSize(width: 12, height: 12)
            tv.textStorage?.setAttributedString(text)
        }
        w.contentView = scroll
        w.center()
        w.makeKeyAndOrderFront(nil)
        windows.append(w)
    }
}
