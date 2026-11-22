import AppKit
import PDFKit
import UniformTypeIdentifiers

/// ツールに応じて注釈の作成・選択・移動・リサイズを行う PDFView
final class EditorPDFView: PDFView {

    var tool: Tool = .select {
        didSet {
            if tool != oldValue {
                mode = .none
                inkPoints = []
                measurePoints = []
                if tool != .measureDistance { calibrating = nil }
                if tool != .select { selectAnnotation(nil) }
                if !tool.isMarkup && tool != .select { clearSelection() }
                overlay.needsDisplay = true
                window?.invalidateCursorRects(for: self)
                NotificationCenter.default.post(name: .studioToolChanged, object: self)
            }
        }
    }
    let settings = ToolSettings()
    weak var studioDocument: PDFStudioDocument?
    private(set) var selectedAnnotation: PDFAnnotation?

    private let overlay = OverlayView()
    private enum DragMode { case none, create, move, resize, pan, passthrough, vertex }
    private var mode: DragMode = .none
    private var dragPage: PDFPage?
    private var dragStart = CGPoint.zero
    private var dragCurrent = CGPoint.zero
    private var lastPagePoint = CGPoint.zero
    private var inkPoints: [CGPoint] = []
    private var originalBounds: [(PDFAnnotation, CGRect)] = []
    private var panLast = NSPoint.zero
    /// 手のひらで動かしたときの位置の記録（離したときの速さを求める）
    private var panSamples: [(t: TimeInterval, p: NSPoint)] = []
    /// 慣性スクロール（手のひらで払って離すと、滑ってだんだん止まる）
    private var momentum: (timer: Timer, v: CGPoint, last: TimeInterval, origin: CGPoint)?
    static let momentumTau: Double = 0.325       // 減速の時定数（秒）
    static let momentumStart: CGFloat = 250      // これより速く払ったら滑る（ポイント/秒）
    static let momentumMax: CGFloat = 6000       // 速さの上限（ポイント/秒）
    private var menuTargets: [ClosureTarget] = []
    /// 縮小したときの横並び表示（PageGrid.swift）
    var grid: PageGridView?
    /// フォームが失われることを知らせたか（文書ごとに 1 度）
    private var warnedFormLoss = false
    // 測定（周長・面積）で置いた頂点（ページ座標）と、マウスの位置
    private(set) var measurePoints: [CGPoint] = []
    private var measurePage: PDFPage?
    private var measureHover: CGPoint?
    /// 頂点を動かしている測定（図形・ラベル・頂点の番号・動かす前の頂点）
    private var vertexEdit: (shape: PDFAnnotation, label: PDFAnnotation, index: Int, before: [CGPoint], data: MeasureData)?
    /// キャリブレーション中（距離ツールで基準線を引いたら呼ぶ）
    var calibrating: ((CGFloat) -> Void)?
    private var observingClip = false

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        setup()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        setup()
    }

    private func setup() {
        minScaleFactor = 0.1
        // ファイルのドロップは自分で受ける（PDFView に任せると NSDocument を通さずに中身が入れ替わる）
        acceptsDraggedFiles = false
        registerForDraggedTypes([.fileURL])
        overlay.editor = self
        overlay.frame = bounds
        overlay.autoresizingMask = [.width, .height]
        addSubview(overlay)
        let nc = NotificationCenter.default
        // 縮小して横に 2 ページ以上入るようになったら、横並び表示に切り替える
        nc.addObserver(forName: .PDFViewScaleChanged, object: self, queue: .main) { [weak self] _ in self?.updateGrid() }
        for name in [Notification.Name.PDFViewScaleChanged, .PDFViewPageChanged, .PDFViewDocumentChanged, .PDFViewDisplayModeChanged] {
            nc.addObserver(self, selector: #selector(refreshOverlay), name: name, object: self)
        }
        nc.addObserver(self, selector: #selector(widgetHit(_:)), name: .PDFViewAnnotationHit, object: self)
    }

    override func layout() {
        super.layout()
        if subviews.last !== overlay { addSubview(overlay, positioned: .above, relativeTo: nil) }
        overlay.frame = bounds
        if !observingClip, let clip = documentView?.enclosingScrollView?.contentView {
            clip.postsBoundsChangedNotifications = true
            NotificationCenter.default.addObserver(self, selector: #selector(refreshOverlay), name: NSView.boundsDidChangeNotification, object: clip)
            observingClip = true
        }
    }

    @objc private func refreshOverlay() { overlay.needsDisplay = true }

    // MARK: ファイルのドロップ（PDF・TIFF は開き、画像・Word・テキストは PDF にして開く）

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        DropOpen.fileURLs(sender).isEmpty ? super.draggingEntered(sender) : .copy
    }

    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        DropOpen.fileURLs(sender).isEmpty ? super.draggingUpdated(sender) : .copy
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let urls = DropOpen.fileURLs(sender)
        guard !urls.isEmpty else { return super.performDragOperation(sender) }
        // ドロップの処理が終わってから開く（ダイアログやウィンドウを出すため）
        DispatchQueue.main.async { DropOpen.open(urls) }
        return true
    }

    @objc private func widgetHit(_ n: Notification) {
        // フォーム入力などでも変更ありとみなす
        studioDocument?.updateChangeCount(.changeDone)
    }

    // MARK: - 注釈の追加・削除（取り消し対応）

    private func registerUndo(_ name: String, _ handler: @escaping (EditorPDFView) -> Void) {
        guard let um = studioDocument?.undoManager else {
            studioDocument?.updateChangeCount(.changeDone)
            return
        }
        um.registerUndo(withTarget: self, handler: handler)
        if !um.isUndoing && !um.isRedoing { um.setActionName(L(name)) }
    }

    func add(_ a: PDFAnnotation, to page: PDFPage, select: Bool = false, name: String = "注釈の追加") {
        page.addAnnotation(a)
        annotationsChanged(on: page)
        registerUndo(name) { $0.remove(a, name: name) }
        if select { selectAnnotation(a) }
        NotificationCenter.default.post(name: .studioAnnotationsChanged, object: self)
    }

    func remove(_ a: PDFAnnotation, name: String = "注釈の削除") {
        guard let page = a.page else { return }
        if selectedAnnotation === a { selectAnnotation(nil) }
        page.removeAnnotation(a)
        annotationsChanged(on: page)
        registerUndo(name) { $0.add(a, to: page, name: name) }
        NotificationCenter.default.post(name: .studioAnnotationsChanged, object: self)
    }

    /// テキスト編集で作った白塗り＋文字のペアはまとめて扱う
    func groupMembers(of a: PDFAnnotation) -> [PDFAnnotation] {
        guard let g = AnnotationMarker.editGroup(a) ?? Measure.group(of: a), let page = a.page else { return [a] }
        return page.annotations.filter { $0.userName == g }
    }

    /// 注釈を置き換える（取り消しで元に戻る）
    func replace(_ old: PDFAnnotation, with new: PDFAnnotation, name: String) {
        guard let page = old.page else { return }
        let wasSelected = selectedAnnotation === old
        page.removeAnnotation(old)
        page.addAnnotation(new)
        annotationsChanged(on: page)
        if wasSelected { selectAnnotation(new) }
        registerUndo(name) { $0.replace(new, with: old, name: name) }
        NotificationCenter.default.post(name: .studioAnnotationsChanged, object: self)
    }

    func removeWithGroup(_ a: PDFAnnotation) {
        for m in groupMembers(of: a) { remove(m) }
    }

    private func applyBounds(_ items: [(PDFAnnotation, CGRect)], name: String) {
        let inverse = items.map { ($0.0, $0.0.bounds) }
        for (a, r) in items {
            a.bounds = r
            if let p = a.page { annotationsChanged(on: p) }
        }
        registerUndo(name) { $0.applyBounds(inverse, name: name) }
        overlay.needsDisplay = true
        NotificationCenter.default.post(name: .studioSelectionChanged, object: self)
    }

    /// 選択中の注釈を変更する（インスペクタから呼ばれる）
    func modifySelected(_ change: (PDFAnnotation) -> Void) {
        guard let a = selectedAnnotation else { return }
        change(a)
        if let p = a.page { annotationsChanged(on: p) }
        studioDocument?.updateChangeCount(.changeDone)
        overlay.needsDisplay = true
    }

    func selectAnnotation(_ a: PDFAnnotation?) {
        selectedAnnotation = a
        overlay.needsDisplay = true
        NotificationCenter.default.post(name: .studioSelectionChanged, object: self)
    }

    func reveal(_ a: PDFAnnotation) {
        guard let page = a.page else { return }
        go(to: a.bounds.insetBy(dx: -40, dy: -40), on: page)
        if tool != .select { tool = .select }
        selectAnnotation(a)
    }

    // MARK: - ヒットテスト

    private func hitAnnotation(_ page: PDFPage, _ p: CGPoint, includeForms: Bool) -> PDFAnnotation? {
        for a in page.annotations.reversed() {
            guard a.bounds.insetBy(dx: -3, dy: -3).contains(p) else { continue }
            let t = a.type ?? ""
            if t == "Popup" { continue }
            if !includeForms && (t == "Widget" || t == "Link") { continue }
            return a
        }
        return nil
    }

    func handleRect(for a: PDFAnnotation) -> CGRect? {
        guard let page = a.page, a.isResizable else { return nil }
        let c = convert(CGPoint(x: a.bounds.maxX, y: a.bounds.minY), from: page)
        return CGRect(x: c.x - 6, y: c.y - 6, width: 12, height: 12)
    }

    // MARK: - マウス

    override func mouseDown(with event: NSEvent) {
        // 滑っているのを止めるための押下では、手のひら以外のツールは何もしない（リンクを開いたりしない）
        let wasGliding = isGliding
        stopMomentum()
        if wasGliding && tool != .hand { return }
        window?.makeFirstResponder(self)
        let vp = convert(event.locationInWindow, from: nil)
        guard document != nil, let page = page(for: vp, nearest: true) else {
            super.mouseDown(with: event)
            return
        }
        let pp = convert(vp, to: page)
        mode = .none
        dragPage = page
        lastPagePoint = pp

        switch tool {
        case .select:
            let withForms = event.modifierFlags.contains(.option)
            if let sel = selectedAnnotation, sel.page === page, let (shape, label, i) = measureVertexHit(sel, vp), let d = Measure.data(of: shape) {
                mode = .vertex
                vertexEdit = (shape, label, i, Measure.absolute(d, origin: shape.bounds.origin), d)
            } else if let sel = selectedAnnotation, sel.page === page, let h = handleRect(for: sel), h.contains(vp) {
                mode = .resize
                originalBounds = [(sel, sel.bounds)]
            } else if let hit = hitAnnotation(page, pp, includeForms: withForms) {
                selectAnnotation(hit)
                if event.clickCount == 2 { editContents(of: hit); return }
                mode = .move
                originalBounds = groupMembers(of: hit).map { ($0, $0.bounds) }
            } else {
                selectAnnotation(nil)
                mode = .passthrough
                super.mouseDown(with: event)
            }
        case .hand:
            mode = .pan
            panLast = event.locationInWindow
            panSamples = [(event.timestamp, event.locationInWindow)]
            NSCursor.closedHand.set()
        case .highlight, .underline, .strikeout:
            mode = .passthrough
            super.mouseDown(with: event)
            applyMarkupIfNeeded()
        case .note: createNote(on: page, at: pp)
        case .editText: editExistingText(on: page, at: pp)
        case .image: placeImage(on: page, at: pp)
        case .signature: chooseSignature(on: page, at: pp, event: event)
        case .stamp: chooseStamp(on: page, at: pp, event: event)
        case .eraser:
            if let hit = hitAnnotation(page, pp, includeForms: true) { removeWithGroup(hit) }
        case .measurePerimeter, .measureArea:
            addMeasurePoint(pp, on: page, finish: event.clickCount >= 2, constrain: event.modifierFlags.contains(.shift))
        default:
            mode = .create
            dragStart = pp
            dragCurrent = pp
            inkPoints = [pp]
        }
    }

    override func mouseDragged(with event: NSEvent) {
        switch mode {
        case .passthrough:
            super.mouseDragged(with: event)
        case .pan:
            guard let clip = documentView?.enclosingScrollView?.contentView else { return }
            let p = event.locationInWindow
            var origin = clip.bounds.origin
            origin.x -= p.x - panLast.x
            // 手を上に動かしたら文書も上へ（下の部分が見えてくる）。flipped のクリップでは y が下向き
            origin.y += (clip.isFlipped ? 1 : -1) * (p.y - panLast.y)
            panLast = p
            panSamples.append((event.timestamp, p))
            panSamples.removeAll { event.timestamp - $0.t > 0.1 }
            clip.scroll(to: origin)
            documentView?.enclosingScrollView?.reflectScrolledClipView(clip)
        case .vertex:
            guard var e = vertexEdit, let page = e.shape.page else { return }
            var pts = e.before
            var pp = convert(convert(event.locationInWindow, from: nil), to: page)
            // Shift：となりの頂点から 45° 単位
            if event.modifierFlags.contains(.shift), pts.count > 1 {
                let ref = pts[e.index == 0 ? 1 : e.index - 1]
                pp = Self.snap45(from: ref, to: pp)
            }
            pts[e.index] = pp
            Measure.apply(kind: e.data.kind, points: pts, scale: e.data.scale, shape: e.shape, label: e.label)
            annotationsChanged(on: page)
            e.data = Measure.data(of: e.shape) ?? e.data
            vertexEdit = e
            overlay.needsDisplay = true
        case .create, .move, .resize:
            guard let page = dragPage else { return }
            var pp = convert(convert(event.locationInWindow, from: nil), to: page)
            if mode == .create {
                if event.modifierFlags.contains(.shift) { pp = constrained(pp) }
                dragCurrent = pp
                if tool == .ink { inkPoints.append(pp) }
            } else if mode == .move {
                let dx = pp.x - lastPagePoint.x, dy = pp.y - lastPagePoint.y
                for (a, _) in originalBounds { a.bounds = a.bounds.offsetBy(dx: dx, dy: dy) }
                annotationsChanged(on: page)
            } else if let (a, o) = originalBounds.first {
                var w = max(6, pp.x - o.minX)
                var h = max(6, o.maxY - pp.y)
                if let ratio = ImageStamp.aspect(a) {
                    h = w * ratio
                } else if event.modifierFlags.contains(.shift) {
                    w = max(w, h); h = w
                }
                a.bounds = CGRect(x: o.minX, y: o.maxY - h, width: w, height: h)
                annotationsChanged(on: page)
            }
            lastPagePoint = pp
            overlay.needsDisplay = true
        case .none:
            break
        }
    }

    override func mouseUp(with event: NSEvent) {
        defer {
            mode = .none
            inkPoints = []
            overlay.needsDisplay = true
        }
        switch mode {
        case .passthrough:
            super.mouseUp(with: event)
            if tool.isMarkup { applyMarkupIfNeeded() }
        case .pan:
            NSCursor.openHand.set()
            startMomentumIfFlicked(at: event.timestamp)
        case .create:
            finishCreate()
        case .vertex:
            if let e = vertexEdit, let d = Measure.data(of: e.shape) {
                let after = Measure.absolute(d, origin: e.shape.bounds.origin)
                if after != e.before { registerMeasureChange(e.shape, e.label, from: (e.before, e.data.scale), to: (after, d.scale)) }
            }
            vertexEdit = nil
        case .move, .resize:
            let changed = originalBounds.filter { $0.0.bounds != $0.1 }
            if !changed.isEmpty {
                registerUndo(mode == .move ? "移動" : "サイズ変更") { [originals = changed] v in
                    v.applyBounds(originals, name: "移動")
                }
                NotificationCenter.default.post(name: .studioSelectionChanged, object: self)
            }
        case .none:
            break
        }
    }

    private func constrained(_ p: CGPoint) -> CGPoint {
        let dx = p.x - dragStart.x, dy = p.y - dragStart.y
        switch tool {
        case .line, .arrow, .measureDistance:
            let angle = (atan2(dy, dx) / (.pi / 4)).rounded() * (.pi / 4)
            let len = hypot(dx, dy)
            return CGPoint(x: dragStart.x + cos(angle) * len, y: dragStart.y + sin(angle) * len)
        default:
            let s = max(abs(dx), abs(dy))
            return CGPoint(x: dragStart.x + (dx < 0 ? -s : s), y: dragStart.y + (dy < 0 ? -s : s))
        }
    }

    override func keyDown(with event: NSEvent) {
        stopMomentum()
        // 周長・面積の頂点を置いている途中
        if !measurePoints.isEmpty {
            switch event.keyCode {
            case 36, 76: finishMeasure(); return                                    // Enter
            case 51, 117: measurePoints.removeLast(); overlay.needsDisplay = true; return   // Backspace / Delete
            case 53: measurePoints = []; overlay.needsDisplay = true; return       // Esc
            default: break
            }
        }
        if event.keyCode == 53, calibrating != nil {
            calibrating = nil
            tool = .select
            return
        }
        // テンキーの ＋ と － で拡大・縮小（⌘ を押していても同じ）
        if event.modifierFlags.contains(.numericPad), event.modifierFlags.intersection([.control, .option]).isEmpty {
            if event.keyCode == 69 { zoomIn(nil); return }   // テンキーの +
            if event.keyCode == 78 { zoomOut(nil); return }  // テンキーの -
        }
        if let sel = selectedAnnotation {
            switch event.keyCode {
            case 51, 117:
                removeWithGroup(sel)
                return
            case 53:
                selectAnnotation(nil)
                return
            case 123, 124, 125, 126:
                let step: CGFloat = event.modifierFlags.contains(.shift) ? 10 : 1
                let d: CGPoint = [123: CGPoint(x: -step, y: 0), 124: CGPoint(x: step, y: 0),
                                  125: CGPoint(x: 0, y: -step), 126: CGPoint(x: 0, y: step)][event.keyCode]!
                applyBounds(groupMembers(of: sel).map { ($0, $0.bounds.offsetBy(dx: d.x, dy: d.y)) }, name: "移動")
                return
            default: break
            }
        }
        if event.keyCode == 53, tool != .select {
            tool = .select
            return
        }
        // 修飾キーなしの 1 文字でツールを切り替える
        if event.modifierFlags.intersection([.command, .control, .option]).isEmpty,
           let ch = event.charactersIgnoringModifiers?.lowercased(),
           let t = Tool.allCases.first(where: { $0.keyEquivalent == ch }) {
            tool = t
            return
        }
        super.keyDown(with: event)
    }

    // MARK: - 測定

    static func snap45(from a: CGPoint, to p: CGPoint) -> CGPoint {
        let dx = p.x - a.x, dy = p.y - a.y
        let angle = (atan2(dy, dx) / (.pi / 4)).rounded() * (.pi / 4)
        let len = hypot(dx, dy)
        return CGPoint(x: a.x + cos(angle) * len, y: a.y + sin(angle) * len)
    }

    /// この文書の今の縮尺
    var measureScale: MeasureScale { studioDocument?.measureScale ?? .standard }

    private func addMeasure(kind: String, points: [CGPoint], on page: PDFPage) {
        let m = Measure.make(kind: kind, points: points, scale: measureScale, color: settings.strokeColor, lineWidth: max(1, settings.lineWidth))
        add(m.shape, to: page, name: "測定の追加")
        add(m.label, to: page, name: "測定の追加")
    }

    /// 周長・面積の頂点を足す（ダブルクリックで確定）
    private func addMeasurePoint(_ p: CGPoint, on page: PDFPage, finish: Bool, constrain: Bool) {
        if let mp = measurePage, mp !== page, !measurePoints.isEmpty { return }   // 別のページには続けない
        measurePage = page
        var q = p
        if constrain, let last = measurePoints.last { q = Self.snap45(from: last, to: p) }
        // ダブルクリックの 2 回目は同じ位置なので足さない
        if !(finish && measurePoints.last.map { hypot($0.x - q.x, $0.y - q.y) < 3 } == true) { measurePoints.append(q) }
        measureHover = nil
        overlay.needsDisplay = true
        if finish { finishMeasure() }
    }

    func finishMeasure() {
        guard let page = measurePage else { measurePoints = []; return }
        let kind = tool == .measureArea ? "area" : "perimeter"
        let need = kind == "area" ? 3 : 2
        guard measurePoints.count >= need else {
            if kind == "area" { Dialog.alert("面積は 3 点以上クリックしてから確定してください") }
            return
        }
        let pts = measurePoints
        measurePoints = []
        measureHover = nil
        addMeasure(kind: kind, points: pts, on: page)
        overlay.needsDisplay = true
    }

    /// 選択中の測定の頂点に当たっているか
    private func measureVertexHit(_ sel: PDFAnnotation, _ vp: CGPoint) -> (PDFAnnotation, PDFAnnotation, Int)? {
        let members = groupMembers(of: sel)
        guard let shape = Measure.shape(in: members), let label = Measure.label(in: members), let page = shape.page, let d = Measure.data(of: shape) else { return nil }
        for (i, p) in Measure.absolute(d, origin: shape.bounds.origin).enumerated() {
            let c = convert(p, from: page)
            if hypot(c.x - vp.x, c.y - vp.y) <= 7 { return (shape, label, i) }
        }
        return nil
    }

    /// 測定の頂点・縮尺の変更を取り消せるようにする
    func registerMeasureChange(_ shape: PDFAnnotation, _ label: PDFAnnotation, from: ([CGPoint], MeasureScale), to: ([CGPoint], MeasureScale), name: String = "測定の調整") {
        registerUndo(name) { v in
            guard let d = Measure.data(of: shape) else { return }
            Measure.apply(kind: d.kind, points: from.0, scale: from.1, shape: shape, label: label)
            if let p = shape.page { v.annotationsChanged(on: p) }
            v.registerMeasureChange(shape, label, from: to, to: from, name: name)
            v.overlay.needsDisplay = true
        }
    }

    /// 入力中の値を、マウスの近くに表示する
    private func drawMeasurePreview(kind: String, _ pts: [CGPoint], page: PDFPage, in v: NSView) {
        guard pts.count >= 2 else { return }
        let text = Measure.value(kind: kind, points: pts, scale: measureScale).text
        let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.boldSystemFont(ofSize: 12), .foregroundColor: NSColor.white]
        let size = (text as NSString).size(withAttributes: attrs)
        let c = v.convert(convert(pts.last!, from: page), from: self)
        let r = NSRect(x: c.x + 10, y: c.y + 10, width: size.width + 10, height: size.height + 4)
        NSColor.black.withAlphaComponent(0.7).setFill()
        NSBezierPath(roundedRect: r, xRadius: 4, yRadius: 4).fill()
        (text as NSString).draw(at: NSPoint(x: r.minX + 5, y: r.minY + 2), withAttributes: attrs)
    }

    /// 縮尺を変える（all = true なら、この文書の既存の測定も）。変えた測定の数を返す
    @discardableResult
    func setMeasureScale(_ scale: MeasureScale, all: Bool) -> Int {
        let previous = measureScale
        studioDocument?.measureScale = scale
        guard all, let doc = document else { return 0 }
        var changed = 0
        var undoItems: [(PDFAnnotation, PDFAnnotation, [CGPoint], MeasureScale)] = []
        for i in 0..<doc.pageCount {
            guard let page = doc.page(at: i) else { continue }
            var seen = Set<String>()
            for a in page.annotations {
                guard let g = Measure.group(of: a), !seen.contains(g), Measure.data(of: a) != nil else { continue }
                seen.insert(g)
                let members = page.annotations.filter { $0.userName == g }
                guard let shape = Measure.shape(in: members), let label = Measure.label(in: members), let d = Measure.data(of: shape), d.scale != scale else { continue }
                undoItems.append((shape, label, Measure.absolute(d, origin: shape.bounds.origin), d.scale))
                Measure.rescale(shape: shape, label: label, to: scale)
                annotationsChanged(on: page)
                changed += 1
            }
        }
        if changed > 0 {
            registerUndo("測定の縮尺") { v in v.undoMeasureScale(undoItems, docScale: previous, redoScale: scale) }
        }
        return changed
    }

    /// 縮尺の変更を取り消す（やり直しも登録する）
    private func undoMeasureScale(_ items: [(PDFAnnotation, PDFAnnotation, [CGPoint], MeasureScale)], docScale: MeasureScale, redoScale: MeasureScale) {
        var redo: [(PDFAnnotation, PDFAnnotation, [CGPoint], MeasureScale)] = []
        for (s, l, pts, sc) in items {
            guard let d = Measure.data(of: s) else { continue }
            redo.append((s, l, Measure.absolute(d, origin: s.bounds.origin), d.scale))
            Measure.apply(kind: d.kind, points: pts, scale: sc, shape: s, label: l)
            if let p = s.page { annotationsChanged(on: p) }
        }
        let current = measureScale
        studioDocument?.measureScale = docScale
        registerUndo("測定の縮尺") { v in v.undoMeasureScale(redo, docScale: current, redoScale: docScale) }
    }

    // MARK: - 慣性スクロール

    private var scrollClip: NSClipView? { documentView?.enclosingScrollView?.contentView }

    /// 離したときの速さ（ポイント/秒、画面の向き）。離す直前に止めていたら 0
    func panVelocity(at time: TimeInterval) -> CGPoint {
        guard let last = panSamples.last, time - last.t < 0.06, let first = panSamples.first, last.t - first.t > 0.005 else { return .zero }
        let dt = CGFloat(last.t - first.t)
        return CGPoint(x: (last.p.x - first.p.x) / dt, y: (last.p.y - first.p.y) / dt)
    }

    private func startMomentumIfFlicked(at time: TimeInterval) {
        var v = panVelocity(at: time)
        panSamples = []
        let speed = hypot(v.x, v.y)
        guard speed > Self.momentumStart else { return }
        if speed > Self.momentumMax { v = CGPoint(x: v.x * Self.momentumMax / speed, y: v.y * Self.momentumMax / speed) }
        startMomentum(velocity: v)
    }

    /// 払った速さで滑らせる（v はウィンドウ座標でのマウスの速さ）
    func startMomentum(velocity v: CGPoint) {
        stopMomentum()
        guard let clip = scrollClip else { return }
        let timer = Timer(timeInterval: 1.0 / 120, repeats: true) { [weak self] _ in self?.momentumTick() }
        RunLoop.main.add(timer, forMode: .common)
        momentum = (timer, v, ProcessInfo.processInfo.systemUptime, clip.bounds.origin)
    }

    func stopMomentum() {
        momentum?.timer.invalidate()
        momentum = nil
    }

    var isGliding: Bool { momentum != nil }

    private func momentumTick() {
        guard var m = momentum, let clip = scrollClip else { stopMomentum(); return }
        // ほかの操作（ページ移動・拡大縮小など）で位置が変わっていたら止める
        if abs(clip.bounds.origin.x - m.origin.x) > 0.5 || abs(clip.bounds.origin.y - m.origin.y) > 0.5 {
            stopMomentum(); return
        }
        let now = ProcessInfo.processInfo.systemUptime
        let dt = min(0.05, max(0, now - m.last))
        m.last = now
        var origin = clip.bounds.origin
        origin.x -= m.v.x * CGFloat(dt)
        origin.y += (clip.isFlipped ? 1 : -1) * m.v.y * CGFloat(dt)
        // 端に着いたら止める
        if let doc = documentView {
            let maxX = max(0, doc.frame.width - clip.bounds.width), maxY = max(0, doc.frame.height - clip.bounds.height)
            let cx = min(max(origin.x, 0), maxX), cy = min(max(origin.y, 0), maxY)
            if cx != origin.x { m.v.x = 0 }
            if cy != origin.y { m.v.y = 0 }
            origin = CGPoint(x: cx, y: cy)
        }
        clip.scroll(to: origin)
        documentView?.enclosingScrollView?.reflectScrolledClipView(clip)
        m.origin = clip.bounds.origin
        let decay = CGFloat(exp(-dt / Self.momentumTau))
        m.v = CGPoint(x: m.v.x * decay, y: m.v.y * decay)
        momentum = m
        if hypot(m.v.x, m.v.y) < 20 { stopMomentum() }
    }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        if grid != nil || wantsGrid { DispatchQueue.main.async { [weak self] in self?.updateGrid() } }
    }

    override func scrollWheel(with event: NSEvent) {
        stopMomentum()
        super.scrollWheel(with: event)
    }

    @objc func delete(_ sender: Any?) {
        if let sel = selectedAnnotation { removeWithGroup(sel) }
    }

    override func mouseMoved(with event: NSEvent) {
        super.mouseMoved(with: event)
        if tool.isPolyMeasure, !measurePoints.isEmpty, let page = measurePage {
            var p = convert(convert(event.locationInWindow, from: nil), to: page)
            if event.modifierFlags.contains(.shift), let last = measurePoints.last { p = Self.snap45(from: last, to: p) }
            measureHover = p
            overlay.needsDisplay = true
        }
        switch tool {
        case .select:
            if let sel = selectedAnnotation, let h = handleRect(for: sel),
               h.contains(convert(event.locationInWindow, from: nil)) {
                NSCursor.crosshair.set()
            }
        case .hand: NSCursor.openHand.set()
        case .editText, .highlight, .underline, .strikeout: NSCursor.iBeam.set()
        case .eraser: NSCursor.pointingHand.set()
        default: NSCursor.crosshair.set()
        }
    }

    override func menu(for event: NSEvent) -> NSMenu? {
        let vp = convert(event.locationInWindow, from: nil)
        guard let page = page(for: vp, nearest: false) else { return super.menu(for: event) }
        let pp = convert(vp, to: page)
        if let hit = hitAnnotation(page, pp, includeForms: true) {
            selectAnnotation(hit)
            let m = NSMenu()
            menuTargets = []
            func item(_ t: String, _ b: @escaping () -> Void) {
                let ct = ClosureTarget(b)
                menuTargets.append(ct)
                let i = NSMenuItem(title: t, action: #selector(ClosureTarget.fire), keyEquivalent: "")
                i.target = ct
                m.addItem(i)
            }
            item("\(hit.studioKindName)を編集…") { [weak self] in self?.editContents(of: hit) }
            item("最前面へ") { [weak self] in
                hit.page?.removeAnnotation(hit); page.addAnnotation(hit); self?.annotationsChanged(on: page)
            }
            m.addItem(.separator())
            item("削除") { [weak self] in self?.removeWithGroup(hit) }
            return m
        }
        let m = super.menu(for: event) ?? NSMenu()
        m.addItem(.separator())
        let ct = ClosureTarget { [weak self] in self?.createNote(on: page, at: pp) }
        menuTargets = [ct]
        let i = NSMenuItem(title: "ここに付箋を追加", action: #selector(ClosureTarget.fire), keyEquivalent: "")
        i.target = ct
        m.addItem(i)
        return m
    }

    // MARK: - 作成処理

    private func border(_ w: CGFloat) -> PDFBorder {
        let b = PDFBorder()
        b.lineWidth = w
        return b
    }

    private func finishCreate() {
        guard let page = dragPage else { return }
        let r = CGRect.spanning(dragStart, dragCurrent)
        let small = r.width < 5 && r.height < 5
        let s = settings

        switch tool {
        case .ink:
            guard inkPoints.count > 1 else { return }
            let xs = inkPoints.map(\.x), ys = inkPoints.map(\.y)
            let pad = s.lineWidth + 2
            let b = CGRect(x: xs.min()! - pad, y: ys.min()! - pad,
                           width: xs.max()! - xs.min()! + pad * 2, height: ys.max()! - ys.min()! + pad * 2)
            let path = NSBezierPath()
            path.move(to: CGPoint(x: inkPoints[0].x - b.minX, y: inkPoints[0].y - b.minY))
            for p in inkPoints.dropFirst() { path.line(to: CGPoint(x: p.x - b.minX, y: p.y - b.minY)) }
            path.lineWidth = s.lineWidth
            path.lineCapStyle = .round
            path.lineJoinStyle = .round
            let a = PDFAnnotation(bounds: b, forType: .ink, withProperties: nil)
            a.color = s.stroke()
            a.border = border(s.lineWidth)
            a.add(path)
            add(a, to: page)

        case .rect, .ellipse:
            let b = small ? CGRect(x: dragStart.x, y: dragStart.y - 60, width: 100, height: 60) : r
            let a = PDFAnnotation(bounds: b, forType: tool == .rect ? .square : .circle, withProperties: nil)
            a.color = s.stroke()
            a.interiorColor = s.fill()
            a.border = border(s.lineWidth)
            add(a, to: page, select: small)

        case .line, .arrow:
            guard hypot(r.width, r.height) > 4 else { return }
            let pad = max(s.lineWidth * 4, 8)
            let b = r.insetBy(dx: -pad, dy: -pad)
            let a = PDFAnnotation(bounds: b, forType: .line, withProperties: nil)
            a.startPoint = CGPoint(x: dragStart.x - b.minX, y: dragStart.y - b.minY)
            a.endPoint = CGPoint(x: dragCurrent.x - b.minX, y: dragCurrent.y - b.minY)
            if tool == .arrow { a.endLineStyle = .closedArrow }
            a.color = s.stroke()
            a.interiorColor = s.stroke()
            a.border = border(s.lineWidth)
            add(a, to: page)

        case .text:
            guard let text = Dialog.text("テキストボックス", message: "入力した文字を配置します。"), !text.isEmpty else { return }
            let font = s.font
            let width: CGFloat
            if small {
                let lines = text.components(separatedBy: .newlines)
                width = min(420, (lines.map { ($0 as NSString).size(withAttributes: [.font: font]).width }.max() ?? 100) + 14)
            } else {
                width = r.width
            }
            let h = textHeight(text, font: font, width: width)
            let top = small ? dragStart.y : r.maxY
            let b = CGRect(x: small ? dragStart.x : r.minX, y: top - max(h, small ? 0 : r.height), width: width, height: max(h, small ? h : r.height))
            let a = PDFAnnotation(bounds: b, forType: .freeText, withProperties: nil)
            a.contents = text
            a.font = font
            a.fontColor = s.textColor.withAlphaComponent(s.opacity)
            a.color = s.fill() ?? .clear
            a.border = border(0)
            add(a, to: page, select: true)
            tool = .select

        case .measureDistance:
            guard hypot(dragCurrent.x - dragStart.x, dragCurrent.y - dragStart.y) > 2 else { return }
            if let cal = calibrating {
                calibrating = nil
                tool = .select
                cal(hypot(dragCurrent.x - dragStart.x, dragCurrent.y - dragStart.y))
                return
            }
            addMeasure(kind: "distance", points: [dragStart, dragCurrent], on: page)

        case .redact:
            guard !small else { return }
            add(makeRedactionMark(r), to: page, name: "墨消しのマーク")

        case .crop:
            guard !small else { return }
            cropPages(to: r, from: page)

        case .link:
            guard !small else { return }
            createLink(r, on: page)

        case .formText, .formCheckbox, .formChoice:
            createFormField(small ? nil : r, on: page)

        default:
            break
        }
    }

    func makeRedactionMark(_ r: CGRect) -> PDFAnnotation {
        let a = PDFAnnotation(bounds: r, forType: .square, withProperties: nil)
        a.color = NSColor.systemRed
        a.interiorColor = NSColor.black.withAlphaComponent(0.35)
        a.border = border(1.5)
        a.userName = AnnotationMarker.redaction
        a.contents = "墨消し予定（「文書 > 墨消しを適用」で確定）"
        return a
    }

    private func textHeight(_ text: String, font: NSFont, width: CGFloat) -> CGFloat {
        let r = (text as NSString).boundingRect(with: NSSize(width: max(10, width - 8), height: 100000),
                                                 options: [.usesLineFragmentOrigin, .usesFontLeading],
                                                 attributes: [.font: font])
        return ceil(r.height) + 8
    }

    private func createNote(on page: PDFPage, at p: CGPoint) {
        guard let text = Dialog.text("付箋（ノート）", message: "コメントを入力してください。"), !text.isEmpty else { return }
        let a = PDFAnnotation(bounds: CGRect(x: p.x - 10, y: p.y - 10, width: 22, height: 22), forType: .text, withProperties: nil)
        a.contents = text
        a.color = NSColor.systemYellow
        a.iconType = .comment
        a.userName = NSFullUserName()
        a.modificationDate = Date()
        add(a, to: page)
    }

    /// 選択範囲からハイライト・下線・取り消し線を作る
    private func applyMarkupIfNeeded() {
        guard tool.isMarkup, let sel = currentSelection,
              !(sel.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let subtype: PDFAnnotationSubtype = tool == .highlight ? .highlight : (tool == .underline ? .underline : .strikeOut)
        for line in sel.selectionsByLine() {
            for page in line.pages {
                let b = line.bounds(for: page)
                guard b.width > 0.5, b.height > 0.5 else { continue }
                let a = PDFAnnotation(bounds: b, forType: subtype, withProperties: nil)
                a.color = tool == .highlight ? settings.highlightColor.withAlphaComponent(0.5) : settings.stroke()
                a.quadrilateralPoints = [
                    NSValue(point: NSPoint(x: 0, y: b.height)), NSValue(point: NSPoint(x: b.width, y: b.height)),
                    NSValue(point: NSPoint(x: 0, y: 0)), NSValue(point: NSPoint(x: b.width, y: 0))
                ]
                a.contents = line.string
                add(a, to: page, name: tool.title)
            }
        }
        clearSelection()
    }

    /// 既存テキストの編集：行を白で覆い、新しい文字を同じ位置に置く
    private func editExistingText(on page: PDFPage, at p: CGPoint) {
        guard let line = page.selectionForLine(at: p),
              let raw = line.string?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else {
            NSSound.beep()
            return
        }
        let b = line.bounds(for: page)
        guard b.insetBy(dx: -4, dy: -4).contains(p) else { NSSound.beep(); return }

        var font = NSFont(name: settings.fontName, size: max(6, b.height * 0.8)) ?? NSFont.systemFont(ofSize: max(6, b.height * 0.8))
        var color = NSColor.black
        if let attr = line.attributedString, attr.length > 0 {
            let ns = attr.string as NSString
            var idx = 0
            while idx < ns.length, CharacterSet.whitespacesAndNewlines.contains(Unicode.Scalar(ns.character(at: idx)) ?? " ") { idx += 1 }
            idx = min(idx, attr.length - 1)
            if let f = attr.attribute(.font, at: idx, effectiveRange: nil) as? NSFont { font = f }
            if let c = attr.attribute(.foregroundColor, at: idx, effectiveRange: nil) as? NSColor { color = c }
        }
        guard let newText = Dialog.text("テキストを編集",
                                        message: "元の行は白で覆われ、新しい文字が同じ位置に配置されます。保存時に「注釈をフラット化」すると完全に置き換わります。",
                                        initial: raw, multiline: false),
              newText != raw else { return }

        let group = AnnotationMarker.editPrefix + UUID().uuidString
        let cover = PDFAnnotation(bounds: b.insetBy(dx: -1, dy: -1), forType: .square, withProperties: nil)
        cover.color = .white
        cover.interiorColor = .white
        cover.border = border(0)
        cover.userName = group

        let w = (newText as NSString).size(withAttributes: [.font: font]).width + 8
        let ft = PDFAnnotation(bounds: CGRect(x: b.minX - 2, y: b.minY - 2, width: max(b.width + 4, w), height: b.height + 4),
                               forType: .freeText, withProperties: nil)
        ft.font = font
        ft.fontColor = color
        ft.color = .clear
        ft.contents = newText
        ft.border = border(0)
        ft.userName = group
        add(cover, to: page, name: "テキスト編集")
        add(ft, to: page, select: true, name: "テキスト編集")
    }

    func editContents(of a: PDFAnnotation) {
        switch a.type ?? "" {
        case "FreeText", "Text", "Square", "Circle", "Highlight", "Underline", "StrikeOut", "Ink", "Line":
            guard let t = Dialog.text("\(a.studioKindName)の内容", initial: a.contents ?? "") else { return }
            let old = a.contents
            a.contents = t
            if a.type == "FreeText", let f = a.font {
                let h = textHeight(t, font: f, width: a.bounds.width)
                let top = a.bounds.maxY
                if h > a.bounds.height { a.bounds = CGRect(x: a.bounds.minX, y: top - h, width: a.bounds.width, height: h) }
            }
            if let p = a.page { annotationsChanged(on: p) }
            registerUndo("内容の変更") { v in
                a.contents = old
                if let p = a.page { v.annotationsChanged(on: p) }
            }
        case "Link":
            if let p = a.page { createLink(a.bounds, on: p, replacing: a) }
        default:
            NSSound.beep()
        }
    }

    // MARK: 画像・署名・スタンプ

    private func place(_ image: CGImage, width: CGFloat, on page: PDFPage, at p: CGPoint, name: String) {
        let w = min(width, page.bounds(for: .cropBox).width * 0.9)
        guard let a = ImageStamp.make(image: image, bounds: ImageStamp.rect(for: image, centeredAt: p, width: w), opacity: settings.opacity, name: name) else { NSSound.beep(); return }
        // フォームやページラベルのある文書では、保存でそれらが失われることを 1 度だけ知らせる
        if let doc = document, !warnedFormLoss, Compositor.hasFormOrPageLabels(doc) {
            warnedFormLoss = true
            Dialog.alert("フォーム・ページラベルについて", "この PDF にはフォームの欄またはページラベル（i, ii などのページ番号の表記）があります。画像・署名・スタンプを置いて保存すると、ほかのアプリでのフォームの入力やページラベルが使えなくなることがあります。気になる場合は、別名で保存してください。")
        }
        tool = .select
        add(a, to: page, select: true, name: name)
    }

    private func placeImage(on page: PDFPage, at p: CGPoint) {
        guard let url = Dialog.openFiles(types: [.image], multiple: false, title: "配置する画像を選んでください").first,
              let img = NSImage(contentsOf: url)?.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return }
        let natural = CGFloat(img.width) * 72 / 144
        place(img, width: min(natural, page.bounds(for: .cropBox).width * 0.4), on: page, at: p, name: "画像")
    }

    private func popup(_ items: [(String, NSImage?, () -> Void)], event: NSEvent) {
        let menu = NSMenu()
        menuTargets = []
        for (title, image, block) in items {
            if title == "-" { menu.addItem(.separator()); continue }
            let ct = ClosureTarget(block)
            menuTargets.append(ct)
            let it = NSMenuItem(title: title, action: #selector(ClosureTarget.fire), keyEquivalent: "")
            it.target = ct
            it.image = image
            menu.addItem(it)
        }
        menu.popUp(positioning: nil, at: convert(event.locationInWindow, from: nil), in: self)
    }

    private func chooseSignature(on page: PDFPage, at p: CGPoint, event: NSEvent) {
        var items: [(String, NSImage?, () -> Void)] = []
        for url in SignatureStore.all() {
            guard let img = SignatureStore.load(url) else { continue }
            let thumb = NSImage(cgImage: img, size: NSSize(width: 120, height: 120 * CGFloat(img.height) / CGFloat(max(1, img.width))))
            items.append(("", thumb, { [weak self] in self?.place(img, width: 150, on: page, at: p, name: "署名") }))
        }
        if !items.isEmpty { items.append(("-", nil, {})) }
        items.append(("新しい署名を作成…", nil, { [weak self] in
            if let img = SignaturePadView.runCreateDialog() { self?.place(img, width: 150, on: page, at: p, name: "署名") }
        }))
        items.append(("保存した署名を管理（Finderで開く）", nil, {
            NSWorkspace.shared.open(SignatureStore.directory)
        }))
        popup(items, event: event)
    }

    /// スタンプを選ぶメニュー（日本語・英語・印鑑・自分で作ったスタンプ）
    private func chooseStamp(on page: PDFPage, at p: CGPoint, event: NSEvent) {
        menuTargets = []
        let put = { [weak self] (img: CGImage?) in
            guard let img else { return }
            self?.place(img, width: CGFloat(img.width) / 4, on: page, at: p, name: "スタンプ")
        }
        func item(_ title: String, raw: Bool, image: NSImage? = nil, _ block: @escaping () -> Void) -> NSMenuItem {
            let ct = ClosureTarget(block)
            menuTargets.append(ct)
            // スタンプの文字（承認・APPROVED など）は押される文字そのままなので訳さない
            let it = raw ? I18n.raw { NSMenuItem(title: title, action: #selector(ClosureTarget.fire), keyEquivalent: "") }
                         : NSMenuItem(title: title, action: #selector(ClosureTarget.fire), keyEquivalent: "")
            it.target = ct
            it.image = image
            return it
        }
        let menu = NSMenu()
        for kind in StampKind.allCases where kind != .hanko && kind != .dateHanko {
            menu.addItem(item(kind.title, raw: true, image: CustomStamps.preview(StampRenderer.make(kind))) { put(StampRenderer.make(kind)) })
        }
        let en = NSMenuItem(title: "英語のスタンプ", action: nil, keyEquivalent: "")
        let em = NSMenu(title: "英語のスタンプ")
        for (text, color, date) in CustomStamps.english {
            em.addItem(item(text, raw: true, image: CustomStamps.preview(StampRenderer.textStamp(text, color: color, withDate: date))) {
                put(StampRenderer.textStamp(text, color: color, withDate: date))
            })
        }
        en.submenu = em
        menu.addItem(en)
        menu.addItem(.separator())
        menu.addItem(item(StampKind.hanko.title, raw: false) { put(StampRenderer.make(.hanko)) })
        menu.addItem(item(StampKind.dateHanko.title, raw: false) { put(StampRenderer.make(.dateHanko)) })
        menu.addItem(.separator())
        // 自分で作ったスタンプ
        let custom = CustomStamps.all()
        for c in custom {
            let title = c.kind == "image" ? (c.name ?? L("画像")) : (c.text ?? "")
            menu.addItem(item(title, raw: true, image: CustomStamps.preview(CustomStamps.image(c))) { put(CustomStamps.image(c)) })
        }
        menu.addItem(item("文字スタンプを作成…", raw: false) {
            guard let c = CustomStamps.createText() else { return }
            CustomStamps.add(c)
            put(CustomStamps.image(c))
        })
        menu.addItem(item("画像からスタンプを作成…", raw: false) {
            guard let c = CustomStamps.createImage() else { return }
            CustomStamps.add(c)
            put(CustomStamps.image(c))
        })
        if !custom.isEmpty {
            let del = NSMenuItem(title: "作ったスタンプを削除", action: nil, keyEquivalent: "")
            let dm = NSMenu(title: "作ったスタンプを削除")
            for c in custom {
                let title = c.kind == "image" ? (c.name ?? L("画像")) : (c.text ?? "")
                dm.addItem(item(title, raw: true, image: CustomStamps.preview(CustomStamps.image(c))) { CustomStamps.remove(c) })
            }
            del.submenu = dm
            menu.addItem(del)
        }
        menu.popUp(positioning: nil, at: convert(event.locationInWindow, from: nil), in: self)
    }

    // MARK: リンク・フォーム・トリミング

    private func createLink(_ r: CGRect, on page: PDFPage, replacing old: PDFAnnotation? = nil) {
        var initial = ""
        if let u = (old?.action as? PDFActionURL)?.url { initial = u.absoluteString }
        if let d = (old?.action as? PDFActionGoTo)?.destination, let dp = d.page, let i = document?.index(for: dp) { initial = String(i + 1) }
        guard let target = Dialog.text("リンク先", message: "URL（https://…）またはページ番号を入力してください。", initial: initial, multiline: false)?
            .trimmingCharacters(in: .whitespaces), !target.isEmpty else { return }
        let a = PDFAnnotation(bounds: r, forType: .link, withProperties: nil)
        if let n = Int(target), let doc = document, n >= 1, n <= doc.pageCount, let dest = doc.page(at: n - 1) {
            let top = dest.bounds(for: .cropBox).maxY
            a.action = PDFActionGoTo(destination: PDFDestination(page: dest, at: CGPoint(x: 0, y: top)))
        } else if let url = URL(string: target.contains("://") || target.hasPrefix("mailto:") ? target : "https://" + target) {
            a.action = PDFActionURL(url: url)
        } else {
            return
        }
        a.border = border(0)
        if let old { remove(old) }
        add(a, to: page, name: "リンク")
    }

    private func createFormField(_ r: CGRect?, on page: PDFPage) {
        let count = (document.map { d in (0..<d.pageCount).reduce(0) { $0 + (d.page(at: $1)?.annotations.filter { $0.type == "Widget" }.count ?? 0) } } ?? 0) + 1
        let f = FormBuilder()
        let name = f.text("フィールド名", "field\(count)", width: 200)
        var choices: NSTextField?
        if tool == .formChoice { choices = f.text("選択肢（カンマ区切り）", "はい,いいえ", width: 200) }
        guard f.run(title: tool.title) else { return }

        let w: PDFAnnotation
        switch tool {
        case .formCheckbox:
            let b = r ?? CGRect(x: dragStart.x, y: dragStart.y - 16, width: 16, height: 16)
            w = PDFAnnotation(bounds: b, forType: .widget, withProperties: nil)
            w.widgetFieldType = .button
            w.widgetControlType = .checkBoxControl
            w.buttonWidgetState = .offState
        case .formChoice:
            let b = r ?? CGRect(x: dragStart.x, y: dragStart.y - 22, width: 160, height: 22)
            w = PDFAnnotation(bounds: b, forType: .widget, withProperties: nil)
            w.widgetFieldType = .choice
            w.isListChoice = false
            let opts = (choices?.stringValue ?? "").split(whereSeparator: { $0 == "," || $0 == "、" })
                .map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
            w.choices = opts
            w.widgetStringValue = opts.first ?? ""
        default:
            let b = r ?? CGRect(x: dragStart.x, y: dragStart.y - 22, width: 180, height: 22)
            w = PDFAnnotation(bounds: b, forType: .widget, withProperties: nil)
            w.widgetFieldType = .text
            w.isMultiline = b.height > 40
        }
        w.fieldName = name.stringValue.isEmpty ? "field\(count)" : name.stringValue
        w.font = NSFont(name: "HiraginoSans-W3", size: 12) ?? NSFont.systemFont(ofSize: 12)
        w.fontColor = .black
        w.backgroundColor = NSColor(calibratedRed: 0.88, green: 0.93, blue: 1, alpha: 1)
        w.color = NSColor.gray
        w.border = border(1)
        add(w, to: page, name: "フォームフィールド")
    }

    private func cropPages(to r: CGRect, from page: PDFPage) {
        guard let doc = document, let studio = studioDocument else { return }
        let a = NSAlert()
        a.messageText = "トリミング"
        a.informativeText = "選択した範囲で表示領域（CropBox）を切り詰めます。"
        a.addButton(withTitle: "このページ")
        a.addButton(withTitle: "すべてのページ")
        a.addButton(withTitle: "キャンセル")
        let res = a.runModal()
        guard res != .alertThirdButtonReturn else { return }
        let all = res == .alertSecondButtonReturn
        let pageIndex = doc.index(for: page)
        studio.performStructuralChange("トリミング") { pdf in
            let targets = all ? Array(0..<pdf.pageCount) : [pageIndex]
            for i in targets {
                guard let p = pdf.page(at: i) else { continue }
                let media = p.bounds(for: .mediaBox)
                let c = r.intersection(media)
                if !c.isEmpty { p.setBounds(c, for: .cropBox) }
            }
        }
        tool = .select
    }

    // MARK: - オーバーレイ描画

    fileprivate func drawOverlay(in v: NSView) {
        func toOverlay(_ r: CGRect, _ page: PDFPage) -> CGRect { v.convert(convert(r, from: page), from: self) }
        func toOverlay(_ p: CGPoint, _ page: PDFPage) -> CGPoint { v.convert(convert(p, from: page), from: self) }

        if let sel = selectedAnnotation, let page = sel.page, document?.index(for: page) != NSNotFound {
            let accent = NSColor.controlAccentColor
            for m in groupMembers(of: sel) {
                let r = toOverlay(m.bounds, page).insetBy(dx: -2, dy: -2)
                let path = NSBezierPath(rect: r)
                path.lineWidth = 1
                path.setLineDash([4, 3], count: 2, phase: 0)
                accent.setStroke()
                path.stroke()
            }
            if let h = handleRect(for: sel) {
                let hr = v.convert(h, from: self)
                NSColor.white.setFill()
                NSBezierPath(rect: hr).fill()
                accent.setStroke()
                NSBezierPath(rect: hr).stroke()
            }
        }

        // 選択中の測定の頂点（ドラッグで調整できる）
        if let sel = selectedAnnotation, let page = sel.page, let shape = Measure.shape(in: groupMembers(of: sel)), let d = Measure.data(of: shape) {
            for p in Measure.absolute(d, origin: shape.bounds.origin) {
                let c = toOverlay(p, page)
                let r = NSRect(x: c.x - 4, y: c.y - 4, width: 8, height: 8)
                NSColor.white.setFill()
                NSBezierPath(ovalIn: r).fill()
                NSColor.controlAccentColor.setStroke()
                NSBezierPath(ovalIn: r).stroke()
            }
        }
        // 周長・面積の入力中
        if tool.isPolyMeasure, let page = measurePage, !measurePoints.isEmpty {
            var pts = measurePoints
            if let h = measureHover { pts.append(h) }
            let path = NSBezierPath()
            path.move(to: toOverlay(pts[0], page))
            for p in pts.dropFirst() { path.line(to: toOverlay(p, page)) }
            if tool == .measureArea, pts.count > 2 { path.close() }
            path.lineWidth = max(1, settings.lineWidth * scaleFactor)
            settings.stroke().setStroke()
            path.stroke()
            for p in measurePoints {
                let c = toOverlay(p, page)
                settings.stroke().setFill()
                NSBezierPath(ovalIn: NSRect(x: c.x - 3, y: c.y - 3, width: 6, height: 6)).fill()
            }
            drawMeasurePreview(kind: tool == .measureArea ? "area" : "perimeter", pts, page: page, in: v)
        }

        guard mode == .create, let page = dragPage else { return }
        let scale = scaleFactor
        if tool == .measureDistance {
            let path = NSBezierPath()
            path.move(to: toOverlay(dragStart, page))
            path.line(to: toOverlay(dragCurrent, page))
            path.lineWidth = max(1, settings.lineWidth * scale)
            (calibrating != nil ? NSColor.systemBlue : settings.stroke()).setStroke()
            path.stroke()
            if calibrating == nil { drawMeasurePreview(kind: "distance", [dragStart, dragCurrent], page: page, in: v) }
            return
        }
        if tool == .ink {
            guard let first = inkPoints.first else { return }
            let path = NSBezierPath()
            path.move(to: toOverlay(first, page))
            for p in inkPoints.dropFirst() { path.line(to: toOverlay(p, page)) }
            path.lineWidth = settings.lineWidth * scale
            path.lineCapStyle = .round
            path.lineJoinStyle = .round
            settings.stroke().setStroke()
            path.stroke()
            return
        }
        if tool == .line || tool == .arrow {
            let path = NSBezierPath()
            path.move(to: toOverlay(dragStart, page))
            path.line(to: toOverlay(dragCurrent, page))
            path.lineWidth = settings.lineWidth * scale
            settings.stroke().setStroke()
            path.stroke()
            return
        }
        let r = toOverlay(CGRect.spanning(dragStart, dragCurrent), page)
        let path = tool == .ellipse ? NSBezierPath(ovalIn: r) : NSBezierPath(rect: r)
        switch tool {
        case .rect, .ellipse:
            if let f = settings.fill() { f.setFill(); path.fill() }
            path.lineWidth = settings.lineWidth * scale
            settings.stroke().setStroke()
        case .redact:
            NSColor.black.withAlphaComponent(0.35).setFill()
            path.fill()
            NSColor.systemRed.setStroke()
        default:
            path.setLineDash([5, 3], count: 2, phase: 0)
            NSColor.controlAccentColor.setStroke()
        }
        path.stroke()
    }
}

/// PDFView の上に重ねて、ドラッグ中の図形や選択枠を描く透明ビュー
final class OverlayView: NSView {
    weak var editor: EditorPDFView?
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override func draw(_ dirtyRect: NSRect) { editor?.drawOverlay(in: self) }
}
