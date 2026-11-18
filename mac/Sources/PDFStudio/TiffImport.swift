import Foundation
import ImageIO
import UniformTypeIdentifiers
import CoreGraphics

/// 複数ページの TIFF を PDF にする。
/// 白黒の FAX 圧縮（CCITT G4）で 1 ストリップのページは、圧縮データをそのまま PDF に入れる（展開しないので速い）。
/// それ以外のページは ImageIO で読み、白黒は G4 に、グレー・カラーは JPEG に圧縮し直して入れる。
enum TiffImport {
    struct Stats {
        var pages = 0
        var passthrough = 0   // G4 をそのまま入れたページ
        var reencodedG4 = 0   // 白黒を G4 に圧縮し直したページ
        var jpeg = 0          // JPEG にしたページ
        var failed = 0        // 読めなかったページ
    }
    static var lastStats = Stats()

    enum Failure: LocalizedError {
        case notTiff, empty
        var errorDescription: String? {
            switch self {
            case .notTiff: return L("TIFF ファイルとして読み込めませんでした")
            case .empty: return L("TIFF にページがありません")
            }
        }
    }

    static func isTiff(_ url: URL) -> Bool {
        ["tif", "tiff"].contains(url.pathExtension.lowercased())
    }

    /// 1 ページ分の、PDF に入れる画像
    private struct PageImage {
        var width: Int
        var height: Int
        var pageSize: CGSize          // ポイント
        var filter: String            // /CCITTFaxDecode, /DCTDecode
        var colorSpace: String        // /DeviceGray, /DeviceRGB
        var bits: Int
        var decodeParms: String?
        var decode: String?
        var data: Data
    }

    // MARK: - TIFF の読み取り

    private struct Reader {
        let d: Data
        let little: Bool
        func u16(_ o: Int) -> Int {
            guard o + 2 <= d.count else { return 0 }
            let a = Int(d[d.startIndex + o]), b = Int(d[d.startIndex + o + 1])
            return little ? a | b << 8 : a << 8 | b
        }
        func u32(_ o: Int) -> Int {
            guard o + 4 <= d.count else { return 0 }
            let b = (0..<4).map { Int(d[d.startIndex + o + $0]) }
            return little ? b[0] | b[1] << 8 | b[2] << 16 | b[3] << 24 : b[0] << 24 | b[1] << 16 | b[2] << 8 | b[3]
        }
    }

    /// IFD の項目。値は数値の配列（SHORT/LONG/RATIONAL の分子・分母）
    private struct IFD {
        var tags: [Int: [Int]] = [:]
        func first(_ t: Int, _ def: Int = 0) -> Int { tags[t]?.first ?? def }
    }

    private static func readIFDs(_ r: Reader) -> [IFD] {
        var out: [IFD] = []
        var off = r.u32(4)
        var seen = Set<Int>()
        while off > 0, off + 2 <= r.d.count, !seen.contains(off), out.count < 100_000 {
            seen.insert(off)
            let n = r.u16(off)
            var ifd = IFD()
            for k in 0..<n {
                let e = off + 2 + k * 12
                guard e + 12 <= r.d.count else { break }
                let tag = r.u16(e), type = r.u16(e + 2), count = r.u32(e + 4)
                let size: Int
                switch type {
                case 3: size = 2
                case 4: size = 4
                case 5: size = 8
                default: size = 1
                }
                // 必要な項目だけ読む（大きな配列は位置・長さだけ）
                guard [256, 257, 258, 259, 262, 266, 273, 274, 277, 278, 279, 282, 283, 293, 296].contains(tag), count > 0, count < 10_000_000 else { continue }
                let valOff = size * count <= 4 ? e + 8 : r.u32(e + 8)
                var vals: [Int] = []
                for i in 0..<count {
                    switch type {
                    case 3: vals.append(r.u16(valOff + i * 2))
                    case 4: vals.append(r.u32(valOff + i * 4))
                    case 5: vals.append(r.u32(valOff + i * 8)); vals.append(max(1, r.u32(valOff + i * 8 + 4)))
                    default: vals.append(Int(r.d[r.d.startIndex + min(r.d.count - 1, valOff + i)]))
                    }
                }
                ifd.tags[tag] = vals
            }
            out.append(ifd)
            off = r.u32(off + 2 + n * 12)
        }
        return out
    }

    /// 解像度（dpi）。無ければ 72
    private static func dpi(_ ifd: IFD, _ tag: Int) -> Double {
        guard let v = ifd.tags[tag], v.count >= 2, v[0] > 0 else { return 72 }
        var r = Double(v[0]) / Double(max(1, v[1]))
        if ifd.first(296, 2) == 3 { r *= 2.54 }   // センチメートル単位
        return r > 1 ? r : 72
    }

    /// G4 の圧縮データをそのまま使えるページなら、その画像
    private static func passthroughG4(_ r: Reader, _ ifd: IFD) -> PageImage? {
        let w = ifd.first(256), h = ifd.first(257)
        guard w > 0, h > 0, ifd.first(259) == 4, ifd.first(258, 1) == 1, ifd.first(277, 1) == 1,
              ifd.first(266, 1) == 1, ifd.first(274, 1) == 1,
              let offs = ifd.tags[273], let lens = ifd.tags[279], offs.count == 1, lens.count == 1,
              offs[0] + lens[0] <= r.d.count, lens[0] > 0 else { return nil }
        // T6Options の「圧縮なしモード」は PDF では扱えないことがあるので使わない
        if ifd.first(293) & 2 != 0 { return nil }
        let photometric = ifd.first(262, 0)
        guard photometric == 0 || photometric == 1 else { return nil }
        let data = r.d.subdata(in: r.d.startIndex + offs[0] ..< r.d.startIndex + offs[0] + lens[0])
        return PageImage(width: w, height: h,
                         pageSize: CGSize(width: Double(w) * 72 / dpi(ifd, 282), height: Double(h) * 72 / dpi(ifd, 283)),
                         filter: "/CCITTFaxDecode", colorSpace: "/DeviceGray", bits: 1,
                         decodeParms: "<< /K -1 /Columns \(w) /Rows \(h) >>",
                         // FAX の白は TIFF では 0（WhiteIsZero）。BlackIsZero のときは白黒を入れ替える
                         decode: photometric == 1 ? "[1 0]" : nil,
                         data: data)
    }

    /// ImageIO で読んで圧縮し直す（白黒は G4、それ以外は JPEG）
    private static func reencode(_ src: CGImageSource, _ index: Int, _ ifd: IFD?) -> (PageImage, isG4: Bool)? {
        guard let img = CGImageSourceCreateImageAtIndex(src, index, nil) else { return nil }
        let props = CGImageSourceCopyPropertiesAtIndex(src, index, nil) as? [CFString: Any]
        let dx = (props?[kCGImagePropertyDPIWidth] as? Double) ?? ifd.map { dpi($0, 282) } ?? 72
        let dy = (props?[kCGImagePropertyDPIHeight] as? Double) ?? ifd.map { dpi($0, 283) } ?? 72
        let size = CGSize(width: Double(img.width) * 72 / max(1, dx), height: Double(img.height) * 72 / max(1, dy))
        // 白黒（1 ビット）のページ。ImageIO は 8 ビットのグレーで返すことがあるので、TIFF の情報でも判断する
        let bilevel = img.bitsPerPixel == 1 || (ifd.map { $0.first(258, 1) == 1 && $0.first(277, 1) == 1 } ?? false)
        if bilevel, let bw = img.bitsPerPixel == 1 ? img : toBilevel(img), let g4 = encodeG4(bw) {
            return (PageImage(width: img.width, height: img.height, pageSize: size, filter: "/CCITTFaxDecode", colorSpace: "/DeviceGray",
                              bits: 1, decodeParms: g4.parms, decode: g4.decode, data: g4.data), true)
        }
        let gray = img.colorSpace?.model == .monochrome
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        // 透明な部分は白にする（JPEG は透明を持てない）
        let flat = flatten(img, gray: gray) ?? img
        CGImageDestinationAddImage(dest, flat, [kCGImageDestinationLossyCompressionQuality: 0.9] as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { return nil }
        return (PageImage(width: flat.width, height: flat.height, pageSize: size, filter: "/DCTDecode",
                          colorSpace: gray ? "/DeviceGray" : "/DeviceRGB", bits: 8, decodeParms: nil, decode: nil, data: out as Data), false)
    }

    /// 1 ビットの白黒画像にする（黒 = 0）
    private static func toBilevel(_ img: CGImage) -> CGImage? {
        let w = img.width, h = img.height
        guard let gray = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return nil }
        gray.setFillColor(CGColor(gray: 1, alpha: 1))
        gray.fill(CGRect(x: 0, y: 0, width: w, height: h))
        gray.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
        guard let src = gray.data?.assumingMemoryBound(to: UInt8.self) else { return nil }
        let rowBytes = (w + 7) / 8
        var bits = [UInt8](repeating: 0, count: rowBytes * h)
        for y in 0..<h {
            let row = src + y * gray.bytesPerRow
            for x in 0..<w where row[x] >= 128 { bits[y * rowBytes + x / 8] |= 0x80 >> UInt8(x % 8) }
        }
        guard let provider = CGDataProvider(data: Data(bits) as CFData) else { return nil }
        return CGImage(width: w, height: h, bitsPerComponent: 1, bitsPerPixel: 1, bytesPerRow: rowBytes, space: CGColorSpaceCreateDeviceGray(),
                       bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.none.rawValue), provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)
    }

    /// 白の背景に描き直す（グレーかカラー、8 ビット）
    private static func flatten(_ img: CGImage, gray: Bool) -> CGImage? {
        let cs = gray ? CGColorSpaceCreateDeviceGray() : CGColorSpaceCreateDeviceRGB()
        let info = gray ? CGImageAlphaInfo.none.rawValue : CGImageAlphaInfo.noneSkipLast.rawValue
        guard let ctx = CGContext(data: nil, width: img.width, height: img.height, bitsPerComponent: 8, bytesPerRow: 0, space: cs, bitmapInfo: info) else { return nil }
        ctx.setFillColor(gray ? CGColor(gray: 1, alpha: 1) : CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: img.width, height: img.height))
        ctx.draw(img, in: CGRect(x: 0, y: 0, width: img.width, height: img.height))
        return ctx.makeImage()
    }

    /// 白黒の画像を G4 圧縮の TIFF に書き、その圧縮データを取り出す
    private static func encodeG4(_ img: CGImage) -> (data: Data, parms: String, decode: String?)? {
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out, UTType.tiff.identifier as CFString, 1, nil) else { return nil }
        let props: [CFString: Any] = [kCGImagePropertyTIFFDictionary: [kCGImagePropertyTIFFCompression: 4]]
        CGImageDestinationAddImage(dest, img, props as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { return nil }
        let d = out as Data
        guard d.count > 8 else { return nil }
        let r = Reader(d: d, little: d[0] == 0x49)
        guard let ifd = readIFDs(r).first, let p = passthroughG4(r, ifd) else { return nil }
        return (p.data, p.decodeParms ?? "", p.decode)
    }

    // MARK: - 変換

    /// TIFF のデータから PDF のデータを作る。progress(終わったページ数, 全ページ数)
    static func pdfData(from data: Data, progress: ((Int, Int) -> Void)? = nil) throws -> Data {
        guard data.count > 8, (data[0] == 0x49 && data[1] == 0x49) || (data[0] == 0x4D && data[1] == 0x4D) else { throw Failure.notTiff }
        let r = Reader(d: data, little: data[0] == 0x49)
        let ifds = readIFDs(r)
        guard let src = CGImageSourceCreateWithData(data as CFData, nil) else { throw Failure.notTiff }
        let n = max(ifds.count, CGImageSourceGetCount(src))
        guard n > 0 else { throw Failure.empty }
        var pages = [PageImage?](repeating: nil, count: n)
        var stats = Stats()
        stats.pages = n
        // G4 のページはそのまま（速い）。残りは並列で圧縮し直す
        var rest: [Int] = []
        for i in 0..<n {
            if i < ifds.count, let p = passthroughG4(r, ifds[i]) { pages[i] = p; stats.passthrough += 1 } else { rest.append(i) }
        }
        progress?(n - rest.count, n)
        if !rest.isEmpty {
            let lock = NSLock()
            var done = n - rest.count
            DispatchQueue.concurrentPerform(iterations: rest.count) { k in
                let i = rest[k]
                let result = autoreleasepool { reencode(src, i, i < ifds.count ? ifds[i] : nil) }
                lock.lock()
                if let (p, g4) = result {
                    pages[i] = p
                    if g4 { stats.reencodedG4 += 1 } else { stats.jpeg += 1 }
                }
                done += 1
                let d = done
                lock.unlock()
                progress?(d, n)
            }
        }
        let list = pages.compactMap { $0 }
        guard !list.isEmpty else { throw Failure.empty }
        stats.failed = n - list.count
        lastStats = stats
        return buildPDF(list)
    }

    /// 画像を 1 ページずつ置いた PDF を書く
    private static func buildPDF(_ pages: [PageImage]) -> Data {
        var out = Data()
        var offsets: [Int] = []
        func append(_ s: String) { out.append(s.data(using: .isoLatin1)!) }
        func begin(_ num: Int) { offsets.append(out.count); append("\(num) 0 obj\n") }
        append("%PDF-1.4\n%\u{E2}\u{E3}\u{CF}\u{D3}\n")
        let n = pages.count
        // 番号：1 カタログ、2 ページ一覧、ページごとに (ページ, 内容, 画像) の 3 つ
        let pageNum = { (i: Int) in 3 + i * 3 }
        begin(1); append("<< /Type /Catalog /Pages 2 0 R >>\nendobj\n")
        begin(2); append("<< /Type /Pages /Count \(n) /Kids [\((0..<n).map { "\(pageNum($0)) 0 R" }.joined(separator: " "))] >>\nendobj\n")
        for (i, p) in pages.enumerated() {
            let pn = pageNum(i)
            let w = String(format: "%.3f", p.pageSize.width), h = String(format: "%.3f", p.pageSize.height)
            begin(pn)
            append("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 \(w) \(h)] /Resources << /XObject << /Im0 \(pn + 2) 0 R >> >> /Contents \(pn + 1) 0 R >>\nendobj\n")
            let content = "q \(w) 0 0 \(h) 0 0 cm /Im0 Do Q"
            begin(pn + 1)
            append("<< /Length \(content.utf8.count) >>\nstream\n\(content)\nendstream\nendobj\n")
            begin(pn + 2)
            var dict = "<< /Type /XObject /Subtype /Image /Width \(p.width) /Height \(p.height) /ColorSpace \(p.colorSpace) /BitsPerComponent \(p.bits) /Filter \(p.filter)"
            if let dp = p.decodeParms { dict += " /DecodeParms \(dp)" }
            if let dc = p.decode { dict += " /Decode \(dc)" }
            dict += " /Length \(p.data.count) >>\nstream\n"
            append(dict)
            out.append(p.data)
            append("\nendstream\nendobj\n")
        }
        let xref = out.count
        append("xref\n0 \(offsets.count + 1)\n0000000000 65535 f \n")
        for o in offsets { append(String(format: "%010d 00000 n \n", o)) }
        append("trailer\n<< /Size \(offsets.count + 1) /Root 1 0 R >>\nstartxref\n\(xref)\n%%EOF\n")
        return out
    }
}
