// アプリアイコン（AppIcon.icns）を生成するスクリプト: swift make_icon.swift
import AppKit

let sizes = [16, 32, 64, 128, 256, 512, 1024]
let set = URL(fileURLWithPath: "build/AppIcon.iconset")
try? FileManager.default.createDirectory(at: set, withIntermediateDirectories: true)

func draw(_ px: Int) -> Data? {
    let s = CGFloat(px)
    guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4,
                                     hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { return nil }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let r = NSRect(x: s * 0.1, y: s * 0.1, width: s * 0.8, height: s * 0.8)
    let bg = NSBezierPath(roundedRect: r, xRadius: s * 0.18, yRadius: s * 0.18)
    NSGradient(starting: NSColor(calibratedRed: 0.95, green: 0.27, blue: 0.22, alpha: 1),
               ending: NSColor(calibratedRed: 0.72, green: 0.06, blue: 0.12, alpha: 1))?.draw(in: bg, angle: -90)
    // 紙
    let paper = NSRect(x: s * 0.3, y: s * 0.22, width: s * 0.4, height: s * 0.52)
    NSColor.white.setFill()
    NSBezierPath(roundedRect: paper, xRadius: s * 0.03, yRadius: s * 0.03).fill()
    NSColor(calibratedWhite: 0.8, alpha: 1).setFill()
    for i in 0..<4 {
        NSBezierPath(rect: NSRect(x: paper.minX + s * 0.05, y: paper.maxY - s * (0.12 + CGFloat(i) * 0.07), width: s * 0.3, height: s * 0.025)).fill()
    }
    // ペン
    let pen = NSBezierPath()
    pen.move(to: NSPoint(x: s * 0.52, y: s * 0.24))
    pen.line(to: NSPoint(x: s * 0.76, y: s * 0.48))
    pen.lineWidth = s * 0.06
    pen.lineCapStyle = .round
    NSColor(calibratedRed: 1, green: 0.8, blue: 0.2, alpha: 1).setStroke()
    pen.stroke()
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])
}

for px in sizes {
    if px <= 512 { try? draw(px)?.write(to: set.appendingPathComponent("icon_\(px)x\(px).png")) }
    if px >= 32 { try? draw(px)?.write(to: set.appendingPathComponent("icon_\(px / 2)x\(px / 2)@2x.png")) }
}
