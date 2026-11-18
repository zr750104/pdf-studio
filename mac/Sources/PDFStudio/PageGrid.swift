import AppKit
import PDFKit

/// 縮小したときの横並び表示。PDFView は 1 列（見開きは 2 列）しか並べられないため、
/// 横に 2 ページ以上入るほど縮小したら、同じ倍率のページを横に並べた一覧に切り替える。
/// ページをクリックすると、そのページを幅に合わせて元の表示に戻る。拡大すると元の表示に戻る。
final class PageGridView: NSScrollView, NSCollectionViewDataSource, NSCollectionViewDelegate {
    weak var editor: EditorPDFView?
    private let collection = GridCollectionView()
    private let layout = NSCollectionViewFlowLayout()
    private var cache = NSCache<NSNumber, NSImage>()
    private var cacheScale: CGFloat = 0
    static let gap: CGFloat = 16

    init(editor: EditorPDFView) {
        self.editor = editor
        super.init(frame: .zero)
        hasVerticalScroller = true
        drawsBackground = true
        backgroundColor = editor.backgroundColor
        layout.minimumInteritemSpacing = Self.gap
        layout.minimumLineSpacing = Self.gap
        layout.sectionInset = NSEdgeInsets(top: Self.gap, left: Self.gap, bottom: Self.gap, right: Self.gap)
        collection.collectionViewLayout = layout
        collection.editor = editor
        collection.dataSource = self
        collection.delegate = self
        collection.isSelectable = true
        collection.backgroundColors = [.clear]
        collection.register(PageGridItem.self, forItemWithIdentifier: PageGridItem.id)
        documentView = collection
        // 注釈やページが変わったら、縮小画像を作り直す
        let nc = NotificationCenter.default
        for name in [Notification.Name.studioAnnotationsChanged, .studioPagesChanged, .studioDocumentReplaced, .PDFViewDocumentChanged] {
            nc.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                guard let self, !self.isHidden else { return }
                self.cache.removeAllObjects()
                self.collection.reloadData()
            }
        }
    }

    required init?(coder: NSCoder) { nil }

    var pageCount: Int { editor?.document?.pageCount ?? 0 }

    /// 倍率が変わったら並べ直す
    func reload(scale: CGFloat, scrollTo index: Int?) {
        if abs(scale - cacheScale) > 0.001 { cache.removeAllObjects(); cacheScale = scale }
        layout.itemSize = itemSize(for: 0)
        collection.reloadData()
        if let index, index < pageCount {
            collection.scrollToItems(at: [IndexPath(item: index, section: 0)], scrollPosition: .top)
        }
    }

    /// ページの大きさ（いちばん大きいページに合わせて揃える）
    private func itemSize(for _: Int) -> NSSize {
        guard let doc = editor?.document, let p = doc.page(at: 0) else { return NSSize(width: 100, height: 140) }
        let s = DisplaySpace.size(of: p)
        let k = cacheScale
        return NSSize(width: max(40, s.width * k), height: max(56, s.height * k) + 16)
    }

    /// 最初に見えているページ
    var firstVisibleIndex: Int? { collection.indexPathsForVisibleItems().map(\.item).min() }

    func numberOfSections(in collectionView: NSCollectionView) -> Int { 1 }
    func collectionView(_ collectionView: NSCollectionView, numberOfItemsInSection section: Int) -> Int { pageCount }

    func collectionView(_ collectionView: NSCollectionView, itemForRepresentedObjectAt indexPath: IndexPath) -> NSCollectionViewItem {
        let item = collectionView.makeItem(withIdentifier: PageGridItem.id, for: indexPath) as! PageGridItem
        let i = indexPath.item
        item.number.stringValue = String(i + 1)
        item.index = i
        if let img = cache.object(forKey: NSNumber(value: i)) {
            item.pageImage.image = img
        } else {
            item.pageImage.image = nil
            guard let page = editor?.document?.page(at: i) else { return item }
            let size = DisplaySpace.size(of: page)
            let k = cacheScale * (window?.backingScaleFactor ?? 2)
            // ページの描画は編集と同じメインスレッドで（後回しにして、スクロールを止めない）
            DispatchQueue.main.async { [weak self] in
                guard let self, item.index == i, self.cache.object(forKey: NSNumber(value: i)) == nil else { return }
                let img = page.thumbnail(of: NSSize(width: size.width * k, height: size.height * k), for: .cropBox)
                self.cache.setObject(img, forKey: NSNumber(value: i))
                item.pageImage.image = img
            }
        }
        return item
    }

    func collectionView(_ collectionView: NSCollectionView, didSelectItemsAt indexPaths: Set<IndexPath>) {
        guard let i = indexPaths.first?.item else { return }
        collectionView.deselectAll(nil)
        editor?.leaveGrid(at: i)
    }
}

/// キー操作（テンキーの拡大・縮小など）はページの表示に渡す
final class GridCollectionView: NSCollectionView {
    weak var editor: EditorPDFView?
    override func keyDown(with event: NSEvent) {
        if let editor { editor.keyDown(with: event) } else { super.keyDown(with: event) }
    }
}

final class PageGridItem: NSCollectionViewItem {
    static let id = NSUserInterfaceItemIdentifier("PageGridItem")
    let pageImage = NSImageView()
    let number = NSTextField(labelWithString: "")
    var index = -1

    override func loadView() {
        let v = NSView()
        pageImage.imageScaling = .scaleProportionallyUpOrDown
        pageImage.wantsLayer = true
        pageImage.layer?.backgroundColor = NSColor.white.cgColor
        pageImage.layer?.shadowOpacity = 0.25
        pageImage.layer?.shadowRadius = 3
        number.alignment = .center
        number.font = NSFont.systemFont(ofSize: 10)
        number.textColor = .secondaryLabelColor
        pageImage.translatesAutoresizingMaskIntoConstraints = false
        number.translatesAutoresizingMaskIntoConstraints = false
        v.addSubview(pageImage)
        v.addSubview(number)
        NSLayoutConstraint.activate([
            pageImage.topAnchor.constraint(equalTo: v.topAnchor),
            pageImage.leadingAnchor.constraint(equalTo: v.leadingAnchor),
            pageImage.trailingAnchor.constraint(equalTo: v.trailingAnchor),
            pageImage.bottomAnchor.constraint(equalTo: v.bottomAnchor, constant: -16),
            number.centerXAnchor.constraint(equalTo: v.centerXAnchor),
            number.bottomAnchor.constraint(equalTo: v.bottomAnchor)
        ])
        view = v
    }
}

extension EditorPDFView {
    /// 横に 2 ページ以上入るほど縮小しているか
    var wantsGrid: Bool {
        // 「ページ全体を表示」などの自動の倍率では切り替えない（自分で縮小したときだけ）
        guard !autoScales, displayMode == .singlePageContinuous, let doc = document, doc.pageCount > 1, let p = doc.page(at: 0) else { return false }
        let w = DisplaySpace.size(of: p).width * scaleFactor
        return w * 2 + PageGridView.gap * 3 <= bounds.width
    }

    var isShowingGrid: Bool { grid?.isHidden == false }

    /// 倍率・大きさが変わったときに、横並び表示に切り替えるか決める
    func updateGrid() {
        if wantsGrid {
            let g = grid ?? {
                let g = PageGridView(editor: self)
                g.frame = bounds
                g.autoresizingMask = [.width, .height]
                addSubview(g)
                grid = g
                return g
            }()
            let wasHidden = g.isHidden
            g.isHidden = false
            g.reload(scale: scaleFactor, scrollTo: wasHidden ? currentPage.flatMap { document?.index(for: $0) } : g.firstVisibleIndex)
        } else if let g = grid, !g.isHidden {
            let first = g.firstVisibleIndex
            g.isHidden = true
            if let first, let p = document?.page(at: first) { go(to: p) }
        }
    }

    /// 横並び表示でページを選んだら、そのページを幅に合わせて表示する
    func leaveGrid(at index: Int) {
        guard let p = document?.page(at: index) else { return }
        grid?.isHidden = true
        let w = DisplaySpace.size(of: p).width
        scaleFactor = max(0.1, (bounds.width - 40) / w)
        go(to: p)
    }
}
