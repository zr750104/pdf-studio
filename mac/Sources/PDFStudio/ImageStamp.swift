import AppKit
import PDFKit
import ObjectiveC
import UniformTypeIdentifiers

/// 画像・署名・スタンプの注釈。画像を見た目（/AP）に持つ普通の PDF のスタンプ注釈にする。
/// 保存してもページに焼き込まないので、開き直しても動かしたり大きさを変えたりできる（ほかのビューアでも表示される）。
/// PDFKit には見た目を設定する方法がないため、スタンプ注釈を 1 つだけ持つ小さな PDF を作って読み込み、その注釈をページに移す。
private var sourceKey: UInt8 = 0
private var infoKey: UInt8 = 0

/// 作ったときの画像と不透明度（このアプリで開いているあいだだけ。不透明度を変えるときに作り直す）
private final class StampInfo {
    let image: CGImage
    let opacity: CGFloat
    init(_ image: CGImage, _ opacity: CGFloat) { self.image = image; self.opacity = opacity }
}

enum ImageStamp {
    /// 目印はスタンプの名前（/Name）。保存しても残る（独自のキーや /NM は 2 つ目以降が落ちることがあった）
    static let stampName = "PDFStudioImage"

    static func isImageStamp(_ a: PDFAnnotation) -> Bool {
        a.type == "Stamp" && (a.stampName == stampName || a.stampName == "/" + stampName)
    }

    /// 縦横比（高さ / 幅）。作った画像があればその比、なければ今の大きさ
    static func aspect(_ a: PDFAnnotation) -> CGFloat? {
        guard isImageStamp(a) else { return nil }
        if let info = objc_getAssociatedObject(a, &infoKey) as? StampInfo { return CGFloat(info.image.height) / CGFloat(max(1, info.image.width)) }
        return a.bounds.width > 0 ? a.bounds.height / a.bounds.width : nil
    }

    static func opacity(_ a: PDFAnnotation) -> CGFloat {
        (objc_getAssociatedObject(a, &infoKey) as? StampInfo)?.opacity ?? 1
    }

    /// 不透明度を変えられるか（このアプリで置いたもの。開き直したものは画像が手元にないので変えられない）
    static func canChangeOpacity(_ a: PDFAnnotation) -> Bool { objc_getAssociatedObject(a, &infoKey) is StampInfo }

    /// 不透明度を変えた、新しい注釈（同じ位置・大きさ）
    static func withOpacity(_ a: PDFAnnotation, _ o: CGFloat) -> PDFAnnotation? {
        guard let info = objc_getAssociatedObject(a, &infoKey) as? StampInfo else { return nil }
        return make(image: info.image, bounds: a.bounds, opacity: o, name: a.contents)
    }

    /// 画像の縦横比を保ったまま幅を指定して配置用の矩形を作る
    static func rect(for image: CGImage, centeredAt p: CGPoint, width: CGFloat) -> CGRect {
        let ratio = CGFloat(image.height) / CGFloat(max(1, image.width))
        let h = width * ratio
        return CGRect(x: p.x - width / 2, y: p.y - h / 2, width: width, height: h)
    }

    /// 画像を見た目に持つスタンプ注釈を作る
    static func make(image: CGImage, bounds: CGRect, opacity: CGFloat = 1, name: String? = nil) -> PDFAnnotation? {
        guard let enc = encode(image) else { return nil }
        let w = max(1, bounds.width), h = max(1, bounds.height)
        var out = Data()
        var offsets: [Int] = []
        func append(_ s: String) { out.append(s.data(using: .isoLatin1) ?? Data()) }
        func begin(_ n: Int) { offsets.append(out.count); append("\(n) 0 obj\n") }
        let fw = String(format: "%.3f", w), fh = String(format: "%.3f", h)
        append("%PDF-1.4\n")
        begin(1); append("<< /Type /Catalog /Pages 2 0 R >>\nendobj\n")
        begin(2); append("<< /Type /Pages /Count 1 /Kids [3 0 R] >>\nendobj\n")
        begin(3); append("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 \(fw) \(fh)] /Annots [4 0 R] >>\nendobj\n")
        begin(4); append("<< /Type /Annot /Subtype /Stamp /Rect [0 0 \(fw) \(fh)] /F 4 /Name /\(stampName) /AP << /N 5 0 R >> >>\nendobj\n")
        // 不透明度は見た目の中に入れる（/CA は PDFKit で設定できなかった）
        let o = min(1, max(0.05, opacity))
        let content = (o < 1 ? "/GS0 gs " : "") + "q \(fw) 0 0 \(fh) 0 0 cm /Im0 Do Q"
        let gs = o < 1 ? " /ExtGState << /GS0 << /ca \(String(format: "%.3f", o)) /CA \(String(format: "%.3f", o)) >> >>" : ""
        begin(5); append("<< /Type /XObject /Subtype /Form /BBox [0 0 \(fw) \(fh)] /Resources << /XObject << /Im0 6 0 R >>\(gs) >> /Length \(content.utf8.count) >>\nstream\n\(content)\nendstream\nendobj\n")
        begin(6)
        append("<< /Type /XObject /Subtype /Image /Width \(image.width) /Height \(image.height) /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter \(enc.filter)")
        if enc.alpha != nil { append(" /SMask 7 0 R") }
        append(" /Length \(enc.color.count) >>\nstream\n")
        out.append(enc.color)
        append("\nendstream\nendobj\n")
        if let alpha = enc.alpha {
            begin(7)
            append("<< /Type /XObject /Subtype /Image /Width \(image.width) /Height \(image.height) /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length \(alpha.count) >>\nstream\n")
            out.append(alpha)
            append("\nendstream\nendobj\n")
        }
        let xref = out.count
        append("xref\n0 \(offsets.count + 1)\n0000000000 65535 f \n")
        for o in offsets { append(String(format: "%010d 00000 n \n", o)) }
        append("trailer\n<< /Size \(offsets.count + 1) /Root 1 0 R >>\nstartxref\n\(xref)\n%%EOF\n")
        guard let doc = PDFDocument(data: out), let page = doc.page(at: 0), let a = page.annotations.first else { return nil }
        page.removeAnnotation(a)
        // 見た目（画像）は元の小さな PDF の中にあるので、注釈が残っているあいだはその PDF も残す
        objc_setAssociatedObject(a, &sourceKey, doc, .OBJC_ASSOCIATION_RETAIN)
        objc_setAssociatedObject(a, &infoKey, StampInfo(image, o), .OBJC_ASSOCIATION_RETAIN)
        a.bounds = bounds
        if let name { a.contents = name }
        return a
    }

    /// 画像を PDF に入れる形にする。透明な部分があれば色（Flate）と透明度（SMask）に分け、なければ JPEG
    private static func encode(_ img: CGImage) -> (filter: String, color: Data, alpha: Data?)? {
        let w = img.width, h = img.height
        let hasAlpha: Bool = {
            switch img.alphaInfo {
            case .none, .noneSkipFirst, .noneSkipLast: return false
            default: return true
            }
        }()
        if !hasAlpha {
            // PDF には DeviceRGB と書くので、グレーや CMYK の画像は RGB に描き直す（そのままだと白くなる）
            guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
            ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
            guard let rgb = ctx.makeImage() else { return nil }
            let out = NSMutableData()
            guard let dest = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
            CGImageDestinationAddImage(dest, rgb, [kCGImageDestinationLossyCompressionQuality: 0.92] as CFDictionary)
            guard CGImageDestinationFinalize(dest) else { return nil }
            return ("/DCTDecode", out as Data, nil)
        }
        // RGBA（乗算済みでない）で取り出す
        var rgba = [UInt8](repeating: 0, count: w * h * 4)
        let ok: Bool = rgba.withUnsafeMutableBytes { p in
            guard let ctx = CGContext(data: p.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
            ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
            return true
        }
        guard ok else { return nil }
        var color = Data(capacity: w * h * 3)
        var alpha = Data(capacity: w * h)
        for i in 0..<(w * h) {
            let a = rgba[i * 4 + 3]
            if a == 0 {
                color.append(contentsOf: [255, 255, 255])
            } else {
                // 乗算済みを戻す
                for k in 0..<3 { color.append(UInt8(min(255, Int(rgba[i * 4 + k]) * 255 / Int(a)))) }
            }
            alpha.append(a)
        }
        guard let c = Zlib.compress(color), let a = Zlib.compress(alpha) else { return nil }
        return ("/FlateDecode", c, a)
    }
}

/// zlib 形式（PDF の FlateDecode）で圧縮する
enum Zlib {
    static func compress(_ data: Data) -> Data? {
        guard let raw = try? (data as NSData).compressed(using: .zlib) as Data else { return nil }
        var out = Data([0x78, 0x9C])
        out.append(raw)
        // Adler-32（ビッグエンディアン）
        var a: UInt32 = 1, b: UInt32 = 0
        data.withUnsafeBytes { (p: UnsafeRawBufferPointer) in
            var i = 0
            let n = p.count
            while i < n {
                let end = min(n, i + 5552)
                while i < end { a += UInt32(p[i]); b += a; i += 1 }
                a %= 65521; b %= 65521
            }
        }
        let adler = (b << 16) | a
        out.append(contentsOf: [UInt8(adler >> 24), UInt8((adler >> 16) & 0xff), UInt8((adler >> 8) & 0xff), UInt8(adler & 0xff)])
        return out
    }
}
