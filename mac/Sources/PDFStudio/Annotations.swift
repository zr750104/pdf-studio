import AppKit
import PDFKit

/// 画像・署名・スタンプ用の注釈。編集中は注釈として移動/拡大でき、保存時にページへ焼き込む。
final class ImageStampAnnotation: PDFAnnotation {
    let image: CGImage
    var opacity: CGFloat = 1

    init(bounds: CGRect, image: CGImage) {
        self.image = image
        super.init(bounds: bounds, forType: .stamp, withProperties: nil)
    }

    required init?(coder: NSCoder) { nil }

    override func draw(with box: PDFDisplayBox, in context: CGContext) {
        drawBaked(in: context)
    }

    func drawBaked(in context: CGContext) {
        context.saveGState()
        context.setAlpha(opacity)
        context.interpolationQuality = .high
        context.draw(image, in: bounds)
        context.restoreGState()
    }

    /// 画像の縦横比を保ったまま幅を指定して配置用の矩形を作る
    static func rect(for image: CGImage, centeredAt p: CGPoint, width: CGFloat) -> CGRect {
        let ratio = CGFloat(image.height) / CGFloat(max(1, image.width))
        let h = width * ratio
        return CGRect(x: p.x - width / 2, y: p.y - h / 2, width: width, height: h)
    }
}

enum AnnotationMarker {
    static let redaction = "__PDFSTUDIO_REDACT__"
    static let editPrefix = "pdfstudio-edit:"

    static func isRedaction(_ a: PDFAnnotation) -> Bool { a.userName == redaction }
    static func editGroup(_ a: PDFAnnotation) -> String? {
        guard let u = a.userName, u.hasPrefix(editPrefix) else { return nil }
        return u
    }
}

extension PDFAnnotation {
    /// 表示用の種類名
    var studioKindName: String {
        if self is ImageStampAnnotation || ImageStamp.isImageStamp(self) { return "画像/スタンプ" }
        if AnnotationMarker.isRedaction(self) { return "墨消し（未適用）" }
        if AnnotationMarker.editGroup(self) != nil { return "テキスト編集" }
        if let d = Measure.data(of: self) { return Measure.kindName(d.kind) }
        if Measure.group(of: self) != nil { return "測定" }
        switch type ?? "" {
        case "Highlight": return "ハイライト"
        case "Underline": return "下線"
        case "StrikeOut": return "取り消し線"
        case "Text": return "付箋"
        case "FreeText": return "テキストボックス"
        case "Ink": return "手書き"
        case "Square": return "矩形"
        case "Circle": return "楕円"
        case "Line": return "線"
        case "Link": return "リンク"
        case "Widget": return "フォームフィールド"
        case "Stamp": return "スタンプ"
        case "Popup": return "ポップアップ"
        default: return type ?? "注釈"
        }
    }

    /// 移動・リサイズ可能か
    var isResizable: Bool {
        if Measure.group(of: self) != nil { return false }   // 測定は頂点で調整する
        switch type ?? "" {
        case "Ink", "Line", "Highlight", "Underline", "StrikeOut", "Text", "Popup": return false
        default: return true
        }
    }
}

// MARK: - スタンプ生成

enum StampKind: CaseIterable {
    case approved, checked, confidential, draft, rejected, internalOnly, received, urgent, hanko, dateHanko

    var title: String {
        switch self {
        case .approved: return "承認"
        case .checked: return "確認済"
        case .confidential: return "機密"
        case .draft: return "下書き"
        case .rejected: return "却下"
        case .internalOnly: return "社外秘"
        case .received: return "受領"
        case .urgent: return "至急"
        case .hanko: return "印鑑（氏名）…"
        case .dateHanko: return "日付印…"
        }
    }
}

enum StampRenderer {
    static let red = NSColor(calibratedRed: 0.84, green: 0.1, blue: 0.12, alpha: 1)
    static let blue = NSColor(calibratedRed: 0.1, green: 0.3, blue: 0.75, alpha: 1)

    static func dateString(_ d: Date = Date()) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "ja_JP")
        f.dateFormat = "yyyy.MM.dd"
        return f.string(from: d)
    }

    /// 枠付きの文字スタンプ（承認・機密など）
    static func textStamp(_ text: String, color: NSColor, withDate: Bool) -> CGImage? {
        textStamp(text, color: color, sub: withDate ? dateString() : "")
    }

    /// 枠付きの文字スタンプ。sub が空でなければ下段に入れる（日付・時刻・氏名など）
    static func textStamp(_ text: String, color: NSColor, sub: String) -> CGImage? {
        let font = NSFont(name: "HiraginoSans-W7", size: 28) ?? NSFont.boldSystemFont(ofSize: 28)
        let small = NSFont(name: "HiraginoSans-W6", size: 11) ?? NSFont.boldSystemFont(ofSize: 11)
        let withDate = !sub.isEmpty
        let dateText = sub
        let tw = (text as NSString).size(withAttributes: [.font: font]).width
        let dw = (dateText as NSString).size(withAttributes: [.font: small]).width
        let w = max(tw, dw, 70) + 36
        let h: CGFloat = withDate ? 66 : 50
        return Render.image(size: NSSize(width: w, height: h)) { r in
            color.setStroke()
            let outer = NSBezierPath(roundedRect: r.insetBy(dx: 3, dy: 3), xRadius: 8, yRadius: 8)
            outer.lineWidth = 3
            outer.stroke()
            let inner = NSBezierPath(roundedRect: r.insetBy(dx: 7, dy: 7), xRadius: 5, yRadius: 5)
            inner.lineWidth = 1
            inner.stroke()
            if withDate {
                Render.drawCentered(text, font: font, color: color, center: CGPoint(x: r.midX, y: r.maxY - 26))
                Render.drawCentered(dateText, font: small, color: color, center: CGPoint(x: r.midX, y: 18))
            } else {
                Render.drawCentered(text, font: font, color: color, center: CGPoint(x: r.midX, y: r.midY))
            }
        }
    }

    /// 丸印（氏名を縦書き）
    static func hanko(_ name: String) -> CGImage? {
        let chars = Array(name.prefix(4)).map(String.init)
        let size: CGFloat = 80
        let fontSize: CGFloat = [1: 40, 2: 27, 3: 19, 4: 15][max(1, chars.count)] ?? 15
        let font = NSFont(name: "HiraMinProN-W6", size: fontSize) ?? NSFont.boldSystemFont(ofSize: fontSize)
        return Render.image(size: NSSize(width: size, height: size)) { r in
            let circle = NSBezierPath(ovalIn: r.insetBy(dx: 3, dy: 3))
            circle.lineWidth = 3.5
            red.setStroke()
            circle.stroke()
            let lineH = fontSize * 1.08
            let total = lineH * CGFloat(chars.count)
            for (k, c) in chars.enumerated() {
                let cy = r.midY + total / 2 - lineH * (CGFloat(k) + 0.5)
                Render.drawCentered(c, font: font, color: red, center: CGPoint(x: r.midX, y: cy))
            }
        }
    }

    /// 日付印（上段: 部署、中段: 日付、下段: 氏名）
    static func dateHanko(top: String, name: String) -> CGImage? {
        let size: CGFloat = 90
        return Render.image(size: NSSize(width: size, height: size)) { r in
            red.setStroke()
            let circle = NSBezierPath(ovalIn: r.insetBy(dx: 3, dy: 3))
            circle.lineWidth = 3
            circle.stroke()
            let band: CGFloat = 12
            for dy in [band, -band] {
                let y = r.midY + dy
                let half = sqrt(max(0, pow(r.width / 2 - 3, 2) - pow(dy, 2)))
                let l = NSBezierPath()
                l.move(to: NSPoint(x: r.midX - half, y: y))
                l.line(to: NSPoint(x: r.midX + half, y: y))
                l.lineWidth = 1.5
                l.stroke()
            }
            let f = { (s: CGFloat) in NSFont(name: "HiraginoSans-W6", size: s) ?? NSFont.boldSystemFont(ofSize: s) }
            Render.drawCentered(top, font: f(12), color: red, center: CGPoint(x: r.midX, y: r.midY + band + 13))
            Render.drawCentered(dateString(), font: f(11), color: red, center: CGPoint(x: r.midX, y: r.midY))
            Render.drawCentered(name, font: f(15), color: red, center: CGPoint(x: r.midX, y: r.midY - band - 14))
        }
    }

    static func make(_ kind: StampKind) -> CGImage? {
        switch kind {
        case .approved: return textStamp("承認", color: red, withDate: true)
        case .checked: return textStamp("確認済", color: blue, withDate: true)
        case .confidential: return textStamp("機密", color: red, withDate: false)
        case .draft: return textStamp("下書き", color: blue, withDate: false)
        case .rejected: return textStamp("却下", color: red, withDate: true)
        case .internalOnly: return textStamp("社外秘", color: red, withDate: false)
        case .received: return textStamp("受領", color: blue, withDate: true)
        case .urgent: return textStamp("至急", color: red, withDate: false)
        case .hanko:
            let initial = UserDefaults.standard.string(forKey: CustomStamps.nameKey) ?? NSFullUserName().components(separatedBy: " ").first ?? ""
            guard let n = Dialog.text("印鑑に入れる氏名", initial: initial, multiline: false), !n.isEmpty else { return nil }
            UserDefaults.standard.set(n, forKey: CustomStamps.nameKey)
            return hanko(n)
        case .dateHanko:
            let f = FormBuilder()
            let top = f.text("上段（部署など）", UserDefaults.standard.string(forKey: "PDFStudioDateHankoTop") ?? L("総務部"), width: 160)
            let name = f.text("下段（氏名）", UserDefaults.standard.string(forKey: CustomStamps.nameKey) ?? "", width: 160)
            guard f.run(title: "日付印") else { return nil }
            UserDefaults.standard.set(top.stringValue, forKey: "PDFStudioDateHankoTop")
            if !name.stringValue.isEmpty { UserDefaults.standard.set(name.stringValue, forKey: CustomStamps.nameKey) }
            return dateHanko(top: top.stringValue, name: name.stringValue)
        }
    }
}

// MARK: - 署名の保存

enum SignatureStore {
    static var directory: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let dir = base.appendingPathComponent("PDFStudio/Signatures", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    static func all() -> [URL] {
        let urls = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.creationDateKey])) ?? []
        return urls.filter { $0.pathExtension.lowercased() == "png" }.sorted { $0.lastPathComponent < $1.lastPathComponent }
    }

    static func save(_ image: CGImage) -> URL? {
        let name = "signature-\(Int(Date().timeIntervalSince1970)).png"
        let url = directory.appendingPathComponent(name)
        guard let data = Render.pngData(image) else { return nil }
        do { try data.write(to: url); return url } catch { return nil }
    }

    static func load(_ url: URL) -> CGImage? {
        guard let img = NSImage(contentsOf: url) else { return nil }
        return img.cgImage(forProposedRect: nil, context: nil, hints: nil)
    }
}

/// 署名を手書き/文字入力で作るパッド
final class SignaturePadView: NSView {
    private var strokes: [[CGPoint]] = []

    override var isFlipped: Bool { false }
    var isEmpty: Bool { strokes.isEmpty }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.white.setFill()
        bounds.fill()
        NSColor.separatorColor.setStroke()
        let base = NSBezierPath()
        base.move(to: NSPoint(x: 20, y: 40))
        base.line(to: NSPoint(x: bounds.width - 20, y: 40))
        base.lineWidth = 1
        base.stroke()
        if strokes.isEmpty {
            let s = L("ここにマウス/トラックパッドで署名してください") as NSString
            s.draw(at: NSPoint(x: 24, y: 48), withAttributes: [.foregroundColor: NSColor.tertiaryLabelColor, .font: NSFont.systemFont(ofSize: 12)])
        }
        NSColor.black.setStroke()
        for s in strokes { Self.path(s).stroke() }
    }

    private static func path(_ pts: [CGPoint]) -> NSBezierPath {
        let p = NSBezierPath()
        p.lineWidth = 2.6
        p.lineCapStyle = .round
        p.lineJoinStyle = .round
        guard let f = pts.first else { return p }
        p.move(to: f)
        if pts.count == 1 { p.line(to: NSPoint(x: f.x + 0.5, y: f.y)) }
        for i in 1..<max(1, pts.count) where i < pts.count {
            let mid = NSPoint(x: (pts[i - 1].x + pts[i].x) / 2, y: (pts[i - 1].y + pts[i].y) / 2)
            p.curve(to: mid, controlPoint1: pts[i - 1], controlPoint2: pts[i - 1])
        }
        if let l = pts.last, pts.count > 1 { p.line(to: l) }
        return p
    }

    override func mouseDown(with event: NSEvent) {
        strokes.append([convert(event.locationInWindow, from: nil)])
        needsDisplay = true
    }

    override func mouseDragged(with event: NSEvent) {
        strokes[strokes.count - 1].append(convert(event.locationInWindow, from: nil))
        needsDisplay = true
    }

    func clear() { strokes.removeAll(); needsDisplay = true }

    /// 描いた線の範囲だけを切り出した透過画像
    func makeImage() -> CGImage? {
        let all = strokes.flatMap { $0 }
        guard !all.isEmpty else { return nil }
        let minX = all.map(\.x).min()! - 4, maxX = all.map(\.x).max()! + 4
        let minY = all.map(\.y).min()! - 4, maxY = all.map(\.y).max()! + 4
        let size = NSSize(width: max(10, maxX - minX), height: max(10, maxY - minY))
        return Render.image(size: size) { _ in
            let t = NSAffineTransform()
            t.translateX(by: -minX, yBy: -minY)
            t.concat()
            NSColor.black.setStroke()
            for s in self.strokes { Self.path(s).stroke() }
        }
    }

    static func typedSignature(_ text: String, fontName: String) -> CGImage? {
        let font = NSFont(name: fontName, size: 44) ?? NSFont.systemFont(ofSize: 44)
        let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor.black]
        let s = (text as NSString).size(withAttributes: attrs)
        return Render.image(size: NSSize(width: s.width + 8, height: s.height + 4)) { _ in
            (text as NSString).draw(at: NSPoint(x: 4, y: 2), withAttributes: attrs)
        }
    }

    /// 新しい署名を作るダイアログ。作成した画像を保存して返す。
    static func runCreateDialog() -> CGImage? {
        let pad = SignaturePadView(frame: NSRect(x: 0, y: 0, width: 420, height: 160))
        let clear = NSButton(title: "クリア", target: nil, action: nil)
        let typed = NSTextField(string: "")
        typed.placeholderString = "または文字で入力（例: 山田 太郎）"
        let fonts = ["SnellRoundhand", "HiraMinProN-W3", "HiraginoSans-W3", "Zapfino", "Bradley Hand"]
        let fontPopup = NSPopUpButton(frame: .zero, pullsDown: false)
        fontPopup.addItems(withTitles: ["筆記体", "明朝", "ゴシック", "Zapfino", "Bradley Hand"])
        let handler = ClosureTarget { pad.clear() }
        clear.target = handler
        clear.action = #selector(ClosureTarget.fire)

        let row = NSStackView(views: [typed, fontPopup, clear])
        row.orientation = .horizontal
        typed.widthAnchor.constraint(equalToConstant: 220).isActive = true
        let stack = NSStackView(views: [pad, row])
        stack.orientation = .vertical
        stack.alignment = .leading
        pad.widthAnchor.constraint(equalToConstant: 420).isActive = true
        pad.heightAnchor.constraint(equalToConstant: 160).isActive = true
        stack.frame = NSRect(x: 0, y: 0, width: 420, height: 200)

        let a = NSAlert()
        a.messageText = "署名を作成"
        a.informativeText = "作成した署名は保存され、次回から選べます。"
        a.addButton(withTitle: "保存して使う")
        a.addButton(withTitle: "キャンセル")
        a.accessoryView = stack
        let result = a.runModal()
        withExtendedLifetime(handler) {}
        guard result == .alertFirstButtonReturn else { return nil }
        let img: CGImage?
        if !pad.isEmpty {
            img = pad.makeImage()
        } else if !typed.stringValue.isEmpty {
            img = typedSignature(typed.stringValue, fontName: fonts[fontPopup.indexOfSelectedItem])
        } else {
            img = nil
        }
        if let img { _ = SignatureStore.save(img) }
        return img
    }
}

/// クロージャを target/action に使うための小さなヘルパー
final class ClosureTarget: NSObject {
    let block: () -> Void
    init(_ block: @escaping () -> Void) { self.block = block }
    @objc func fire() { block() }
}
