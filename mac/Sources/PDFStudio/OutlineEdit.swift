import AppKit
import PDFKit

/// しおりの編集（追加・削除・名前の変更・上下の並べ替え・1 段下げる／上げる）。どれも元に戻せる。
/// 元に戻すには、逆の操作だけを登録する（文書全体を書き出さない）。変更ありの印は取り消しの仕組みが付ける
enum OutlineEdit {
    /// しおりの置き場所（親と、親の中での順番）
    struct Place { let parent: PDFOutline; let index: Int }

    static func place(of o: PDFOutline) -> Place? {
        guard let parent = o.parent else { return nil }
        for i in 0..<parent.numberOfChildren where parent.child(at: i) === o { return Place(parent: parent, index: i) }
        return nil
    }

    private static func register(_ doc: PDFStudioDocument, _ name: String, _ undo: @escaping (PDFStudioDocument) -> Void) {
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
        register(doc, name) { d in relocate(o, to: from.parent, at: from.index, in: d, name: name) }
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
        register(doc, "しおりを追加") { d in remove(o, in: d) }
    }

    /// 削除する（取り消すと元の場所に戻る）
    static func remove(_ o: PDFOutline, in doc: PDFStudioDocument) {
        guard let p = place(of: o) else { return }
        o.removeFromParent()
        register(doc, "しおりを削除") { d in insert(o, into: p.parent, at: p.index, in: d) }
    }

    /// 名前を変える（取り消すと元の名前に戻る）
    static func rename(_ o: PDFOutline, to label: String, in doc: PDFStudioDocument) {
        let old = o.label ?? ""
        guard old != label else { return }
        o.label = label
        register(doc, "しおりの名前を変更") { d in rename(o, to: old, in: d) }
    }
}
