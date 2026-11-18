import AppKit

enum Tool: String, CaseIterable {
    case select, hand
    case highlight, underline, strikeout
    case note, text, editText
    case ink, rect, ellipse, line, arrow
    case image, signature, stamp
    case redact, crop, link
    case formText, formCheckbox, formChoice
    case measureDistance, measurePerimeter, measureArea
    case eraser

    var title: String {
        switch self {
        case .select: return "選択"
        case .hand: return "スクロール（手のひら）"
        case .highlight: return "ハイライト"
        case .underline: return "下線"
        case .strikeout: return "取り消し線"
        case .note: return "付箋（ノート）"
        case .text: return "テキストボックス"
        case .editText: return "既存テキストを編集"
        case .ink: return "手書き（フリーハンド）"
        case .rect: return "矩形"
        case .ellipse: return "楕円"
        case .line: return "直線"
        case .arrow: return "矢印"
        case .image: return "画像を配置"
        case .signature: return "署名"
        case .stamp: return "スタンプ・印鑑"
        case .redact: return "墨消し（範囲指定）"
        case .crop: return "トリミング"
        case .link: return "リンク"
        case .formText: return "フォーム: テキストフィールド"
        case .formCheckbox: return "フォーム: チェックボックス"
        case .formChoice: return "フォーム: ドロップダウン"
        case .measureDistance: return "距離の測定"
        case .measurePerimeter: return "周長の測定"
        case .measureArea: return "面積の測定"
        case .eraser: return "注釈を削除（消しゴム）"
        }
    }

    var symbol: String {
        switch self {
        case .select: return "cursorarrow"
        case .hand: return "hand.raised"
        case .highlight: return "highlighter"
        case .underline: return "underline"
        case .strikeout: return "strikethrough"
        case .note: return "note.text"
        case .text: return "textbox"
        case .editText: return "character.cursor.ibeam"
        case .ink: return "scribble"
        case .rect: return "rectangle"
        case .ellipse: return "circle"
        case .line: return "line.diagonal"
        case .arrow: return "arrow.up.right"
        case .image: return "photo"
        case .signature: return "signature"
        case .stamp: return "seal"
        case .redact: return "rectangle.inset.filled"
        case .crop: return "crop"
        case .link: return "link"
        case .formText: return "character.textbox"
        case .formCheckbox: return "checkmark.square"
        case .formChoice: return "filemenu.and.selection"
        case .measureDistance: return "ruler"
        case .measurePerimeter: return "point.3.connected.trianglepath.dotted"
        case .measureArea: return "pentagon"
        case .eraser: return "eraser"
        }
    }

    /// ツールバーでのグループ（区切り線の位置）
    static let groups: [[Tool]] = [
        [.select, .hand],
        [.highlight, .underline, .strikeout, .note, .text, .editText],
        [.ink, .rect, .ellipse, .line, .arrow],
        [.image, .signature, .stamp],
        [.redact, .crop, .link],
        [.formText, .formCheckbox, .formChoice],
        [.measureDistance, .measurePerimeter, .measureArea],
        [.eraser]
    ]

    var isDragTool: Bool {
        switch self {
        case .text, .ink, .rect, .ellipse, .line, .arrow, .redact, .crop, .link, .formText, .formCheckbox, .formChoice, .measureDistance: return true
        default: return false
        }
    }

    var isMarkup: Bool { self == .highlight || self == .underline || self == .strikeout }

    /// クリックで頂点を足していく測定（周長・面積）
    var isPolyMeasure: Bool { self == .measurePerimeter || self == .measureArea }

    /// キーボードショートカット（ツールメニュー用）
    var keyEquivalent: String {
        switch self {
        case .select: return "v"
        case .hand: return "h"
        case .highlight: return "u"
        case .note: return "n"
        case .text: return "t"
        case .editText: return "e"
        case .ink: return "p"
        case .rect: return "r"
        case .ellipse: return "o"
        case .line: return "l"
        case .arrow: return "a"
        case .measureDistance: return "m"
        default: return ""
        }
    }
}

/// 新しく作る注釈の見た目の設定
final class ToolSettings {
    var strokeColor = NSColor.systemRed
    var fillColor: NSColor? = nil
    var highlightColor = NSColor.systemYellow
    var lineWidth: CGFloat = 2
    var opacity: CGFloat = 1
    var fontName = "HiraginoSans-W3"
    var fontSize: CGFloat = 14
    var textColor = NSColor.black

    static let fonts: [(String, String)] = [
        ("ヒラギノ角ゴシック W3", "HiraginoSans-W3"),
        ("ヒラギノ角ゴシック W6", "HiraginoSans-W6"),
        ("ヒラギノ明朝 ProN W3", "HiraMinProN-W3"),
        ("ヒラギノ明朝 ProN W6", "HiraMinProN-W6"),
        ("ヒラギノ丸ゴ ProN", "HiraMaruProN-W4"),
        ("Helvetica", "Helvetica"),
        ("Times New Roman", "TimesNewRomanPSMT"),
        ("Courier", "Courier")
    ]

    var font: NSFont { NSFont(name: fontName, size: fontSize) ?? NSFont.systemFont(ofSize: fontSize) }

    func stroke() -> NSColor { strokeColor.withAlphaComponent(opacity) }
    func fill() -> NSColor? { fillColor?.withAlphaComponent(opacity) }
}
