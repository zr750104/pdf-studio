import AppKit
import PDFKit

// 並べて表示：同じウィンドウのタブで開いている文書を、1 つのウィンドウの中に並べる。
// ほかの文書の画面（MainWindowController の中身）をこのウィンドウに移し、そのウィンドウは隠す。
// 移した画面の操作（メニュー・保存・取り消し）は、その文書に対して行う（PaneContainer がレスポンダーチェーンに文書の画面を入れる）。

enum SplitMode: Int, CaseIterable {
    case single = 0, horizontal, vertical, grid
    var paneCount: Int { [1, 2, 2, 4][rawValue] }
    var title: String { ["1 画面", "左右に 2 画面", "上下に 2 画面", "すべて並べる（最大 4 画面）"][rawValue] }
}

/// 並べて表示した 1 つの画面を包むビュー。操作中の画面は枠で示す
final class PaneContainer: NSView {
    weak var owner: MainWindowController?
    private let header = NSTextField(labelWithString: "")
    private let content: NSView
    var isActive = false { didSet { if isActive != oldValue { needsDisplay = true; updateHeader() } } }
    static let headerHeight: CGFloat = 22
    static let border: CGFloat = 2

    init(owner: MainWindowController, content: NSView) {
        self.owner = owner
        self.content = content
        super.init(frame: .zero)
        header.font = NSFont.systemFont(ofSize: 11, weight: .semibold)
        header.lineBreakMode = .byTruncatingMiddle
        header.translatesAutoresizingMaskIntoConstraints = false
        content.translatesAutoresizingMaskIntoConstraints = false
        addSubview(header)
        addSubview(content)
        let b = Self.border
        NSLayoutConstraint.activate([
            header.topAnchor.constraint(equalTo: topAnchor, constant: b + 3),
            header.leadingAnchor.constraint(equalTo: leadingAnchor, constant: b + 8),
            header.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -b - 8),
            content.topAnchor.constraint(equalTo: topAnchor, constant: Self.headerHeight + b),
            content.leadingAnchor.constraint(equalTo: leadingAnchor, constant: b),
            content.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -b),
            content.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -b)
        ])
        updateHeader()
    }

    required init?(coder: NSCoder) { nil }

    /// 文書の名前（保存していなければ ● を付ける）。ファイル名はユーザーの文字なので訳さない
    func updateHeader() {
        guard let doc = owner?.document as? NSDocument else { return }
        let name = (doc.isDocumentEdited ? "● " : "") + doc.displayName
        I18n.raw { header.stringValue = name }
        header.textColor = isActive ? .labelColor : .secondaryLabelColor
    }

    /// 中身を取り出す（並べて表示をやめるとき）
    func releaseContent() -> NSView {
        content.removeFromSuperview()
        content.translatesAutoresizingMaskIntoConstraints = true
        return content
    }

    override func draw(_ dirtyRect: NSRect) {
        (isActive ? NSColor.controlAccentColor : NSColor.separatorColor).setFill()
        let b = Self.border
        let r = bounds
        // 枠（上下左右）
        NSRect(x: 0, y: 0, width: r.width, height: b).fill()
        NSRect(x: 0, y: r.height - b, width: r.width, height: b).fill()
        NSRect(x: 0, y: 0, width: b, height: r.height).fill()
        NSRect(x: r.width - b, y: 0, width: b, height: r.height).fill()
    }

    /// この画面の文書の取り消し（ウィンドウの文書ではなく）
    override var undoManager: UndoManager? { (owner?.document as? NSDocument)?.undoManager }
}

extension MainWindowController {
    /// 並べて表示をしているウィンドウ（自分が並べた側なら自分）
    var splitHost: MainWindowController { embeddedIn ?? self }

    /// ダイアログを出すウィンドウ（並べて表示の中にいるときは、並べているウィンドウ）
    var hostWindow: NSWindow? { embeddedIn?.window ?? window }

    @objc func setSplitMode(_ sender: NSMenuItem) {
        splitHost.applySplit(SplitMode(rawValue: sender.tag) ?? .single)
    }

    /// 並べる相手：同じウィンドウのタブの文書（このウィンドウのタブの順）
    func tabPartners() -> [MainWindowController] {
        let tabs = window?.tabbedWindows ?? []
        // すでに並べて表示しているウィンドウ・並べられている画面は相手にしない（中の文書が行方不明にならないように）
        return tabs.compactMap { $0.windowController as? MainWindowController }
            .filter { $0 !== self && $0.splitMode == .single && $0.embeddedIn == nil && $0.splitPanes.isEmpty }
    }

    func applySplit(_ mode: SplitMode, only: [MainWindowController]? = nil) {
        let others = splitPanes
        if !others.isEmpty || splitMode != .single { exitSplit() }
        guard mode != .single else { return }
        var partners = only ?? tabPartners()
        // 前に並べていた文書を先に
        partners.sort { a, b in (others.firstIndex { $0 === a } ?? 99) < (others.firstIndex { $0 === b } ?? 99) }
        partners = Array(partners.prefix(mode.paneCount - 1))
        guard !partners.isEmpty, let win = window else {
            Dialog.alert("並べて表示する文書がありません", "並べて表示するには、2 つ以上の文書をこのウィンドウのタブで開いてください。")
            return
        }
        splitMode = mode
        splitPanes = partners
        savedLayout = []
        let all = [self] + partners
        var containers: [PaneContainer] = []
        for c in all {
            savedLayout.append((c.sidebarCollapsed, c.inspectorCollapsed))
            let content: NSView
            if c === self {
                content = c.rootController.view
                win.contentViewController = nil
            } else {
                content = c.rootController.view
                c.window?.contentViewController = NSViewController(nibName: nil, bundle: nil)
                c.window?.contentViewController?.view = NSView()
                // タブから外して隠す
                if let w = c.window { w.tabGroup?.removeWindow(w); w.orderOut(nil) }
                c.embeddedIn = self
            }
            c.setCompactForSplit(true, keepSidebar: c === self)
            containers.append(PaneContainer(owner: c, content: content))
        }
        let root = SplitRootView(mode: mode, panes: containers)
        win.contentView = root
        // 文書の画面をレスポンダーチェーンに入れる（メニューの操作がその文書に届くように）
        for pc in containers where pc.owner !== self {
            pc.owner?.paneOriginalNextResponder = pc.owner?.nextResponder
            pc.owner?.nextResponder = pc.superview
            pc.nextResponder = pc.owner
        }
        paneContainers = containers
        win.makeFirstResponder(editor)
        updateActivePane()
        startSplitObservers()
        NSApp.mainMenu.map(updateSplitMenuState)
    }

    func exitSplit() {
        guard let win = window else { return }
        stopSplitObservers()
        let containers = paneContainers
        paneContainers = []
        let saved = savedLayout
        for (i, pc) in containers.enumerated() {
            guard let c = pc.owner else { continue }
            let content = pc.releaseContent()
            pc.nextResponder = nil
            if c === self { continue }
            c.nextResponder = c.paneOriginalNextResponder
            c.embeddedIn = nil
            // 元のウィンドウの大きさのまま戻す（中身の大きさにウィンドウが合わせられないように）
            if let w = c.window { content.frame = NSRect(origin: .zero, size: w.contentRect(forFrameRect: w.frame).size) }
            c.window?.contentViewController = c.rootController
            if i < saved.count { c.restoreLayout(saved[i]) }
            if let w = c.window { win.addTabbedWindow(w, ordered: .above) }
        }
        let size = win.contentRect(forFrameRect: win.frame).size
        win.contentView = nil
        rootController.view.frame = NSRect(origin: .zero, size: size)
        win.contentViewController = rootController
        if let first = saved.first { restoreLayout(first) }
        splitPanes = []
        splitMode = .single
        win.makeKeyAndOrderFront(nil)
        win.makeFirstResponder(editor)
        NSApp.mainMenu.map(updateSplitMenuState)
    }

    /// 並べている画面を 1 つ外して、タブに戻す（その文書を閉じるときなど）
    func removePane(_ c: MainWindowController) {
        guard splitPanes.contains(where: { $0 === c }) else { return }
        let remaining = splitPanes.filter { $0 !== c }
        let mode = splitMode
        exitSplit()
        if !remaining.isEmpty {
            // 残りの文書で並べ直す（外した文書はタブに戻っている）
            splitPanes = remaining
            applySplit(mode, only: remaining)
        }
    }

    private var splitRoot: SplitRootView? { window?.contentView as? SplitRootView }

    /// 操作中の画面（キーボードの入力先がある画面）に枠を付ける
    func updateActivePane() {
        guard let fr = window?.firstResponder as? NSView else { return }
        var activeOwner: MainWindowController?
        for pc in paneContainers where fr.isDescendant(of: pc) { activeOwner = pc.owner }
        if activeOwner == nil { return }
        for pc in paneContainers {
            pc.isActive = pc.owner === activeOwner
            pc.updateHeader()
        }
    }

    private func startSplitObservers() {
        stopSplitObservers()
        guard let win = window else { return }
        splitObservation = win.observe(\.firstResponder, options: [.new]) { [weak self] _, _ in
            DispatchQueue.main.async { self?.updateActivePane() }
        }
        // 文書の名前・保存していない印を更新する
        splitTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            self?.paneContainers.forEach { $0.updateHeader() }
        }
    }

    private func stopSplitObservers() {
        splitObservation?.invalidate()
        splitObservation = nil
        splitTimer?.invalidate()
        splitTimer = nil
    }

    func updateSplitMenuState(_ menu: NSMenu) {
        for item in menu.items {
            if item.action == #selector(setSplitMode(_:)) { item.state = item.tag == splitHost.splitMode.rawValue ? .on : .off }
            if let s = item.submenu { updateSplitMenuState(s) }
        }
    }
}

/// 並べた画面を入れる分割ビュー（左右・上下・2×2）
final class SplitRootView: NSView {
    let panes: [PaneContainer]

    init(mode: SplitMode, panes: [PaneContainer]) {
        self.panes = panes
        super.init(frame: .zero)
        let main: NSSplitView
        func split(_ vertical: Bool, _ views: [NSView]) -> NSSplitView {
            let s = NSSplitView()
            s.isVertical = vertical
            s.dividerStyle = .thin
            views.forEach { s.addArrangedSubview($0) }
            return s
        }
        switch (mode, panes.count) {
        case (.vertical, _):
            main = split(false, panes)
        case (.grid, 4):
            main = split(false, [split(true, [panes[0], panes[1]]), split(true, [panes[2], panes[3]])])
        default:
            main = split(true, panes)
        }
        main.translatesAutoresizingMaskIntoConstraints = false
        addSubview(main)
        NSLayoutConstraint.activate([
            main.topAnchor.constraint(equalTo: topAnchor),
            main.leadingAnchor.constraint(equalTo: leadingAnchor),
            main.trailingAnchor.constraint(equalTo: trailingAnchor),
            main.bottomAnchor.constraint(equalTo: bottomAnchor)
        ])
        // 同じ大きさに分ける
        DispatchQueue.main.async { Self.equalize(main) }
    }

    required init?(coder: NSCoder) { nil }

    static func equalize(_ s: NSSplitView) {
        let n = s.arrangedSubviews.count
        guard n > 1 else { return }
        let total = s.isVertical ? s.bounds.width : s.bounds.height
        for i in 0..<(n - 1) { s.setPosition(total * CGFloat(i + 1) / CGFloat(n), ofDividerAt: i) }
        s.arrangedSubviews.compactMap { $0 as? NSSplitView }.forEach(equalize)
    }
}
