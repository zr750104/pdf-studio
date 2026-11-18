import AppKit
import PDFKit

// アプリ全体で使う通知名
extension Notification.Name {
    static let studioAnnotationsChanged = Notification.Name("PDFStudioAnnotationsChanged")
    static let studioDocumentReplaced = Notification.Name("PDFStudioDocumentReplaced")
    static let studioPagesChanged = Notification.Name("PDFStudioPagesChanged")
    static let studioSelectionChanged = Notification.Name("PDFStudioAnnotationSelectionChanged")
    static let studioToolChanged = Notification.Name("PDFStudioToolChanged")
}

enum StudioError: LocalizedError {
    case message(String)
    var errorDescription: String? {
        switch self { case .message(let m): return m }
    }
}

// MARK: - ダイアログ

enum Dialog {
    static func alert(_ title: String, _ message: String = "", style: NSAlert.Style = .informational) {
        // 失敗の知らせは記録しておく（報告のおすすめはしない）
        if style == .warning || style == .critical { ErrorLog.record("handled", "\(title): \(message)", prompt: false) }
        let a = NSAlert()
        a.alertStyle = style
        a.messageText = title
        a.informativeText = message
        a.runModal()
    }

    static func confirm(_ title: String, _ message: String = "", ok: String = "OK") -> Bool {
        let a = NSAlert()
        a.messageText = title
        a.informativeText = message
        a.addButton(withTitle: ok)
        a.addButton(withTitle: "キャンセル")
        return a.runModal() == .alertFirstButtonReturn
    }

    /// 複数行テキスト入力
    static func text(_ title: String, message: String = "", initial: String = "", multiline: Bool = true) -> String? {
        let a = NSAlert()
        a.messageText = title
        a.informativeText = message
        a.addButton(withTitle: "OK")
        a.addButton(withTitle: "キャンセル")
        if multiline {
            let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 340, height: 110))
            scroll.hasVerticalScroller = true
            scroll.borderType = .bezelBorder
            let tv = NSTextView(frame: scroll.bounds)
            tv.isRichText = false
            tv.font = NSFont.systemFont(ofSize: 13)
            tv.string = initial
            tv.autoresizingMask = [.width]
            tv.isVerticallyResizable = true
            scroll.documentView = tv
            a.accessoryView = scroll
            a.window.initialFirstResponder = tv
            guard a.runModal() == .alertFirstButtonReturn else { return nil }
            return tv.string
        } else {
            let tf = NSTextField(frame: NSRect(x: 0, y: 0, width: 300, height: 24))
            tf.stringValue = initial
            a.accessoryView = tf
            a.window.initialFirstResponder = tf
            guard a.runModal() == .alertFirstButtonReturn else { return nil }
            return tf.stringValue
        }
    }

    static func password(_ title: String, message: String = "") -> String? {
        let a = NSAlert()
        a.messageText = title
        a.informativeText = message
        a.addButton(withTitle: "OK")
        a.addButton(withTitle: "キャンセル")
        let tf = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
        a.accessoryView = tf
        a.window.initialFirstResponder = tf
        guard a.runModal() == .alertFirstButtonReturn else { return nil }
        return tf.stringValue
    }

    static func openFiles(types: [UTType], multiple: Bool, title: String? = nil) -> [URL] {
        let p = NSOpenPanel()
        p.allowedContentTypes = types
        p.allowsMultipleSelection = multiple
        p.canChooseDirectories = false
        if let title { p.message = title }
        return p.runModal() == .OK ? p.urls : []
    }

    static func chooseFolder(title: String) -> URL? {
        let p = NSOpenPanel()
        p.canChooseFiles = false
        p.canChooseDirectories = true
        p.canCreateDirectories = true
        p.message = title
        p.prompt = "選択"
        return p.runModal() == .OK ? p.url : nil
    }

    static func saveFile(name: String, type: UTType) -> URL? {
        let p = NSSavePanel()
        p.nameFieldStringValue = name
        p.allowedContentTypes = [type]
        p.canCreateDirectories = true
        return p.runModal() == .OK ? p.url : nil
    }
}

import UniformTypeIdentifiers

/// ラベル付きコントロールを並べた入力フォーム（NSAlert のアクセサリとして表示）
final class FormBuilder {
    let grid = NSGridView()

    init() {
        grid.rowSpacing = 8
        grid.columnSpacing = 10
    }

    private func label(_ s: String) -> NSTextField {
        let l = NSTextField(labelWithString: s)
        l.alignment = .right
        return l
    }

    private func addRow(_ title: String, _ view: NSView) {
        let row = grid.addRow(with: [label(title), view])
        row.yPlacement = .center
        grid.cell(for: row.cell(at: 0).contentView!)?.xPlacement = .trailing
    }

    @discardableResult
    func text(_ title: String, _ value: String, width: CGFloat = 260, placeholder: String? = nil) -> NSTextField {
        let tf = NSTextField(string: value)
        tf.placeholderString = placeholder
        tf.widthAnchor.constraint(equalToConstant: width).isActive = true
        addRow(title, tf)
        return tf
    }

    @discardableResult
    func secure(_ title: String) -> NSSecureTextField {
        let tf = NSSecureTextField(string: "")
        tf.widthAnchor.constraint(equalToConstant: 220).isActive = true
        addRow(title, tf)
        return tf
    }

    @discardableResult
    func number(_ title: String, _ value: Double, width: CGFloat = 80) -> NSTextField {
        let tf = NSTextField(string: Self.format(value))
        tf.widthAnchor.constraint(equalToConstant: width).isActive = true
        addRow(title, tf)
        return tf
    }

    @discardableResult
    func popup(_ title: String, _ items: [String], selected: Int = 0) -> NSPopUpButton {
        let p = NSPopUpButton(frame: .zero, pullsDown: false)
        p.addItems(withTitles: items)
        p.selectItem(at: selected)
        addRow(title, p)
        return p
    }

    @discardableResult
    func color(_ title: String, _ color: NSColor) -> NSColorWell {
        let w = NSColorWell(frame: NSRect(x: 0, y: 0, width: 44, height: 24))
        w.color = color
        w.widthAnchor.constraint(equalToConstant: 44).isActive = true
        w.heightAnchor.constraint(equalToConstant: 24).isActive = true
        addRow(title, w)
        return w
    }

    @discardableResult
    func check(_ title: String, _ on: Bool) -> NSButton {
        let b = NSButton(checkboxWithTitle: title, target: nil, action: nil)
        b.state = on ? .on : .off
        let row = grid.addRow(with: [NSGridCell.emptyContentView, b])
        row.yPlacement = .center
        return b
    }

    func note(_ s: String) {
        let l = NSTextField(wrappingLabelWithString: s)
        l.font = NSFont.systemFont(ofSize: 11)
        l.textColor = .secondaryLabelColor
        l.preferredMaxLayoutWidth = 300
        grid.addRow(with: [NSGridCell.emptyContentView, l])
    }

    func run(title: String, message: String = "", ok: String = "OK") -> Bool {
        let a = NSAlert()
        a.messageText = title
        a.informativeText = message
        a.addButton(withTitle: ok)
        a.addButton(withTitle: "キャンセル")
        grid.layoutSubtreeIfNeeded()
        let size = grid.fittingSize
        grid.frame = NSRect(origin: .zero, size: size)
        a.accessoryView = grid
        return a.runModal() == .alertFirstButtonReturn
    }

    static func format(_ v: Double) -> String {
        v == v.rounded() ? String(Int(v)) : String(v)
    }
}

extension NSTextField {
    /// 入力された数（nan・inf・極端に大きな値は使わない。Int にしても止まらないように）
    var doubleValueOrNil: Double? {
        guard let v = Double(stringValue.trimmingCharacters(in: .whitespaces)), v.isFinite, abs(v) < 1e9 else { return nil }
        return v
    }
}

// MARK: - ページ範囲

enum PageRange {
    /// "1-3, 5, 8-" のような文字列を 0 始まりのインデックス配列に変換。空なら全ページ。
    static func parse(_ text: String, pageCount: Int) -> [Int]? {
        let t = text.trimmingCharacters(in: .whitespaces)
        if t.isEmpty || t == "全て" || t.lowercased() == "all" { return Array(0..<pageCount) }
        var result: [Int] = []
        for part in t.replacingOccurrences(of: "、", with: ",").split(separator: ",") {
            let p = part.trimmingCharacters(in: .whitespaces)
            if p.isEmpty { continue }
            if let dash = p.firstIndex(where: { $0 == "-" || $0 == "〜" || $0 == "~" }) {
                let a = p[..<dash].trimmingCharacters(in: .whitespaces)
                let b = p[p.index(after: dash)...].trimmingCharacters(in: .whitespaces)
                let start = a.isEmpty ? 1 : Int(a)
                let end = b.isEmpty ? pageCount : Int(b)
                guard let s = start, let e = end, s >= 1, e <= pageCount, s <= e else { return nil }
                result.append(contentsOf: (s - 1)...(e - 1))
            } else {
                guard let n = Int(p), n >= 1, n <= pageCount else { return nil }
                result.append(n - 1)
            }
        }
        var seen = Set<Int>()
        return result.filter { seen.insert($0).inserted }
    }
}

// MARK: - 描画ヘルパー

enum Render {
    /// AppKit の描画命令で透過ビットマップを作る（スタンプ・署名用）
    static func image(size: NSSize, scale: CGFloat = 4, _ draw: (CGRect) -> Void) -> CGImage? {
        guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil,
                                         pixelsWide: max(1, Int(size.width * scale)),
                                         pixelsHigh: max(1, Int(size.height * scale)),
                                         bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                         colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { return nil }
        rep.size = size
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        draw(CGRect(origin: .zero, size: size))
        NSGraphicsContext.restoreGraphicsState()
        return rep.cgImage
    }

    /// ページ内容（注釈なし・回転なし）を mediaBox 基準でラスタライズ
    static func pageContent(_ page: PDFPage, dpi: CGFloat) -> CGImage? {
        guard let cg = page.pageRef else { return nil }
        let box = page.bounds(for: .mediaBox)
        let scale = dpi / 72
        let w = Int(box.width * scale), h = Int(box.height * scale)
        guard w > 0, h > 0,
              let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
        ctx.setFillColor(CGColor(gray: 1, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        ctx.scaleBy(x: scale, y: scale)
        ctx.translateBy(x: -box.minX, y: -box.minY)
        ctx.drawPDFPage(cg)
        return ctx.makeImage()
    }

    /// 表示どおり（回転・注釈込み）の画像
    static func pageAsDisplayed(_ page: PDFPage, dpi: CGFloat) -> NSImage {
        let crop = page.bounds(for: .cropBox)
        var size = crop.size
        if page.rotation % 180 != 0 { size = NSSize(width: size.height, height: size.width) }
        let scale = dpi / 72
        return page.thumbnail(of: NSSize(width: size.width * scale, height: size.height * scale), for: .cropBox)
    }

    /// 文字の見た目（グリフ形状）の中心を center に合わせて描く
    static func drawCentered(_ s: String, font: NSFont, color: NSColor, center: CGPoint) {
        guard let ctx = NSGraphicsContext.current?.cgContext, !s.isEmpty else { return }
        let line = Operations.makeLine(s, font: font as CTFont, color: color)
        let b = CTLineGetBoundsWithOptions(line, .useGlyphPathBounds)
        ctx.saveGState()
        ctx.textMatrix = .identity
        ctx.textPosition = CGPoint(x: center.x - b.midX, y: center.y - b.midY)
        CTLineDraw(line, ctx)
        ctx.restoreGState()
    }

    static func pngData(_ image: CGImage) -> Data? {
        NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])
    }
}

extension CGRect {
    static func spanning(_ a: CGPoint, _ b: CGPoint) -> CGRect {
        CGRect(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(a.x - b.x), height: abs(a.y - b.y))
    }
}

extension NSColor {
    var hexString: String {
        guard let c = usingColorSpace(.sRGB) else { return "#000000" }
        return String(format: "#%02X%02X%02X", Int(c.redComponent * 255), Int(c.greenComponent * 255), Int(c.blueComponent * 255))
    }
}

/// 表示座標（回転後、左下原点）→ ページ座標 への変換。ヘッダー/透かしの配置に使う。
enum DisplaySpace {
    static func size(of page: PDFPage) -> CGSize {
        let c = page.bounds(for: .cropBox)
        return page.rotation % 180 == 0 ? c.size : CGSize(width: c.height, height: c.width)
    }

    static func transform(for page: PDFPage) -> CGAffineTransform {
        let c = page.bounds(for: .cropBox)
        let W = c.width, H = c.height
        switch ((page.rotation % 360) + 360) % 360 {
        case 90: return CGAffineTransform(a: 0, b: 1, c: -1, d: 0, tx: c.minX + W, ty: c.minY)
        case 180: return CGAffineTransform(a: -1, b: 0, c: 0, d: -1, tx: c.minX + W, ty: c.minY + H)
        case 270: return CGAffineTransform(a: 0, b: -1, c: 1, d: 0, tx: c.minX, ty: c.minY + H)
        default: return CGAffineTransform(translationX: c.minX, y: c.minY)
        }
    }
}

// MARK: - 短いお知らせ（数秒で消える）

enum Toast {
    static func show(_ text: String, in window: NSWindow?, seconds: Double = 3) {
        guard let content = window?.contentView else { return }
        let label = NSTextField(wrappingLabelWithString: text)
        label.textColor = .white
        label.font = NSFont.systemFont(ofSize: 13, weight: .medium)
        label.alignment = .center
        label.preferredMaxLayoutWidth = 460
        let box = NSView()
        box.wantsLayer = true
        box.layer?.backgroundColor = NSColor.black.withAlphaComponent(0.78).cgColor
        box.layer?.cornerRadius = 8
        box.translatesAutoresizingMaskIntoConstraints = false
        label.translatesAutoresizingMaskIntoConstraints = false
        box.addSubview(label)
        content.addSubview(box)
        NSLayoutConstraint.activate([
            label.topAnchor.constraint(equalTo: box.topAnchor, constant: 8),
            label.bottomAnchor.constraint(equalTo: box.bottomAnchor, constant: -8),
            label.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: 14),
            label.trailingAnchor.constraint(equalTo: box.trailingAnchor, constant: -14),
            box.centerXAnchor.constraint(equalTo: content.centerXAnchor),
            box.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -40)
        ])
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) {
            NSAnimationContext.runAnimationGroup({ $0.duration = 0.3; box.animator().alphaValue = 0 }, completionHandler: { box.removeFromSuperview() })
        }
    }
}
