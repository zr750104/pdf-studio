import AppKit
import PDFKit
import UniformTypeIdentifiers

private extension NSPasteboard.PasteboardType {
    static let pageIndex = NSPasteboard.PasteboardType("com.local.pdfstudio.pageindex")
}

/// 左サイドバー：ページ / しおり / 注釈 / 検索
final class SidebarViewController: NSViewController {
    weak var editor: EditorPDFView!
    weak var studio: PDFStudioDocument!
    weak var controller: MainWindowController?

    private let segmented = NSSegmentedControl(labels: ["ページ", "しおり", "注釈", "検索"], trackingMode: .selectOne, target: nil, action: nil)
    private let container = NSView()
    let pages = PagesPanel()
    let outline = OutlinePanel()
    let annotations = AnnotationsPanel()
    let search = SearchPanel()

    override func loadView() {
        let v = NSView()
        segmented.target = self
        segmented.action = #selector(switchTab)
        segmented.selectedSegment = 0
        segmented.segmentDistribution = .fillEqually
        segmented.translatesAutoresizingMaskIntoConstraints = false
        container.translatesAutoresizingMaskIntoConstraints = false
        v.addSubview(segmented)
        v.addSubview(container)
        NSLayoutConstraint.activate([
            segmented.topAnchor.constraint(equalTo: v.topAnchor, constant: 8),
            segmented.leadingAnchor.constraint(equalTo: v.leadingAnchor, constant: 8),
            segmented.trailingAnchor.constraint(equalTo: v.trailingAnchor, constant: -8),
            container.topAnchor.constraint(equalTo: segmented.bottomAnchor, constant: 8),
            container.leadingAnchor.constraint(equalTo: v.leadingAnchor),
            container.trailingAnchor.constraint(equalTo: v.trailingAnchor),
            container.bottomAnchor.constraint(equalTo: v.bottomAnchor),
            v.widthAnchor.constraint(greaterThanOrEqualToConstant: 180)
        ])
        view = v
    }

    func configure() {
        for p in [pages, outline, annotations, search] as [SidebarPanel] {
            p.sidebar = self
            p.view.frame = container.bounds
            p.view.autoresizingMask = [.width, .height]
        }
        show(0)
        reloadAll()
    }

    func reloadAll() {
        pages.reload()
        outline.reload()
        annotations.reload()
    }

    @objc private func switchTab() { show(segmented.selectedSegment) }

    func show(_ i: Int) {
        segmented.selectedSegment = i
        container.subviews.forEach { $0.removeFromSuperview() }
        let panel: SidebarPanel = [pages, outline, annotations, search][i]
        panel.view.frame = container.bounds
        container.addSubview(panel.view)
        if i == 3 { view.window?.makeFirstResponder(search.field) }
    }
}

class SidebarPanel: NSObject {
    weak var sidebar: SidebarViewController?
    var editor: EditorPDFView? { sidebar?.editor }
    var studio: PDFStudioDocument? { sidebar?.studio }
    let view = NSView()

    func makeScroll(_ doc: NSView) -> NSScrollView {
        let s = NSScrollView()
        s.documentView = doc
        s.hasVerticalScroller = true
        s.autohidesScrollers = true
        s.drawsBackground = false
        return s
    }
}

// MARK: - ページ（サムネイル・並べ替え）

final class PagesPanel: SidebarPanel, NSTableViewDataSource, NSTableViewDelegate {
    let table = NSTableView()
    private var cache: [ObjectIdentifier: NSImage] = [:]
    private var syncing = false

    override init() {
        super.init()
        let col = NSTableColumn(identifier: .init("page"))
        table.addTableColumn(col)
        table.headerView = nil
        table.rowHeight = 170
        table.allowsMultipleSelection = true
        table.dataSource = self
        table.delegate = self
        table.backgroundColor = .clear
        table.style = .plain
        table.registerForDraggedTypes([.pageIndex, .fileURL])
        table.setDraggingSourceOperationMask(.move, forLocal: true)
        table.setDraggingSourceOperationMask(.copy, forLocal: false)
        table.menu = makeMenu()
        let scroll = makeScroll(table)
        scroll.frame = view.bounds
        scroll.autoresizingMask = [.width, .height]
        view.addSubview(scroll)
        NotificationCenter.default.addObserver(self, selector: #selector(pageChanged), name: .PDFViewPageChanged, object: nil)
    }

    private func makeMenu() -> NSMenu {
        let m = NSMenu()
        let items: [(String, Selector)] = [
            ("右に90°回転", #selector(MainWindowController.rotateRight(_:))),
            ("左に90°回転", #selector(MainWindowController.rotateLeft(_:))),
            ("複製", #selector(MainWindowController.duplicatePages(_:))),
            ("空白ページを後ろに挿入", #selector(MainWindowController.insertBlankPage(_:))),
            ("ファイルからページを挿入…", #selector(MainWindowController.insertFromFile(_:))),
            ("ページを抽出…", #selector(MainWindowController.extractPages(_:))),
            ("ページを削除", #selector(MainWindowController.deletePages(_:)))
        ]
        for (i, (t, s)) in items.enumerated() {
            if i == 2 || i == 6 { m.addItem(.separator()) }
            m.addItem(NSMenuItem(title: t, action: s, keyEquivalent: ""))
        }
        return m
    }

    func reload() {
        cache.removeAll()
        table.reloadData()
        pageChanged()
    }

    func reloadPages(_ indexes: IndexSet) {
        for i in indexes { if let p = studio?.pdf.page(at: i) { cache[ObjectIdentifier(p)] = nil } }
        table.reloadData(forRowIndexes: indexes, columnIndexes: [0])
    }

    /// サイドバーで選択中のページ（未選択なら表示中のページ）
    var selectedIndexes: [Int] {
        let sel = table.selectedRowIndexes
        if !sel.isEmpty { return Array(sel) }
        if let e = editor, let p = e.currentPage, let d = e.document { return [d.index(for: p)] }
        return []
    }

    @objc private func pageChanged() {
        guard let e = editor, let p = e.currentPage, let d = e.document else { return }
        let i = d.index(for: p)
        guard i != NSNotFound, i < table.numberOfRows else { return }
        if !table.selectedRowIndexes.contains(i) || table.selectedRowIndexes.count == 1 {
            syncing = true
            table.selectRowIndexes([i], byExtendingSelection: false)
            syncing = false
        }
        table.scrollRowToVisible(i)
    }

    func numberOfRows(in tableView: NSTableView) -> Int { studio?.pdf.pageCount ?? 0 }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let id = NSUserInterfaceItemIdentifier("thumb")
        let cell: ThumbCell = (tableView.makeView(withIdentifier: id, owner: nil) as? ThumbCell) ?? ThumbCell()
        cell.identifier = id
        guard let page = studio?.pdf.page(at: row) else { return cell }
        let key = ObjectIdentifier(page)
        let img: NSImage
        if let c = cache[key] { img = c } else {
            img = page.thumbnail(of: NSSize(width: 220, height: 280), for: .cropBox)
            cache[key] = img
        }
        cell.thumb.image = img
        cell.label.stringValue = page.label.map { $0 == String(row + 1) ? $0 : "\(row + 1) (\($0))" } ?? String(row + 1)
        return cell
    }

    func tableViewSelectionDidChange(_ notification: Notification) {
        guard !syncing, table.selectedRowIndexes.count == 1, let i = table.selectedRowIndexes.first,
              let p = studio?.pdf.page(at: i) else { return }
        editor?.go(to: p)
    }

    // ドラッグで並べ替え
    func tableView(_ tableView: NSTableView, pasteboardWriterForRow row: Int) -> NSPasteboardWriting? {
        let item = NSPasteboardItem()
        item.setString(String(row), forType: .pageIndex)
        return item
    }

    func tableView(_ tableView: NSTableView, validateDrop info: NSDraggingInfo, proposedRow row: Int,
                   proposedDropOperation op: NSTableView.DropOperation) -> NSDragOperation {
        tableView.setDropRow(row, dropOperation: .above)
        if info.draggingPasteboard.types?.contains(.pageIndex) == true { return .move }
        return .copy
    }

    func tableView(_ tableView: NSTableView, acceptDrop info: NSDraggingInfo, row: Int,
                   dropOperation: NSTableView.DropOperation) -> Bool {
        guard let studio else { return false }
        let pb = info.draggingPasteboard
        if let items = pb.pasteboardItems, pb.types?.contains(.pageIndex) == true {
            let rows = items.compactMap { $0.string(forType: .pageIndex).flatMap(Int.init) }.sorted()
            guard !rows.isEmpty else { return false }
            studio.performStructuralChange("ページの移動") { pdf in
                let pages = rows.compactMap { pdf.page(at: $0) }
                for r in rows.reversed() { pdf.removePage(at: r) }
                let target = row - rows.filter { $0 < row }.count
                for (k, p) in pages.enumerated() { pdf.insert(p, at: target + k) }
            }
            table.selectRowIndexes(IndexSet(integersIn: (row - rows.filter { $0 < row }.count)..<(row - rows.filter { $0 < row }.count + rows.count)), byExtendingSelection: false)
            return true
        }
        // Finder から PDF / 画像をドロップして挿入
        guard let urls = pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL], !urls.isEmpty else { return false }
        let src = Operations.createPDF(from: urls)
        guard src.pageCount > 0 else { return false }
        studio.performStructuralChange("ページの挿入") { pdf in
            for i in 0..<src.pageCount { if let p = src.page(at: i) { pdf.insert(p, at: row + i) } }
        }
        return true
    }
}

final class ThumbCell: NSTableCellView {
    let thumb = NSImageView()
    let label = NSTextField(labelWithString: "")

    init() {
        super.init(frame: .zero)
        thumb.imageScaling = .scaleProportionallyDown
        thumb.wantsLayer = true
        thumb.layer?.shadowOpacity = 0.25
        thumb.layer?.shadowRadius = 2
        thumb.layer?.shadowOffset = CGSize(width: 0, height: -1)
        label.alignment = .center
        label.font = NSFont.systemFont(ofSize: 11)
        label.textColor = .secondaryLabelColor
        thumb.translatesAutoresizingMaskIntoConstraints = false
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(thumb)
        addSubview(label)
        NSLayoutConstraint.activate([
            thumb.topAnchor.constraint(equalTo: topAnchor, constant: 6),
            thumb.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
            thumb.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            thumb.bottomAnchor.constraint(equalTo: label.topAnchor, constant: -4),
            label.leadingAnchor.constraint(equalTo: leadingAnchor),
            label.trailingAnchor.constraint(equalTo: trailingAnchor),
            label.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -4)
        ])
    }

    required init?(coder: NSCoder) { nil }
}

// MARK: - しおり

final class OutlinePanel: SidebarPanel, NSOutlineViewDataSource, NSOutlineViewDelegate, NSTextFieldDelegate {
    let outlineView = NSOutlineView()

    override init() {
        super.init()
        let col = NSTableColumn(identifier: .init("label"))
        outlineView.addTableColumn(col)
        outlineView.outlineTableColumn = col
        outlineView.headerView = nil
        outlineView.dataSource = self
        outlineView.delegate = self
        outlineView.style = .sourceList
        outlineView.target = self
        outlineView.action = #selector(clicked)
        outlineView.doubleAction = #selector(rename)

        let scroll = makeScroll(outlineView)
        let add = NSButton(image: NSImage(systemSymbolName: "plus", accessibilityDescription: "追加")!, target: self, action: #selector(addBookmark))
        let addChild = NSButton(title: "子を追加", target: self, action: #selector(addChildBookmark))
        let del = NSButton(image: NSImage(systemSymbolName: "minus", accessibilityDescription: "削除")!, target: self, action: #selector(removeBookmark))
        func symbol(_ name: String, _ tip: String, _ action: Selector) -> NSButton {
            let b = NSButton(image: NSImage(systemSymbolName: name, accessibilityDescription: tip)!, target: self, action: action)
            b.toolTip = tip
            return b
        }
        let up = symbol("arrow.up", "選択したしおりを上へ", #selector(moveUp))
        let down = symbol("arrow.down", "選択したしおりを下へ", #selector(moveDown))
        let outdent = symbol("arrow.left", "選択したしおりを 1 段上げる", #selector(outdentBookmark))
        let indent = symbol("arrow.right", "選択したしおりを 1 段下げる", #selector(indentBookmark))
        for b in [add, addChild, del, up, down, outdent, indent] { b.bezelStyle = .smallSquare; b.controlSize = .small }
        add.toolTip = "現在のページにしおりを追加"
        del.toolTip = "選択したしおりを削除"
        NotificationCenter.default.addObserver(forName: .studioOutlineChanged, object: nil, queue: .main) { [weak self] n in
            guard let self, let d = n.object as? PDFStudioDocument, d === self.studio else { return }
            self.reload()
        }
        let bar = NSStackView(views: [add, del, addChild, up, down, outdent, indent])
        bar.orientation = .horizontal
        bar.spacing = 4
        scroll.translatesAutoresizingMaskIntoConstraints = false
        bar.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(scroll)
        view.addSubview(bar)
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: view.topAnchor),
            scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: bar.topAnchor, constant: -6),
            bar.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 8),
            bar.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -8)
        ])
    }

    func reload() {
        outlineView.reloadData()
        outlineView.expandItem(nil, expandChildren: true)
    }

    private var root: PDFOutline? { studio?.pdf.outlineRoot }

    func outlineView(_ outlineView: NSOutlineView, numberOfChildrenOfItem item: Any?) -> Int {
        ((item as? PDFOutline) ?? root)?.numberOfChildren ?? 0
    }

    func outlineView(_ outlineView: NSOutlineView, child index: Int, ofItem item: Any?) -> Any {
        ((item as? PDFOutline) ?? root)!.child(at: index)!
    }

    func outlineView(_ outlineView: NSOutlineView, isItemExpandable item: Any) -> Bool {
        ((item as? PDFOutline)?.numberOfChildren ?? 0) > 0
    }

    func outlineView(_ outlineView: NSOutlineView, viewFor tableColumn: NSTableColumn?, item: Any) -> NSView? {
        let tf = NSTextField(string: (item as? PDFOutline)?.label ?? "")
        tf.isBordered = false
        tf.drawsBackground = false
        tf.isEditable = false
        tf.delegate = self
        tf.lineBreakMode = .byTruncatingTail
        let cell = NSTableCellView()
        cell.textField = tf
        cell.addSubview(tf)
        tf.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            tf.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 2),
            tf.trailingAnchor.constraint(equalTo: cell.trailingAnchor),
            tf.centerYAnchor.constraint(equalTo: cell.centerYAnchor)
        ])
        return cell
    }

    @objc private func clicked() {
        guard let o = outlineView.item(atRow: outlineView.clickedRow) as? PDFOutline else { return }
        if let d = o.destination { editor?.go(to: d) } else if let a = o.action { editor?.perform(a) }
    }

    @objc private func rename() {
        let row = outlineView.clickedRow
        guard row >= 0, let cell = outlineView.view(atColumn: 0, row: row, makeIfNecessary: false) as? NSTableCellView,
              let tf = cell.textField else { return }
        tf.isEditable = true
        view.window?.makeFirstResponder(tf)
    }

    func controlTextDidEndEditing(_ obj: Notification) {
        guard let tf = obj.object as? NSTextField else { return }
        tf.isEditable = false
        let row = outlineView.row(for: tf)
        guard row >= 0, let o = outlineView.item(atRow: row) as? PDFOutline, o.label != tf.stringValue, let doc = studio else { return }
        OutlineEdit.rename(o, to: tf.stringValue, in: doc)
        warnFormLoss()
    }

    private func newBookmark() -> PDFOutline? {
        guard let e = editor, let page = e.currentPage, let doc = studio?.pdf else { return nil }
        guard let title = Dialog.text("しおりを追加", initial: "ページ \(doc.index(for: page) + 1)", multiline: false), !title.isEmpty else { return nil }
        let o = PDFOutline()
        o.label = title
        let visible = e.convert(e.bounds, to: page)
        o.destination = PDFDestination(page: page, at: CGPoint(x: 0, y: min(visible.maxY, page.bounds(for: .cropBox).maxY)))
        return o
    }

    @objc private func addBookmark() {
        guard let doc = studio?.pdf, let o = newBookmark() else { return }
        if doc.outlineRoot == nil { doc.outlineRoot = PDFOutline() }
        guard let root = doc.outlineRoot, let studio else { return }
        OutlineEdit.insert(o, into: root, at: root.numberOfChildren, in: studio)
        reload()
        select(o)
        warnFormLoss()
    }

    @objc private func addChildBookmark() {
        guard let parent = outlineView.item(atRow: outlineView.selectedRow) as? PDFOutline else { addBookmark(); return }
        guard let o = newBookmark(), let studio else { return }
        OutlineEdit.insert(o, into: parent, at: parent.numberOfChildren, in: studio)
        reload()
        select(o)
        warnFormLoss()
    }

    /// フォームやページラベルのある文書では、しおりを変えて保存するとそれらが失われることを 1 度だけ知らせる
    private var warnedFormLoss = false
    private func warnFormLoss() {
        guard !warnedFormLoss, let doc = studio?.pdf, Compositor.hasFormOrPageLabels(doc) else { return }
        warnedFormLoss = true
        Dialog.alert("フォーム・ページラベルについて", "この PDF にはフォームの欄またはページラベル（i, ii などのページ番号の表記）があります。しおりを変えて保存すると、ほかのアプリでのフォームの入力やページラベルが使えなくなることがあります。気になる場合は、別名で保存してください。")
    }

    private var selected: PDFOutline? { outlineView.item(atRow: outlineView.selectedRow) as? PDFOutline }

    private func select(_ o: PDFOutline) {
        let row = outlineView.row(forItem: o)
        if row >= 0 { outlineView.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false); outlineView.scrollRowToVisible(row) }
    }

    @objc private func removeBookmark() {
        guard let o = selected, let studio else { return }
        OutlineEdit.remove(o, in: studio)
        reload()
        warnFormLoss()
    }

    /// 並べ替え・段の上げ下げ。動かしたしおりを選んだままにする（続けて動かせるように）
    private func relocate(_ op: (PDFOutline, PDFStudioDocument) -> Bool) {
        guard let o = selected, let studio else { NSSound.beep(); return }
        if op(o, studio) { reload(); select(o); warnFormLoss() } else { NSSound.beep() }
    }
    @objc private func moveUp() { relocate { OutlineEdit.move($0, by: -1, in: $1) } }
    @objc private func moveDown() { relocate { OutlineEdit.move($0, by: 1, in: $1) } }
    @objc private func indentBookmark() { relocate { OutlineEdit.indent($0, in: $1) } }
    @objc private func outdentBookmark() { relocate { OutlineEdit.outdent($0, in: $1) } }
}

// MARK: - 注釈一覧

final class AnnotationsPanel: SidebarPanel, NSTableViewDataSource, NSTableViewDelegate {
    let table = NSTableView()
    private var items: [(Int, PDFAnnotation)] = []

    override init() {
        super.init()
        for (id, title, w) in [("page", "頁", 34.0), ("kind", "種類", 90.0), ("text", "内容", 200.0)] {
            let c = NSTableColumn(identifier: .init(id))
            c.title = title
            c.width = w
            table.addTableColumn(c)
        }
        table.dataSource = self
        table.delegate = self
        table.usesAlternatingRowBackgroundColors = true
        table.target = self
        table.action = #selector(clicked)
        let scroll = makeScroll(table)
        scroll.frame = view.bounds
        scroll.autoresizingMask = [.width, .height]
        view.addSubview(scroll)
        NotificationCenter.default.addObserver(self, selector: #selector(reloadFromNotification), name: .studioAnnotationsChanged, object: nil)
    }

    @objc private func reloadFromNotification(_ n: Notification) {
        if (n.object as? EditorPDFView) === editor { reload() }
    }

    func reload() {
        items = []
        if let doc = studio?.pdf {
            for i in 0..<doc.pageCount {
                for a in doc.page(at: i)?.annotations ?? [] where a.type != "Popup" && a.type != "Link" {
                    if AnnotationMarker.editGroup(a) != nil, a.type == "Square" { continue }
                    items.append((i, a))
                }
            }
        }
        table.reloadData()
    }

    func numberOfRows(in tableView: NSTableView) -> Int { items.count }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let (i, a) = items[row]
        let s: String
        switch tableColumn?.identifier.rawValue {
        case "page": s = String(i + 1)
        case "kind": s = a.studioKindName
        default: s = (a.type == "Widget" ? a.fieldName : a.contents)?.replacingOccurrences(of: "\n", with: " ") ?? ""
        }
        // 注釈の内容はユーザーの文字なので訳さない（種類だけ訳す）
        let tf = tableColumn?.identifier.rawValue == "kind" ? NSTextField(labelWithString: s) : I18n.raw { NSTextField(labelWithString: s) }
        tf.lineBreakMode = .byTruncatingTail
        return tf
    }

    @objc private func clicked() {
        let r = table.clickedRow
        guard r >= 0, r < items.count else { return }
        editor?.reveal(items[r].1)
    }
}

// MARK: - 検索

final class SearchPanel: SidebarPanel, NSTableViewDataSource, NSTableViewDelegate, NSSearchFieldDelegate {
    let field = NSSearchField()
    let table = NSTableView()
    private let status = NSTextField(labelWithString: "")
    private let caseCheck = NSButton(checkboxWithTitle: "大文字小文字を区別", target: nil, action: nil)
    private var results: [PDFSelection] = []
    private var snippets: [String] = []

    override init() {
        super.init()
        field.placeholderString = "文書内を検索"
        field.target = self
        field.action = #selector(runSearch)
        field.sendsWholeSearchString = true
        let c = NSTableColumn(identifier: .init("r"))
        table.addTableColumn(c)
        table.headerView = nil
        table.dataSource = self
        table.delegate = self
        table.rowHeight = 36
        table.target = self
        table.action = #selector(clicked)
        status.font = NSFont.systemFont(ofSize: 11)
        status.textColor = .secondaryLabelColor
        caseCheck.controlSize = .small
        let redact = NSButton(title: "すべてに墨消しマーク", target: self, action: #selector(markAllForRedaction))
        redact.controlSize = .small
        redact.bezelStyle = .rounded
        let scroll = makeScroll(table)
        for v in [field, status, caseCheck, scroll, redact] as [NSView] {
            v.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(v)
        }
        NSLayoutConstraint.activate([
            field.topAnchor.constraint(equalTo: view.topAnchor),
            field.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 8),
            field.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -8),
            caseCheck.topAnchor.constraint(equalTo: field.bottomAnchor, constant: 4),
            caseCheck.leadingAnchor.constraint(equalTo: field.leadingAnchor),
            status.topAnchor.constraint(equalTo: caseCheck.bottomAnchor, constant: 4),
            status.leadingAnchor.constraint(equalTo: field.leadingAnchor),
            scroll.topAnchor.constraint(equalTo: status.bottomAnchor, constant: 4),
            scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: redact.topAnchor, constant: -6),
            redact.leadingAnchor.constraint(equalTo: field.leadingAnchor),
            redact.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -8)
        ])
    }

    @objc func runSearch() {
        guard let doc = studio?.pdf else { return }
        let q = field.stringValue
        results = q.isEmpty ? [] : doc.findString(q, withOptions: caseCheck.state == .on ? [] : [.caseInsensitive])
        snippets = results.map { sel in
            let ext = sel.copy() as! PDFSelection
            ext.extend(atStart: 12)
            ext.extend(atEnd: 24)
            let page = sel.pages.first.map { doc.index(for: $0) + 1 } ?? 0
            return "p.\(page)  " + (ext.string ?? "").replacingOccurrences(of: "\n", with: " ")
        }
        status.stringValue = q.isEmpty ? "" : "\(results.count) 件見つかりました"
        editor?.highlightedSelections = results.map {
            let s = $0.copy() as! PDFSelection
            s.color = NSColor.systemYellow.withAlphaComponent(0.6)
            return s
        }
        table.reloadData()
        if let f = results.first { editor?.go(to: f); editor?.setCurrentSelection(f, animate: true) }
    }

    func numberOfRows(in tableView: NSTableView) -> Int { results.count }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let tf = NSTextField(wrappingLabelWithString: snippets[row])
        tf.font = NSFont.systemFont(ofSize: 11)
        tf.maximumNumberOfLines = 2
        tf.lineBreakMode = .byTruncatingTail
        return tf
    }

    @objc private func clicked() {
        let r = table.clickedRow
        guard r >= 0, r < results.count else { return }
        editor?.go(to: results[r])
        editor?.setCurrentSelection(results[r], animate: true)
    }

    /// 検索結果をすべて墨消し対象としてマーク（検索して墨消し）
    @objc private func markAllForRedaction() {
        guard let e = editor, !results.isEmpty else { return }
        for sel in results {
            for line in sel.selectionsByLine() {
                for page in line.pages {
                    let b = line.bounds(for: page).insetBy(dx: -1, dy: -1)
                    e.add(e.makeRedactionMark(b), to: page, name: "墨消しのマーク")
                }
            }
        }
        Dialog.alert("\(results.count) 件に墨消しマークを付けました", "「文書 > 墨消しを適用」で確定すると、該当部分の文字情報が完全に削除されます。")
    }
}
