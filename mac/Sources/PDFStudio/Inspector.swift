import AppKit
import PDFKit

/// 書式バー（ツールバーの下の 1 行）：ツールの既定値と、選択中の注釈の見た目を編集する
final class InspectorViewController: NSViewController, NSTextFieldDelegate {
    weak var editor: EditorPDFView!

    private let toolLabel = NSTextField(labelWithString: "")
    private let hint = NSTextField(wrappingLabelWithString: "")
    private let strokeWell = NSColorWell()
    private let fillWell = NSColorWell()
    private let noFill = NSButton(checkboxWithTitle: "塗りなし", target: nil, action: nil)
    private let highlightWell = NSColorWell()
    private let textWell = NSColorWell()
    private let widthSlider = NSSlider(value: 2, minValue: 0.5, maxValue: 20, target: nil, action: nil)
    private let widthLabel = NSTextField(labelWithString: "2")
    private let opacitySlider = NSSlider(value: 1, minValue: 0.1, maxValue: 1, target: nil, action: nil)
    private let fontPopup = NSPopUpButton()
    private let fontSize = NSTextField(string: "14")
    private let selTitle = NSTextField(labelWithString: "")
    private let selContents = NSTextField(string: "")
    private let selBox = NSStackView()

    // 書式バーのまとまり（ツール・選択中の注釈に合わせて出し分ける）
    private var strokeGroup = NSStackView(), fillGroup = NSStackView(), textGroup = NSStackView(), highlightGroup = NSStackView()
    private var widthGroup = NSStackView(), opacityGroup = NSStackView(), fontGroup = NSStackView()
    static let barHeight: CGFloat = 34

    /// 書式バー（ツールバーの下の 1 行）：ツールの既定値と、選択中の注釈の見た目を変える
    override func loadView() {
        let v = NSView()
        let stack = NSStackView()
        stack.orientation = .horizontal
        stack.alignment = .centerY
        stack.spacing = 14
        stack.edgeInsets = NSEdgeInsets(top: 0, left: 12, bottom: 0, right: 12)
        stack.detachesHiddenViews = true

        toolLabel.font = NSFont.boldSystemFont(ofSize: 12)
        toolLabel.textColor = .controlAccentColor
        toolLabel.lineBreakMode = .byTruncatingTail
        toolLabel.widthAnchor.constraint(lessThanOrEqualToConstant: 170).isActive = true

        for w in [strokeWell, fillWell, highlightWell, textWell] {
            w.target = self
            w.action = #selector(colorChanged(_:))
            w.widthAnchor.constraint(equalToConstant: 36).isActive = true
            w.heightAnchor.constraint(equalToConstant: 20).isActive = true
        }
        noFill.target = self
        noFill.action = #selector(colorChanged(_:))
        widthSlider.target = self
        widthSlider.action = #selector(widthChanged)
        widthSlider.isContinuous = true
        widthSlider.controlSize = .small
        opacitySlider.target = self
        opacitySlider.action = #selector(opacityChanged)
        opacitySlider.isContinuous = false   // 離したときに 1 回だけ変える（画像の作り直し・取り消しの記録を減らす）
        opacitySlider.controlSize = .small
        for (name, ps) in ToolSettings.fonts {
            fontPopup.addItem(withTitle: name)
            fontPopup.lastItem?.representedObject = ps
        }
        fontPopup.target = self
        fontPopup.action = #selector(fontChanged)
        fontPopup.controlSize = .small
        fontSize.delegate = self
        fontSize.controlSize = .small
        fontSize.widthAnchor.constraint(equalToConstant: 40).isActive = true

        func group(_ g: NSStackView, _ title: String, _ views: [NSView]) -> NSStackView {
            let l = NSTextField(labelWithString: title)
            l.font = NSFont.systemFont(ofSize: 11)
            l.textColor = .secondaryLabelColor
            views.forEach { g.addArrangedSubview($0) }
            g.insertArrangedSubview(l, at: 0)
            g.orientation = .horizontal
            g.spacing = 5
            g.alignment = .centerY
            return g
        }
        widthSlider.widthAnchor.constraint(equalToConstant: 80).isActive = true
        opacitySlider.widthAnchor.constraint(equalToConstant: 80).isActive = true
        fontPopup.widthAnchor.constraint(equalToConstant: 150).isActive = true
        widthLabel.font = NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular)

        selContents.placeholderString = "コメント / 内容"
        selContents.target = self
        selContents.action = #selector(contentsChanged)
        selContents.controlSize = .small
        selContents.widthAnchor.constraint(equalToConstant: 160).isActive = true
        selTitle.font = NSFont.systemFont(ofSize: 11, weight: .semibold)
        let del = NSButton(title: "削除", target: self, action: #selector(deleteSelected))
        let edit = NSButton(title: "編集…", target: self, action: #selector(editSelected))
        for b in [del, edit] { b.controlSize = .small; b.bezelStyle = .rounded }
        selBox.orientation = .horizontal
        selBox.alignment = .centerY
        selBox.spacing = 6
        [selTitle, selContents, edit, del].forEach { selBox.addArrangedSubview($0) }

        [toolLabel,
         group(strokeGroup, "線の色", [strokeWell]),
         group(fillGroup, "塗り", [fillWell, noFill]),
         group(textGroup, "文字色", [textWell]),
         group(highlightGroup, "ハイライト", [highlightWell]),
         group(widthGroup, "線の太さ", [widthSlider, widthLabel]),
         group(opacityGroup, "不透明度", [opacitySlider]),
         group(fontGroup, "フォント", [fontPopup, fontSize, NSTextField(labelWithString: "pt")]),
         selBox].forEach { stack.addArrangedSubview($0) }
        // 狭いときは後ろから隠す（選択中の注釈の操作は残す）
        for (k, g) in [fontGroup, opacityGroup, widthGroup, highlightGroup, textGroup, fillGroup].enumerated() {
            stack.setVisibilityPriority(NSStackView.VisibilityPriority(rawValue: 300 + Float(k) * 50), for: g)
        }

        let bg = NSVisualEffectView()
        bg.material = .titlebar
        bg.blendingMode = .withinWindow
        bg.translatesAutoresizingMaskIntoConstraints = false
        stack.translatesAutoresizingMaskIntoConstraints = false
        let line = NSBox()
        line.boxType = .separator
        line.translatesAutoresizingMaskIntoConstraints = false
        v.addSubview(bg)
        v.addSubview(stack)
        v.addSubview(line)
        NSLayoutConstraint.activate([
            bg.topAnchor.constraint(equalTo: v.topAnchor), bg.bottomAnchor.constraint(equalTo: v.bottomAnchor),
            bg.leadingAnchor.constraint(equalTo: v.leadingAnchor), bg.trailingAnchor.constraint(equalTo: v.trailingAnchor),
            stack.topAnchor.constraint(equalTo: v.topAnchor),
            stack.bottomAnchor.constraint(equalTo: v.bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: v.leadingAnchor),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: v.trailingAnchor),
            line.leadingAnchor.constraint(equalTo: v.leadingAnchor), line.trailingAnchor.constraint(equalTo: v.trailingAnchor),
            line.bottomAnchor.constraint(equalTo: v.bottomAnchor)
        ])
        stack.setClippingResistancePriority(.defaultLow, for: .horizontal)
        view = v
    }

    /// ツール・選択中の注釈に合わせて、書式バーに出すものを決める
    private func updateGroups() {
        guard let editor else { return }
        var kind: String
        if let a = editor.selectedAnnotation {
            if ImageStamp.isImageStamp(a) { kind = "image" }
            else if Measure.group(of: a) != nil { kind = "measure" }
            else { kind = a.type ?? "" }
        } else {
            switch editor.tool {
            case .ink, .line, .arrow, .underline, .strikeout: kind = "Line"
            case .rect, .ellipse: kind = "Square"
            case .text, .formText, .formChoice: kind = "FreeText"
            case .highlight: kind = "Highlight"
            case .measureDistance, .measurePerimeter, .measureArea: kind = "measure"
            case .image, .signature, .stamp: kind = "image"
            default: kind = ""
            }
        }
        let shape = ["Line", "Ink", "Square", "Circle", "measure", "Underline", "StrikeOut"].contains(kind)
        strokeGroup.isHidden = !shape && kind != "Widget"
        fillGroup.isHidden = !(kind == "Square" || kind == "Circle" || kind == "FreeText" || kind == "Widget")
        textGroup.isHidden = !(kind == "FreeText" || kind == "Widget")
        highlightGroup.isHidden = kind != "Highlight"
        widthGroup.isHidden = !(kind == "Line" || kind == "Ink" || kind == "Square" || kind == "Circle" || kind == "measure")
        opacityGroup.isHidden = kind.isEmpty || kind == "Widget" || kind == "measure" || kind == "Link"
        fontGroup.isHidden = !(kind == "FreeText" || kind == "Widget")
    }

    func configure() {
        let s = editor.settings
        strokeWell.color = s.strokeColor
        fillWell.color = s.fillColor ?? .white
        noFill.state = s.fillColor == nil ? .on : .off
        highlightWell.color = s.highlightColor
        textWell.color = s.textColor
        widthSlider.doubleValue = Double(s.lineWidth)
        widthLabel.stringValue = String(format: "%.1f", s.lineWidth)
        opacitySlider.doubleValue = Double(s.opacity)
        if let i = ToolSettings.fonts.firstIndex(where: { $0.1 == s.fontName }) { fontPopup.selectItem(at: i) }
        fontSize.stringValue = FormBuilder.format(Double(s.fontSize))
        let nc = NotificationCenter.default
        nc.addObserver(self, selector: #selector(refresh), name: .studioToolChanged, object: editor)
        nc.addObserver(self, selector: #selector(refresh), name: .studioSelectionChanged, object: editor)
        refresh()
    }

    private static let hints: [Tool: String] = [
        .select: "注釈をクリックで選択、ドラッグで移動、右下の□でサイズ変更。ダブルクリックで内容を編集。⌥+クリックでフォーム/リンクも選択。",
        .hand: "ドラッグで表示をスクロールします。",
        .measureDistance: "2 点間をドラッグして距離を測ります（Shift で 45° 単位）。縮尺は「文書 > 測定の縮尺」で設定します。",
        .measurePerimeter: "クリックで頂点を追加し、ダブルクリックか Enter で確定します（Backspace で 1 つ戻る、Esc で中止）。",
        .measureArea: "クリックで頂点を追加し、ダブルクリックか Enter で囲んで面積を測ります（Backspace で 1 つ戻る、Esc で中止）。",
        .highlight: "文字をドラッグして選択するとハイライトされます。",
        .underline: "文字をドラッグして選択すると下線が引かれます。",
        .strikeout: "文字をドラッグして選択すると取り消し線が引かれます。",
        .note: "クリックした位置に付箋を貼ります。",
        .text: "クリックまたはドラッグで範囲を決めて文字を入力します。",
        .editText: "書き換えたい行をクリックします。元の文字を白で覆い、新しい文字を配置します。",
        .ink: "ドラッグで自由に描きます。",
        .rect: "ドラッグで矩形を描きます（Shiftで正方形）。",
        .ellipse: "ドラッグで楕円を描きます（Shiftで正円）。",
        .line: "ドラッグで直線を引きます（Shiftで45°単位）。",
        .arrow: "ドラッグで矢印を引きます（Shiftで45°単位）。",
        .image: "クリックした位置に画像を配置します。",
        .signature: "クリックして署名を選ぶか、新しく作成します。",
        .stamp: "クリックしてスタンプ・印鑑を選びます。",
        .redact: "隠したい範囲をドラッグしてマークし、「文書 > 墨消しを適用」で確定します。",
        .crop: "残したい範囲をドラッグします。",
        .link: "リンク範囲をドラッグし、URL またはページ番号を指定します。",
        .formText: "入力欄にしたい範囲をドラッグします。",
        .formCheckbox: "クリックまたはドラッグでチェックボックスを置きます。",
        .formChoice: "ドロップダウンにしたい範囲をドラッグします。",
        .eraser: "クリックした注釈を削除します。"
    ]

    @objc func refresh() {
        guard let editor else { return }
        toolLabel.stringValue = editor.tool.title
        hint.stringValue = Self.hints[editor.tool] ?? ""
        // 使い方の説明はツール名の上にマウスを置くと出る
        toolLabel.toolTip = Self.hints[editor.tool]
        updateGroups()
        // 開き直した画像スタンプは、不透明度を変えられない（元の画像が手元にない）
        opacitySlider.isEnabled = editor.selectedAnnotation.map { !ImageStamp.isImageStamp($0) || ImageStamp.canChangeOpacity($0) } ?? true
        if let a = editor.selectedAnnotation, ImageStamp.canChangeOpacity(a) { opacitySlider.doubleValue = Double(ImageStamp.opacity(a)) }
        if let a = editor.selectedAnnotation {
            selBox.isHidden = false
            selTitle.stringValue = a.studioKindName
            I18n.raw { selContents.stringValue = (a.type == "Widget" ? a.fieldName : a.contents) ?? "" }
            if a.type == "FreeText" {
                if let f = a.font, let i = ToolSettings.fonts.firstIndex(where: { $0.1 == f.fontName }) { fontPopup.selectItem(at: i) }
                if let f = a.font { fontSize.stringValue = FormBuilder.format(Double(f.pointSize)) }
            }
        } else {
            selBox.isHidden = true
        }
    }

    @objc private func colorChanged(_ sender: Any) {
        let s = editor.settings
        s.strokeColor = strokeWell.color
        s.fillColor = noFill.state == .on ? nil : fillWell.color
        s.highlightColor = highlightWell.color
        s.textColor = textWell.color
        let changed = sender as AnyObject
        editor.modifySelected { a in
            switch a.type ?? "" {
            case "FreeText":
                if changed === textWell { a.fontColor = s.textColor.withAlphaComponent(s.opacity) }
                if changed === fillWell || changed === noFill { a.color = s.fill() ?? .clear }
            case "Highlight":
                if changed === highlightWell || changed === strokeWell { a.color = (changed === highlightWell ? s.highlightColor : s.strokeColor).withAlphaComponent(0.5) }
            case "Square", "Circle":
                if changed === strokeWell { a.color = s.stroke() }
                if changed === fillWell || changed === noFill { a.interiorColor = s.fill() }
            case "Line":
                if changed === strokeWell { a.color = s.stroke(); a.interiorColor = s.stroke() }
            case "Widget":
                if changed === fillWell { a.backgroundColor = s.fillColor }
                if changed === textWell { a.fontColor = s.textColor }
                if changed === strokeWell { a.color = s.strokeColor }
            default:
                if changed === strokeWell { a.color = s.stroke() }
            }
        }
    }

    @objc private func widthChanged() {
        let w = CGFloat(widthSlider.doubleValue)
        editor.settings.lineWidth = w
        widthLabel.stringValue = String(format: "%.1f", w)
        editor.modifySelected { a in
            guard ["Square", "Circle", "Line", "Ink"].contains(a.type ?? "") else { return }
            let b = a.border ?? PDFBorder()
            b.lineWidth = w
            a.border = b
        }
    }

    @objc private func opacityChanged() {
        let o = CGFloat(opacitySlider.doubleValue)
        editor.settings.opacity = o
        if let sel = editor.selectedAnnotation, ImageStamp.isImageStamp(sel) {
            if let n = ImageStamp.withOpacity(sel, o) { editor.replace(sel, with: n, name: "不透明度") }
            return
        }
        editor.modifySelected { a in
            if a.type != "FreeText" { a.color = a.color.withAlphaComponent(o) }
            if a.type == "FreeText", let c = a.fontColor { a.fontColor = c.withAlphaComponent(o) }
        }
    }

    @objc private func fontChanged() {
        guard let ps = fontPopup.selectedItem?.representedObject as? String else { return }
        editor.settings.fontName = ps
        applyFont()
    }

    func controlTextDidEndEditing(_ obj: Notification) {
        guard (obj.object as? NSTextField) === fontSize, let v = fontSize.doubleValueOrNil, v > 1, v < 500 else { return }
        editor.settings.fontSize = CGFloat(v)
        applyFont()
    }

    private func applyFont() {
        let font = editor.settings.font
        editor.modifySelected { a in
            if a.type == "FreeText" || a.type == "Widget" { a.font = font }
        }
    }

    @objc private func contentsChanged() {
        editor.modifySelected { a in
            if a.type == "Widget" { a.fieldName = selContents.stringValue } else { a.contents = selContents.stringValue }
        }
        NotificationCenter.default.post(name: .studioAnnotationsChanged, object: editor)
    }

    @objc private func deleteSelected() {
        if let a = editor.selectedAnnotation { editor.removeWithGroup(a) }
    }

    @objc private func editSelected() {
        if let a = editor.selectedAnnotation { editor.editContents(of: a) }
    }
}

extension NSBox {
    static func separator() -> NSBox {
        let b = NSBox()
        b.boxType = .separator
        b.widthAnchor.constraint(equalToConstant: 210).isActive = true
        return b
    }
}
