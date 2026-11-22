import AppKit
import PDFKit

/// しおりの編集（追加・削除・名前の変更・上下の並べ替え・1 段下げる／上げる）。どれも元に戻せる。
/// 元に戻すには、逆の操作だけを登録する（文書全体は書き出さない）。変更ありの印は取り消しの仕組みが付ける。
/// 取り消しは、しおりそのものではなく「上からの位置（番号の並び）」で覚え、そのときの文書からたどり直す
/// （ページの操作を取り消すと文書が入れ替わり、しおりも別のものになるため）
enum OutlineEdit {
    /// しおりの置き場所（親と、親の中での順番）
    struct Place { let parent: PDFOutline; let index: Int }

    static func place(of o: PDFOutline) -> Place? {
        guard let parent = o.parent else { return nil }
        for i in 0..<parent.numberOfChildren where parent.child(at: i) === o { return Place(parent: parent, index: i) }
        return nil
    }

    /// いちばん上のしおりからの番号の並び（いちばん上そのものは空）
    static func path(of o: PDFOutline) -> [Int]? {
        var path: [Int] = []
        var x = o
        while let p = place(of: x) { path.insert(p.index, at: 0); x = p.parent }
        return path
    }

    /// 番号の並びから、今の文書のしおりをたどる
    static func resolve(_ path: [Int], in doc: PDFStudioDocument) -> PDFOutline? {
        var x = doc.pdf.outlineRoot
        for i in path { guard let c = x, i < c.numberOfChildren else { return nil }; x = c.child(at: i) }
        return x
    }

    private static func register(_ doc: PDFStudioDocument, _ name: String, _ undo: @escaping (PDFStudioDocument) -> Void) {
        Compositor.markOutlineEdited(doc.pdf)
        guard let um = doc.undoManager else { doc.updateChangeCount(.changeDone); return }
        um.registerUndo(withTarget: doc) { d in
            undo(d)
            // 取り消し・やり直しのあと、しおりの欄を描き直す
            NotificationCenter.default.post(name: .studioOutlineChanged, object: d)
        }
        um.setActionName(L(name))
    }

    /// しおりを指定の場所へ移す（取り消すと元の場所へ戻る）
    @discardableResult
    static func relocate(_ o: PDFOutline, to parent: PDFOutline, at index: Int, in doc: PDFStudioDocument, name: String) -> Bool {
        guard let from = place(of: o), parent !== o, !isAncestor(o, of: parent) else { return false }
        o.removeFromParent()
        parent.insertChild(o, at: max(0, min(index, parent.numberOfChildren)))
        // 動かしたあとの位置で覚える（元の親は、動かしたあとも同じ位置にある）
        guard let now = path(of: o), let back = path(of: from.parent) else { return true }
        register(doc, name) { d in
            guard let x = resolve(now, in: d), let p = resolve(back, in: d) else { return }
            relocate(x, to: p, at: from.index, in: d, name: name)
        }
        return true
    }

    private static func isAncestor(_ a: PDFOutline, of b: PDFOutline) -> Bool {
        var p = b.parent
        while let x = p { if x === a { return true }; p = x.parent }
        return false
    }

    /// 上（-1）・下（+1）へ 1 つ動かす。端なら何もしない
    @discardableResult
    static func move(_ o: PDFOutline, by delta: Int, in doc: PDFStudioDocument) -> Bool {
        guard let p = place(of: o) else { return false }
        let to = p.index + delta
        guard to >= 0, to < p.parent.numberOfChildren else { return false }
        return relocate(o, to: p.parent, at: to, in: doc, name: delta < 0 ? "しおりを上へ" : "しおりを下へ")
    }

    /// 1 段下げる（1 つ上のしおりの子の最後にする）
    @discardableResult
    static func indent(_ o: PDFOutline, in doc: PDFStudioDocument) -> Bool {
        guard let p = place(of: o), p.index > 0, let prev = p.parent.child(at: p.index - 1) else { return false }
        return relocate(o, to: prev, at: prev.numberOfChildren, in: doc, name: "しおりを 1 段下げる")
    }

    /// 1 段上げる（親のすぐ後ろに置く）
    @discardableResult
    static func outdent(_ o: PDFOutline, in doc: PDFStudioDocument) -> Bool {
        guard let p = place(of: o), let gp = place(of: p.parent) else { return false }
        return relocate(o, to: gp.parent, at: gp.index + 1, in: doc, name: "しおりを 1 段上げる")
    }

    /// 追加する（取り消すと消える）
    static func insert(_ o: PDFOutline, into parent: PDFOutline, at index: Int, in doc: PDFStudioDocument) {
        parent.insertChild(o, at: max(0, min(index, parent.numberOfChildren)))
        guard let now = path(of: o) else { return }
        register(doc, "しおりを追加") { d in if let x = resolve(now, in: d) { remove(x, in: d) } }
    }

    /// しおりの中身を値として控えたもの（移動先はページの番号で持つ。文書が入れ替わっても作り直せる）
    struct Snapshot {
        let label: String?
        let page: Int?
        let point: CGPoint
        let zoom: CGFloat
        let isOpen: Bool
        let children: [Snapshot]

        init(_ o: PDFOutline, in doc: PDFDocument) {
            label = o.label
            let dest = o.destination ?? (o.action as? PDFActionGoTo)?.destination
            if let pg = dest?.page { let i = doc.index(for: pg); page = i == NSNotFound ? nil : i } else { page = nil }
            point = dest?.point ?? .zero
            zoom = dest?.zoom ?? kPDFDestinationUnspecifiedValue
            isOpen = o.isOpen
            children = (0..<o.numberOfChildren).compactMap { o.child(at: $0).map { Snapshot($0, in: doc) } }
        }

        func make(in doc: PDFDocument) -> PDFOutline {
            let o = PDFOutline()
            o.label = label
            if let page, let pg = doc.page(at: page) {
                let d = PDFDestination(page: pg, at: point)
                d.zoom = zoom
                o.destination = d
            }
            for (i, c) in children.enumerated() { o.insertChild(c.make(in: doc), at: i) }
            o.isOpen = isOpen
            return o
        }
    }

    /// 削除する（取り消すと元の場所に戻る。そのときの文書のページで作り直す）
    static func remove(_ o: PDFOutline, in doc: PDFStudioDocument) {
        guard let p = place(of: o), let parentPath = path(of: p.parent) else { return }
        let snap = Snapshot(o, in: doc.pdf)
        o.removeFromParent()
        register(doc, "しおりを削除") { d in if let parent = resolve(parentPath, in: d) { insert(snap.make(in: d.pdf), into: parent, at: p.index, in: d) } }
    }

    /// 名前を変える（取り消すと元の名前に戻る）
    static func rename(_ o: PDFOutline, to label: String, in doc: PDFStudioDocument) {
        let old = o.label ?? ""
        guard old != label, let now = path(of: o) else { o.label = label; Compositor.markOutlineEdited(doc.pdf); return }
        o.label = label
        register(doc, "しおりの名前を変更") { d in if let x = resolve(now, in: d) { rename(x, to: old, in: d) } }
    }
}
