import AppKit
import ObjectiveC

// 表示言語（日本語 / 英語 / タイ語）
// 原文は日本語。訳は Resources/i18n の <言語>.json（Windows 版と共通）と mac-<言語>.json（Mac 版だけの文字列）。
// 日本語の文字列をキーにして訳す。ボタン・メニュー・ラベル・ダイアログなどは、文字が設定されたときに自動で訳す（I18n.install）。
// ユーザーの文字（注釈の内容・ファイル名・検索結果など）は I18n.raw { } の中で設定して、訳さないようにする。

enum I18n {
    static let langs = ["ja", "en", "th"]
    static let names = ["ja": "日本語", "en": "English", "th": "ไทย"]
    private static let defaultsKey = "PDFStudioLanguage"

    /// 今の表示言語。言語を選んでいなければ英語
    static let lang: String = {
        if let env = ProcessInfo.processInfo.environment["PDFSTUDIO_LANG"], langs.contains(env) { return env }
        if let saved = UserDefaults.standard.string(forKey: defaultsKey), langs.contains(saved) { return saved }
        return "en"
    }()

    /// メニューで選んだ言語（保存されていなければ nil）
    static var savedLang: String? { UserDefaults.standard.string(forKey: defaultsKey) }

    static func save(_ l: String) { UserDefaults.standard.set(l, forKey: defaultsKey) }

    private struct Dict {
        var strings: [String: String] = [:]
        var patterns: [(NSRegularExpression, String)] = []
    }

    private static let JP = try! NSRegularExpression(pattern: "[\\u3040-\\u30ff\\u3400-\\u9fff\\uff01-\\uff5e]")

    private static let dicts: [String: Dict] = {
        var out: [String: Dict] = [:]
        for l in langs.dropFirst() {
            var d = Dict()
            // Mac 版だけの訳を先に読み、同じキーは Mac 版の訳を優先する
            for file in ["mac-\(l)", l] {
                guard let url = resourceURL(file),
                      let data = try? Data(contentsOf: url),
                      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
                for (k, v) in (json["strings"] as? [String: String]) ?? [:] where d.strings[k] == nil { d.strings[k] = v }
                for p in (json["patterns"] as? [[String]]) ?? [] where p.count == 2 {
                    if let re = try? NSRegularExpression(pattern: p[0], options: [.dotMatchesLineSeparators]) { d.patterns.append((re, p[1])) }
                }
            }
            out[l] = d
        }
        return out
    }()

    /// 訳のファイルの場所（アプリの中、または開発時の Sources の中）
    private static func resourceURL(_ name: String) -> URL? {
        // アプリ（PDF Studio.app/Contents/Resources/i18n）。開発時のビルドでは Bundle.module。
        // Bundle.module は見つからないと止まるので、アプリの中に無いときだけ使う
        if let u = Bundle.main.url(forResource: name, withExtension: "json", subdirectory: "i18n") { return u }
        if Bundle.main.bundleURL.pathExtension == "app" { return nil }
        return Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "i18n")
    }

    /// 訳が見つからなかった文字列（自動テストで確認する）
    static var missing = Set<String>()
    private static var rawDepth = 0
    static var isRaw: Bool { rawDepth > 0 }

    /// この中で設定した文字は訳さない（ユーザーの文字・ファイル名など）
    @discardableResult
    static func raw<T>(_ body: () throws -> T) rethrows -> T {
        rawDepth += 1
        defer { rawDepth -= 1 }
        return try body()
    }

    static func hasJapanese(_ s: String) -> Bool {
        JP.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
    }

    /// 日本語の文字列を、今の表示言語にする
    static func t(_ s: String) -> String {
        lang == "ja" ? s : tr(s, lang)
    }

    /// 日本語の文字列を、言語 l の訳にする（見つからなければそのまま）
    static func tr(_ s: String, _ l: String, record: Bool = true) -> String {
        guard let d = dicts[l], hasJapanese(s) else { return s }
        if let hit = d.strings[s] { return hit }
        let trimmed = s.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed != s, let h = d.strings[trimmed] { return s.replacingOccurrences(of: trimmed, with: h) }
        // メニューのツール名などに付けた「\tキー」は分けて訳す
        if let tab = s.firstIndex(of: "\t") {
            return tr(String(s[..<tab]), l, record: record) + String(s[tab...])
        }
        let ns = s as NSString
        for (re, rep) in d.patterns {
            guard let m = re.firstMatch(in: s, range: NSRange(location: 0, length: ns.length)) else { continue }
            var out = ""
            var i = rep.startIndex
            while i < rep.endIndex {
                let c = rep[i]
                let next = rep.index(after: i)
                if c == "$", next < rep.endIndex, let k = Int(String(rep[next])) {
                    let r = k < m.numberOfRanges ? m.range(at: k) : NSRange(location: NSNotFound, length: 0)
                    out += tr(r.location == NSNotFound ? "" : ns.substring(with: r), l, record: record)
                    i = rep.index(after: next)
                } else {
                    out.append(c)
                    i = next
                }
            }
            return out
        }
        if s.contains("\n") { return s.components(separatedBy: "\n").map { tr($0, l, record: record) }.joined(separator: "\n") }
        // 記録は画面の処理（メインスレッド）だけ。一括処理などのほかのスレッドから同時に書かない
        if record, Thread.isMainThread { missing.insert(s) }
        return s
    }

    /// 自動で訳す文字（ユーザーの文字を設定している最中は訳さない）
    static func auto(_ s: String?) -> String? {
        guard let s, lang != "ja", !isRaw else { return s }
        return t(s)
    }

    // MARK: - 文字が設定されたときに自動で訳す

    private static var installed = false

    static func install() {
        guard lang != "ja", !installed else { return }
        installed = true
        swizzle(NSTextField.self, #selector(setter: NSTextField.stringValue), #selector(NSTextField.i18n_setStringValue(_:)))
        swizzle(NSTextField.self, #selector(setter: NSTextField.placeholderString), #selector(NSTextField.i18n_setPlaceholderString(_:)))
        swizzle(NSButton.self, #selector(setter: NSButton.title), #selector(NSButton.i18n_setTitle(_:)))
        swizzle(NSButton.self, #selector(setter: NSButton.alternateTitle), #selector(NSButton.i18n_setAlternateTitle(_:)))
        swizzle(NSView.self, #selector(setter: NSView.toolTip), #selector(NSView.i18n_setToolTip(_:)))
        swizzle(NSMenuItem.self, #selector(setter: NSMenuItem.title), #selector(NSMenuItem.i18n_setTitle(_:)))
        swizzle(NSMenuItem.self, #selector(NSMenuItem.init(title:action:keyEquivalent:)), #selector(NSMenuItem.i18n_init(title:action:keyEquivalent:)))
        swizzle(NSMenu.self, #selector(NSMenu.init(title:)), #selector(NSMenu.i18n_init(title:)))
        swizzle(NSAlert.self, #selector(setter: NSAlert.messageText), #selector(NSAlert.i18n_setMessageText(_:)))
        swizzle(NSAlert.self, #selector(setter: NSAlert.informativeText), #selector(NSAlert.i18n_setInformativeText(_:)))
        swizzle(NSAlert.self, #selector(NSAlert.addButton(withTitle:)), #selector(NSAlert.i18n_addButton(withTitle:)))
        swizzle(NSSavePanel.self, #selector(setter: NSSavePanel.message), #selector(NSSavePanel.i18n_setMessage(_:)))
        swizzle(NSSavePanel.self, #selector(setter: NSSavePanel.prompt), #selector(NSSavePanel.i18n_setPrompt(_:)))
        swizzle(NSSegmentedControl.self, #selector(NSSegmentedControl.setLabel(_:forSegment:)), #selector(NSSegmentedControl.i18n_setLabel(_:forSegment:)))
        swizzle(NSSegmentedControl.self, #selector(NSSegmentedControl.setToolTip(_:forSegment:)), #selector(NSSegmentedControl.i18n_setToolTip(_:forSegment:)))
        swizzle(NSTabViewItem.self, #selector(setter: NSTabViewItem.label), #selector(NSTabViewItem.i18n_setLabel(_:)))
        swizzle(NSBox.self, #selector(setter: NSBox.title), #selector(NSBox.i18n_setTitle(_:)))
        swizzle(NSTableColumn.self, #selector(setter: NSTableColumn.title), #selector(NSTableColumn.i18n_setTitle(_:)))
        swizzle(NSWindow.self, #selector(setter: NSWindow.title), #selector(NSWindow.i18n_setTitle(_:)))
    }

    private static func swizzle(_ cls: AnyClass, _ original: Selector, _ replacement: Selector) {
        guard let o = class_getInstanceMethod(cls, original), let n = class_getInstanceMethod(cls, replacement) else {
            NSLog("I18n: swizzle failed \(cls) \(original)")
            return
        }
        if class_addMethod(cls, original, method_getImplementation(n), method_getTypeEncoding(n)) {
            class_replaceMethod(cls, replacement, method_getImplementation(o), method_getTypeEncoding(o))
        } else {
            method_exchangeImplementations(o, n)
        }
    }
}

/// 日本語の文字列を今の表示言語にする（文字が自動で訳されない場所で使う）
func L(_ s: String) -> String { I18n.t(s) }

// 入れ替えた実装の中では、名前の入れ替わった元のメソッド（i18n_…）を呼ぶと元の処理になる
extension NSTextField {
    @objc func i18n_setStringValue(_ s: String) {
        // 入力欄の中身はユーザーの文字なので訳さない（ラベルだけ訳す）
        i18n_setStringValue(isEditable ? s : (I18n.auto(s) ?? s))
    }
    @objc func i18n_setPlaceholderString(_ s: String?) { i18n_setPlaceholderString(I18n.auto(s)) }
}

extension NSButton {
    @objc func i18n_setTitle(_ s: String) { i18n_setTitle(I18n.auto(s) ?? s) }
    @objc func i18n_setAlternateTitle(_ s: String) { i18n_setAlternateTitle(I18n.auto(s) ?? s) }
}

extension NSView {
    @objc func i18n_setToolTip(_ s: String?) { i18n_setToolTip(I18n.auto(s)) }
}

extension NSMenuItem {
    @objc func i18n_setTitle(_ s: String) { i18n_setTitle(I18n.auto(s) ?? s) }
    @objc func i18n_init(title: String, action: Selector?, keyEquivalent: String) -> NSMenuItem {
        i18n_init(title: I18n.auto(title) ?? title, action: action, keyEquivalent: keyEquivalent)
    }
}

extension NSMenu {
    @objc func i18n_init(title: String) -> NSMenu { i18n_init(title: I18n.auto(title) ?? title) }
}

extension NSAlert {
    @objc func i18n_setMessageText(_ s: String) { i18n_setMessageText(I18n.auto(s) ?? s) }
    @objc func i18n_setInformativeText(_ s: String) { i18n_setInformativeText(I18n.auto(s) ?? s) }
    @objc func i18n_addButton(withTitle s: String) -> NSButton { i18n_addButton(withTitle: I18n.auto(s) ?? s) }
}

extension NSSavePanel {
    @objc func i18n_setMessage(_ s: String?) { i18n_setMessage(I18n.auto(s)) }
    @objc func i18n_setPrompt(_ s: String?) { i18n_setPrompt(I18n.auto(s)) }
}

extension NSSegmentedControl {
    @objc func i18n_setLabel(_ s: String, forSegment i: Int) { i18n_setLabel(I18n.auto(s) ?? s, forSegment: i) }
    @objc func i18n_setToolTip(_ s: String?, forSegment i: Int) { i18n_setToolTip(I18n.auto(s), forSegment: i) }
}

extension NSTabViewItem {
    @objc func i18n_setLabel(_ s: String) { i18n_setLabel(I18n.auto(s) ?? s) }
}

extension NSBox {
    @objc func i18n_setTitle(_ s: String) { i18n_setTitle(I18n.auto(s) ?? s) }
}

extension NSTableColumn {
    @objc func i18n_setTitle(_ s: String) { i18n_setTitle(I18n.auto(s) ?? s) }
}

extension NSWindow {
    /// ウィンドウの題名。文書のウィンドウはファイル名なので、辞書にそのまま載っている文字だけ訳す
    @objc func i18n_setTitle(_ s: String) {
        guard let auto = I18n.auto(s), auto != s, !(self.windowController?.document != nil) else { i18n_setTitle(s); return }
        i18n_setTitle(auto)
    }
}
