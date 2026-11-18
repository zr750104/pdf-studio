import AppKit

/// 英語のスタンプと、自分で作ったスタンプ（文字・画像）
enum CustomStamps {
    static let green = NSColor(calibratedRed: 0.1, green: 0.55, blue: 0.25, alpha: 1)
    static let nameKey = "PDFStudioHankoName"

    /// 英語のスタンプ（文字はそのまま。訳さない）
    static let english: [(String, NSColor, Bool)] = [
        ("APPROVED", StampRenderer.red, true), ("REVIEWED", StampRenderer.blue, true), ("RECEIVED", StampRenderer.blue, true), ("COMPLETED", green, true),
        ("CONFIDENTIAL", StampRenderer.red, false), ("DRAFT", StampRenderer.blue, false), ("FINAL", green, false), ("FOR REVIEW", StampRenderer.blue, false),
        ("REJECTED", StampRenderer.red, true), ("NOT APPROVED", StampRenderer.red, true), ("URGENT", StampRenderer.red, false), ("VOID", StampRenderer.red, false),
        ("PAID", green, true), ("COPY", StampRenderer.blue, false), ("SIGN HERE", StampRenderer.red, false), ("AS IS", StampRenderer.blue, false)
    ]

    /// 保存する 1 つのスタンプ。kind = text（文字と色と下段）/ image（画像ファイル名）
    struct Item: Codable, Equatable {
        var kind: String
        var text: String?
        var color: String?    // "#rrggbb"
        var sub: String?      // 下段。{date} {time} {name} を押すときに入れ替える
        var file: String?
        var name: String?
    }

    static var directory: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let dir = base.appendingPathComponent("PDFStudio/Stamps", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }
    private static var listURL: URL { directory.appendingPathComponent("stamps.json") }

    static func all() -> [Item] {
        guard let d = try? Data(contentsOf: listURL) else { return [] }
        return (try? JSONDecoder().decode([Item].self, from: d)) ?? []
    }

    static func save(_ list: [Item]) {
        if let d = try? JSONEncoder().encode(list) { try? d.write(to: listURL, options: .atomic) }
    }

    static func add(_ item: Item) { save(all() + [item]) }

    static func remove(_ item: Item) {
        save(all().filter { $0 != item })
        if let f = item.file { try? FileManager.default.removeItem(at: directory.appendingPathComponent(f)) }
    }

    /// 下段の {date}・{time}・{name} を、押すときの値にする（押すたびに最新になる）
    static func expand(_ s: String, now: Date = Date()) -> String {
        let tf = DateFormatter()
        tf.dateFormat = "HH:mm"
        let name = UserDefaults.standard.string(forKey: nameKey) ?? ""
        return s.replacingOccurrences(of: "{date}", with: StampRenderer.dateString(now))
            .replacingOccurrences(of: "{time}", with: tf.string(from: now))
            .replacingOccurrences(of: "{name}", with: name)
    }

    static func hex(_ c: NSColor) -> String {
        let s = c.usingColorSpace(.sRGB) ?? c
        return String(format: "#%02x%02x%02x", Int(s.redComponent * 255), Int(s.greenComponent * 255), Int(s.blueComponent * 255))
    }

    static func color(_ hex: String?) -> NSColor {
        guard let hex, hex.count == 7, let v = Int(hex.dropFirst(), radix: 16) else { return StampRenderer.red }
        return NSColor(srgbRed: CGFloat((v >> 16) & 255) / 255, green: CGFloat((v >> 8) & 255) / 255, blue: CGFloat(v & 255) / 255, alpha: 1)
    }

    /// 押すときの画像
    static func image(_ item: Item) -> CGImage? {
        if item.kind == "image", let f = item.file {
            return NSImage(contentsOf: directory.appendingPathComponent(f))?.cgImage(forProposedRect: nil, context: nil, hints: nil)
        }
        return StampRenderer.textStamp(item.text ?? "", color: color(item.color), sub: expand(item.sub ?? ""))
    }

    /// 文字スタンプを作る（ダイアログ）
    static func createText() -> Item? {
        let f = FormBuilder()
        let text = f.text("文字", "", width: 220)
        let color = f.color("色", StampRenderer.red)
        let sub = f.text("下段", "{date}", width: 220, placeholder: L("空欄で 1 段"))
        f.note("下段には {date}（押した日）・{time}（時刻）・{name}（印鑑の氏名）が使えます。押すたびに最新の値になります。")
        guard f.run(title: "文字スタンプを作成") else { return nil }
        let t = text.stringValue.trimmingCharacters(in: .whitespaces)
        guard !t.isEmpty else { return nil }
        return Item(kind: "text", text: t, color: hex(color.color), sub: sub.stringValue, file: nil, name: nil)
    }

    /// 画像（PNG / JPEG）からスタンプを作る。大きすぎる画像は縮小して保存する
    static func createImage() -> Item? {
        guard let url = Dialog.openFiles(types: [.png, .jpeg], multiple: false, title: "スタンプにする画像").first,
              let src = NSImage(contentsOf: url)?.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return nil }
        let k = min(1, 600 / CGFloat(max(src.width, src.height)))
        let w = max(1, Int(CGFloat(src.width) * k)), h = max(1, Int(CGFloat(src.height) * k))
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        ctx.interpolationQuality = .high
        ctx.draw(src, in: CGRect(x: 0, y: 0, width: w, height: h))
        guard let img = ctx.makeImage(), let png = Render.pngData(img) else { return nil }
        let file = "stamp-\(UUID().uuidString).png"
        do { try png.write(to: directory.appendingPathComponent(file)) } catch { return nil }
        return Item(kind: "image", text: nil, color: nil, sub: nil, file: file, name: url.lastPathComponent)
    }

    /// メニューに出す小さな見本
    static func preview(_ img: CGImage?) -> NSImage? {
        guard let img else { return nil }
        let h: CGFloat = 22
        let w = min(120, h * CGFloat(img.width) / CGFloat(max(1, img.height)))
        return NSImage(cgImage: img, size: NSSize(width: w, height: h))
    }
}
