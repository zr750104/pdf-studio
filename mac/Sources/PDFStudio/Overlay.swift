import AppKit
import PDFKit

/// 図面の重ね合わせ比較（Windows 版 renderer/overlay.js と同じ計算）。
/// 2 つの版のページを同じ実寸の縮尺で画像にし、位置のずれを合わせて重ね、
/// 古い版だけにある線を赤、新しい版だけにある線を青、共通の線を灰色で描く。
/// 線の太さ・にじみの違いで縁が色づかないよう、相手の版の 2 画素以内に線があれば共通とみなす。
/// 位置合わせは平行移動だけ（回転・拡大縮小の違いは扱わない）。画像は上の行から並べる（y は下向き）
enum Overlay {
    /// 線（暗い画素）を 1/0 で持つ画像
    struct Mask { var bits: [UInt8]; let w: Int; let h: Int }

    /// ページを scale 倍（1 = 72dpi）の白黒の濃さの画像に描き、暗い画素を線として取り出す
    static func render(_ page: PDFPage, scale: CGFloat, threshold: UInt8 = 160) -> Mask? {
        let box = page.bounds(for: .cropBox)
        let turned = (page.rotation / 90) % 2 != 0
        let size = turned ? CGSize(width: box.height, height: box.width) : box.size
        let w = max(1, Int((size.width * scale).rounded())), h = max(1, Int((size.height * scale).rounded()))
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w,
                                  space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return nil }
        ctx.setFillColor(gray: 1, alpha: 1)
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        ctx.scaleBy(x: scale, y: scale)
        // 回転と切り抜きの位置は PDFKit が合わせる
        page.draw(with: .cropBox, to: ctx)
        guard let data = ctx.data else { return nil }
        let px = data.bindMemory(to: UInt8.self, capacity: w * h)
        var bits = [UInt8](repeating: 0, count: w * h)
        // 画像の並びは上の行から（CGBitmapContext のメモリーの並び）
        for i in 0..<(w * h) where px[i] < threshold { bits[i] = 1 }
        return Mask(bits: bits, w: w, h: h)
    }

    /// f 画素四方のどれかに線があれば 1（縮小しても細い線が消えないように）
    static func shrink(_ m: Mask, _ f: Int) -> Mask {
        let w2 = (m.w + f - 1) / f, h2 = (m.h + f - 1) / f
        var out = [UInt8](repeating: 0, count: w2 * h2)
        m.bits.withUnsafeBufferPointer { src in
            for y in 0..<m.h {
                let row = y * m.w, row2 = (y / f) * w2
                for x in 0..<m.w where src[row + x] != 0 { out[row2 + x / f] = 1 }
            }
        }
        return Mask(bits: out, w: w2, h: h2)
    }

    /// 線の画素の位置の一覧（多すぎるときは間引く）
    private static func samplePoints(_ m: Mask, max: Int = 60000) -> [Int32] {
        let n = m.bits.reduce(0) { $0 + Int($1) }
        let step = Swift.max(1, (n + max - 1) / max)
        var pts: [Int32] = []
        pts.reserveCapacity(2 * Swift.min(n, max + 1))
        var k = 0
        for i in 0..<m.bits.count where m.bits[i] != 0 {
            if k % step == 0 { pts.append(Int32(i % m.w)); pts.append(Int32(i / m.w)) }
            k += 1
        }
        return pts
    }

    /// a の線が b のどれだけの線と重なるか（b を (dx, dy) ずらしたとき）
    private static func score(_ pts: UnsafeBufferPointer<Int32>, _ b: UnsafeBufferPointer<UInt8>, _ bw: Int, _ bh: Int, _ dx: Int, _ dy: Int) -> Int {
        var s = 0
        var i = 0
        while i < pts.count {
            let x = Int(pts[i]) - dx, y = Int(pts[i + 1]) - dy
            if x >= 0 && y >= 0 && x < bw && y < bh && b[y * bw + x] != 0 { s += 1 }
            i += 2
        }
        return s
    }

    /// 新しい版（b）を何画素ずらすと古い版（a）にいちばん重なるかを探す（平行移動のみ）。
    /// 粗い画像で広く探し、細かい画像で詰める。戻り値：a[x, y] ↔ b[x - dx, y - dy]
    static func findShift(_ a: Mask, _ b: Mask, maxFrac: Double = 0.05) -> (dx: Int, dy: Int) {
        let maxDim = Swift.max(a.w, a.h, b.w, b.h)
        // 粗い順に：大きい辺が約 200・約 1000 画素、そして実寸
        let levels = Array(Set([Int((Double(maxDim) / 200).rounded(.up)), Int((Double(maxDim) / 1000).rounded(.up)), 1])).filter { $0 >= 1 }.sorted(by: >)
        var dx = 0, dy = 0
        var prevF: Int?
        for f in levels {
            let A = f > 1 ? shrink(a, f) : a
            let B = f > 1 ? shrink(b, f) : b
            let pts = samplePoints(A)
            if pts.isEmpty { return (0, 0) }
            // 最初は広く、次からは前の段の 1 画素ぶん（＋1）の範囲だけ
            let R = prevF == nil ? Int((Double(maxDim) * maxFrac / Double(f)).rounded(.up)) + 1 : Int((Double(prevF!) / Double(f)).rounded(.up)) + 1
            let cx = Int((Double(dx) / Double(f)).rounded()), cy = Int((Double(dy) / Double(f)).rounded())
            var best = -1, bx = cx, by = cy
            pts.withUnsafeBufferPointer { p in
                B.bits.withUnsafeBufferPointer { bb in
                    for sy in (cy - R)...(cy + R) {
                        for sx in (cx - R)...(cx + R) {
                            let s = score(p, bb, B.w, B.h, sx, sy)
                            // 同点なら動かない方を選ぶ（白紙同士などで勝手にずらさない）
                            if s > best || (s == best && abs(sx) + abs(sy) < abs(bx) + abs(by)) { best = s; bx = sx; by = sy }
                        }
                    }
                }
            }
            dx = bx * f
            dy = by * f
            prevF = f
        }
        return (dx, dy)
    }

    /// r 画素ぶん太らせる（四角い範囲の最大値。横と縦に分けて速く）
    static func dilate(_ m: Mask, _ r: Int) -> [UInt8] {
        if r <= 0 { return m.bits }
        let w = m.w, h = m.h
        var tmp = [UInt8](repeating: 0, count: w * h), out = [UInt8](repeating: 0, count: w * h)
        m.bits.withUnsafeBufferPointer { src in
            for y in 0..<h {
                let row = y * w
                var run = 0
                for x in 0..<w { if src[row + x] != 0 { run = r + 1 }; if run > 0 { tmp[row + x] = 1; run -= 1 } }
                run = 0
                for x in stride(from: w - 1, through: 0, by: -1) { if src[row + x] != 0 { run = r + 1 }; if run > 0 { tmp[row + x] = 1; run -= 1 } }
            }
        }
        for x in 0..<w {
            var run = 0
            for y in 0..<h { if tmp[y * w + x] != 0 { run = r + 1 }; if run > 0 { out[y * w + x] = 1; run -= 1 } }
            run = 0
            for y in stride(from: h - 1, through: 0, by: -1) { if tmp[y * w + x] != 0 { run = r + 1 }; if run > 0 { out[y * w + x] = 1; run -= 1 } }
        }
        return out
    }

    /// b を (dx, dy) ずらして w×h の画像に置く（はみ出した所は白）
    static func placeShifted(_ b: Mask, w: Int, h: Int, dx: Int, dy: Int) -> Mask {
        var out = [UInt8](repeating: 0, count: w * h)
        b.bits.withUnsafeBufferPointer { src in
            for y in 0..<h {
                let sy = y - dy
                if sy < 0 || sy >= b.h { continue }
                for x in 0..<w {
                    let sx = x - dx
                    if sx >= 0 && sx < b.w && src[sy * b.w + sx] != 0 { out[y * w + x] = 1 }
                }
            }
        }
        return Mask(bits: out, w: w, h: h)
    }

    static let both: (UInt8, UInt8, UInt8) = (90, 90, 90)
    static let removedColor: (UInt8, UInt8, UInt8) = (220, 30, 30)
    static let addedColor: (UInt8, UInt8, UInt8) = (20, 90, 235)

    /// 重ねた画像（RGB）を作る。a：古い版、b：新しい版（a と同じ大きさにずらしたもの）
    static func compose(_ a: Mask, _ b: Mask, tol: Int = 2) -> (rgb: [UInt8], removed: Int, added: Int, total: Int) {
        let da = dilate(a, tol), db = dilate(b, tol)
        var rgb = [UInt8](repeating: 255, count: a.w * a.h * 3)
        var removed = 0, added = 0, total = 0
        for i in 0..<a.bits.count {
            let ai = a.bits[i] != 0, bi = b.bits[i] != 0
            guard ai || bi else { continue }
            total += 1
            let c: (UInt8, UInt8, UInt8)
            if ai && db[i] == 0 { c = removedColor; removed += 1 }
            else if bi && da[i] == 0 { c = addedColor; added += 1 }
            else { c = both }
            rgb[i * 3] = c.0; rgb[i * 3 + 1] = c.1; rgb[i * 3 + 2] = c.2
        }
        return (rgb, removed, added, total)
    }

    struct PageResult {
        let image: CGImage
        let size: CGSize          // 古い版のページの大きさ（pt、回転後）
        let removed: Int, added: Int, total: Int
        let shiftPx: (Int, Int)
        let shiftMm: (Double, Double)
        let sizeDiffers: Bool
        var changed: Bool { removed + added > Swift.max(20, Int(Double(total) * 0.0005)) }
    }

    static func viewSize(_ page: PDFPage) -> CGSize {
        let b = page.bounds(for: .cropBox).size
        return (page.rotation / 90) % 2 != 0 ? CGSize(width: b.height, height: b.width) : b
    }

    /// 2 つのページを重ねる。同じ実寸の縮尺（200dpi、大きい方のページが maxPixels に収まるまで下げる）で描く
    static func overlay(_ pageA: PDFPage, _ pageB: PDFPage, maxPixels: Double = 12e6, dpi: Double = 200) -> PageResult? {
        let va = viewSize(pageA), vb = viewSize(pageB)
        let s = CGFloat(Swift.min(dpi / 72, (maxPixels / Swift.max(Double(va.width * va.height), Double(vb.width * vb.height))).squareRoot()))
        guard let a = render(pageA, scale: s), let b = render(pageB, scale: s) else { return nil }
        let (dx, dy) = findShift(a, b)
        let placed = placeShifted(b, w: a.w, h: a.h, dx: dx, dy: dy)
        let r = compose(a, placed)
        guard let provider = CGDataProvider(data: Data(r.rgb) as CFData),
              let img = CGImage(width: a.w, height: a.h, bitsPerComponent: 8, bitsPerPixel: 24, bytesPerRow: a.w * 3,
                                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.none.rawValue),
                                provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent) else { return nil }
        // ずれは mm で（1pt = 25.4/72 mm）
        func mm(_ px: Int) -> Double { ((Double(px) / Double(s)) * 25.4 / 72 * 10).rounded() / 10 }
        let differs = abs(va.width - vb.width) > Swift.max(2, va.width * 0.01) || abs(va.height - vb.height) > Swift.max(2, va.height * 0.01)
        return PageResult(image: img, size: va, removed: r.removed, added: r.added, total: r.total,
                          shiftPx: (dx, dy), shiftMm: (mm(dx), mm(dy)), sizeDiffers: differs)
    }

    /// 重ねた結果のページ（画像＋左上の凡例）を 1 枚の PDF ページにする
    static func resultPage(_ r: PageResult) -> PDFPage? {
        let data = NSMutableData()
        var box = CGRect(origin: .zero, size: r.size)
        guard let consumer = CGDataConsumer(data: data as CFMutableData),
              let ctx = CGContext(consumer: consumer, mediaBox: &box, nil) else { return nil }
        ctx.beginPDFPage(nil)
        ctx.interpolationQuality = .none
        ctx.draw(r.image, in: box)
        // 凡例（左上）
        let size = Swift.max(7, Swift.min(14, r.size.width / 70))
        let font = Operations.jpFont(bold: false, size: size)
        let lines: [(String, NSColor)] = [
            (L("赤：古い版だけにある線"), NSColor(calibratedRed: 0.86, green: 0.12, blue: 0.12, alpha: 1)),
            (L("青：新しい版だけにある線"), NSColor(calibratedRed: 0.08, green: 0.35, blue: 0.92, alpha: 1)),
            (L("灰：共通の線"), NSColor(calibratedWhite: 0.35, alpha: 1)),
            ("\(L("位置のずれを補正")): \(r.shiftMm.0) mm, \(r.shiftMm.1) mm", NSColor(calibratedWhite: 0.2, alpha: 1))
        ]
        let ctLines = lines.map { Operations.makeLine($0.0, font: font, color: $0.1) }
        let boxW = (ctLines.map { CTLineGetTypographicBounds($0, nil, nil, nil) }.max() ?? 0) + size * 1.2
        let boxH = CGFloat(lines.count) * size * 1.4 + size * 0.6
        let legend = CGRect(x: size * 0.6, y: r.size.height - boxH - size * 0.6, width: boxW, height: boxH)
        ctx.setFillColor(CGColor(gray: 1, alpha: 0.9))
        ctx.fill(legend)
        ctx.setStrokeColor(CGColor(gray: 0.6, alpha: 1))
        ctx.setLineWidth(0.5)
        ctx.stroke(legend)
        for (k, line) in ctLines.enumerated() {
            ctx.textPosition = CGPoint(x: size * 1.2, y: r.size.height - size * 0.6 - size * 1.4 * CGFloat(k + 1))
            CTLineDraw(line, ctx)
        }
        ctx.endPDFPage()
        ctx.closePDF()
        return PDFDocument(data: data as Data)?.page(at: 0)
    }

    /// 文書どうしを先頭から重ねて比べる（ページ数は少ない方まで）。進み具合を知らせ、中止できる
    static func compare(_ oldDoc: PDFDocument, _ newDoc: PDFDocument, progress: (Int, Int) -> Void, cancelled: () -> Bool)
        -> (doc: PDFDocument, pages: Int, changed: Int, notes: [String])? {
        let n = Swift.min(oldDoc.pageCount, newDoc.pageCount)
        let out = PDFDocument()
        var changed = 0
        var notes: [String] = []
        for i in 0..<n {
            if cancelled() { return nil }
            progress(i, n)
            guard let a = oldDoc.page(at: i), let b = newDoc.page(at: i) else { continue }
            let r: PageResult? = autoreleasepool { overlay(a, b) }
            guard let r, let page = resultPage(r) else { continue }
            out.insert(page, at: out.pageCount)
            if r.changed { changed += 1 }
            if r.sizeDiffers { notes.append(L("ページ {n} は大きさが違います").replacingOccurrences(of: "{n}", with: "\(i + 1)")) }
        }
        progress(n, n)
        if oldDoc.pageCount != newDoc.pageCount {
            notes.append(L("ページ数が違います（{a} / {b}）。先頭から {n} ページだけを比べました")
                .replacingOccurrences(of: "{a}", with: "\(oldDoc.pageCount)").replacingOccurrences(of: "{b}", with: "\(newDoc.pageCount)")
                .replacingOccurrences(of: "{n}", with: "\(n)"))
        }
        return (out, n, changed, notes)
    }
}
