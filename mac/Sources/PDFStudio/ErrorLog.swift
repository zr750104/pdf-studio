import AppKit

/// 不具合の記録と報告（Windows 版と同じ考え方）。
/// エラーは Mac の中のログ（~/Library/Application Support/PDFStudio/errors.log）に記録し、
/// 報告するときは GitHub の報告ページを下書き入りで開く（送信前にブラウザで確認できる）。
/// ユーザー名・パス・ファイル名・メールアドレスは伏せる。PDF の中身は送らない。
enum ErrorLog {
    static let issuesURL = "https://github.com/zr750104/pdf-studio/issues/new"
    static let maxBody = 5500
    private static let maxLog = 200_000
    private static let promptKey = "PDFStudioErrorPrompt"
    private static let runningKey = "PDFStudioRunning"
    private static var promptedThisSession = false
    static var isSelftest = false

    /// 自動テストでは、ユーザーのログに書かない
    static var overrideURL: URL?

    static var logURL: URL {
        if let o = overrideURL { return o }
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let dir = base.appendingPathComponent("PDFStudio", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("errors.log")
    }

    static var promptEnabled: Bool {
        get { UserDefaults.standard.object(forKey: promptKey) as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: promptKey) }
    }

    /// 個人情報を伏せる（ユーザー名を含むパス・PDF などのファイル名・メールアドレス）
    static func sanitize(_ s: String) -> String {
        var out = s
        let ext = "(pdf|tiff?|png|jpe?g|docx?|xlsx?|txt|csv|html?|rtf)"
        func re(_ p: String, _ rep: String) {
            guard let r = try? NSRegularExpression(pattern: p, options: [.caseInsensitive]) else { return }
            out = r.stringByReplacingMatches(in: out, range: NSRange(out.startIndex..., in: out), withTemplate: rep)
        }
        // 引用符の中（ファイル名・文書名が入ることが多い）は伏せる
        re("[“\"]([^”\"\\n]{1,200})[”\"]", "\"<name>\"")
        re("[‘']([^’'\\n]{1,200})[’']", "'<name>'")
        // フォルダから始まるパスは、空白を含むファイル名ごと伏せる
        re("(?<![\\w:/])~?/[^\\n\"'<>|*?:]*?\\.\(ext)\\b", "<path>.$1")
        re("/Volumes/[^/\\n]+", "/Volumes/<volume>")
        // 拡張子の付いた名前（一覧にない拡張子も）
        re("[^\\\\/\\s\"'()<>]+\\.\(ext)\\b", "<file>.$1")
        re("[^\\\\/\\s\"'()<>:]+\\.(pptx?|heic|key|pages|numbers|zip|gif|bmp|webp|odt|ods|odp|md|json|xml|eml|msg)\\b", "<file>.$1")
        let home = NSHomeDirectory()
        if !home.isEmpty { out = out.replacingOccurrences(of: home, with: "~") }
        let user = NSUserName()
        if user.count > 2 { re(NSRegularExpression.escapedPattern(for: user), "<user>") }
        re("/Users/[^/\\s]+", "/Users/<user>")
        re("[\\w.+-]+@[\\w-]+\\.[\\w.-]+", "<email>")
        return out
    }

    /// エラーを 1 件記録する。prompt = true なら報告をすすめる（1 回の起動につき 1 度）
    static func record(_ source: String, _ message: String, prompt: Bool = true) {
        let f = ISO8601DateFormatter()
        let line = "[\(f.string(from: Date()))] (\(source)) \(sanitize(message))\n"
        let url = logURL
        if let h = try? FileHandle(forWritingTo: url) {
            h.seekToEndOfFile()
            h.write(Data(line.utf8))
            try? h.close()
        } else {
            try? Data(line.utf8).write(to: url)
        }
        // 大きくなりすぎたら古い半分を消す
        if let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size > maxLog,
           let text = try? String(contentsOf: url, encoding: .utf8) {
            try? String(text.suffix(text.count / 2)).write(to: url, atomically: true, encoding: .utf8)
        }
        if prompt { maybePrompt() }
    }

    static func readLog() -> String { (try? String(contentsOf: logURL, encoding: .utf8)) ?? "" }

    /// 最近のエラー（古い順に最大 n 件）
    static func recentEntries(_ n: Int = 10) -> [String] {
        let text = readLog()
        guard let r = try? NSRegularExpression(pattern: "\\n(?=\\[\\d{4}-)") else { return [] }
        let marked = r.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text), withTemplate: "\n\u{1}")
        return marked.components(separatedBy: "\n\u{1}").filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }.suffix(n).map { $0 }
    }

    static func environment() -> String {
        let v = ProcessInfo.processInfo.operatingSystemVersion
        var arch = "arm64"
        #if arch(x86_64)
        arch = "x86_64"
        #endif
        return ["- PDF Studio for Mac: \(UpdateCheck.currentVersion)",
                "- macOS: \(v.majorVersion).\(v.minorVersion).\(v.patchVersion) (\(arch))",
                "- 言語 / Language: \(I18n.lang)"].joined(separator: "\n")
    }

    static func buildBody() -> String {
        let head = "## 状況 / What happened\n（どの操作で起きたか書いてください / Please describe what you were doing）\n\n## 環境 / Environment\n\(environment())\n\n## エラーログ / Error log\n"
        var entries = recentEntries(10)
        func fence(_ list: [String]) -> String {
            let t = list.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            return "```\n\(t.isEmpty ? "(no errors recorded)" : t)\n```\n"
        }
        // URL に収まるよう、古いものから減らす
        while entries.count > 1, (head + fence(entries)).count > maxBody { entries.removeFirst() }
        var log = fence(entries)
        if (head + log).count > maxBody, let last = entries.last { log = fence([String(last.suffix(maxBody - head.count - 20))]) }
        return head + log
    }

    /// 報告ページの URL（下書き入り）
    static func reportURL() -> URL? {
        let title = recentEntries(1).first.map { e -> String in
            let s = e.replacingOccurrences(of: "^\\[[^\\]]+\\]\\s*\\([^)]+\\)\\s*", with: "", options: .regularExpression)
            return String(s.split(separator: "\n").first ?? "").prefix(80).description
        } ?? ""
        var c = URLComponents(string: issuesURL)
        c?.queryItems = [URLQueryItem(name: "title", value: "[Mac \(UpdateCheck.currentVersion)] \(title.isEmpty ? L("不具合の報告") : title)"),
                         URLQueryItem(name: "body", value: buildBody()),
                         URLQueryItem(name: "labels", value: "bug")]
        return c?.url
    }

    /// 不具合を報告：内容を見せてから、GitHub の報告ページを下書き入りで開く
    static func report() {
        let body = buildBody()
        let a = NSAlert()
        a.messageText = "不具合を開発者に報告します"
        a.informativeText = "次の内容を GitHub の報告ページ（公開）に下書きとして入れます。送信前にブラウザで内容を確認・編集でき、送信には GitHub のアカウントが必要です。ユーザー名やファイル名は伏せてあり、PDF の中身は送りません。"
        // 送る内容は全部見せる（ブラウザで開いた時点で GitHub に渡るため）
        let scroll = NSTextView.scrollableTextView()
        scroll.frame = NSRect(x: 0, y: 0, width: 520, height: 280)
        if let tv = scroll.documentView as? NSTextView {
            tv.isEditable = false
            tv.font = NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)
            I18n.raw { tv.string = body }
        }
        a.accessoryView = scroll
        a.addButton(withTitle: "ブラウザで報告ページを開く")
        a.addButton(withTitle: "内容をコピー")
        a.addButton(withTitle: "ログのフォルダを開く")
        a.addButton(withTitle: "キャンセル")
        switch a.runModal() {
        case .alertFirstButtonReturn:
            if let u = reportURL(), !isSelftest { NSWorkspace.shared.open(u) }
        case .alertSecondButtonReturn:
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(body, forType: .string)
        case .alertThirdButtonReturn:
            if !isSelftest { NSWorkspace.shared.activateFileViewerSelecting([logURL]) }
        default: break
        }
    }

    /// エラーが起きたら（1 回の起動につき 1 度だけ）報告をすすめる
    static func maybePrompt() {
        guard !promptedThisSession, !isSelftest, promptEnabled else { return }
        promptedThisSession = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
            let a = NSAlert()
            a.alertStyle = .warning
            a.messageText = "問題が発生しました"
            a.informativeText = "エラーの内容は PC 内のログに記録しました。開発者に報告すると改善に役立ちます。報告する内容は送信前に確認できます。"
            a.addButton(withTitle: "報告する...")
            a.addButton(withTitle: "今回は報告しない")
            a.showsSuppressionButton = true
            a.suppressionButton?.title = "今後はこの確認を表示しない（ヘルプ メニューからいつでも報告できます）"
            let r = a.runModal()
            if a.suppressionButton?.state == .on { promptEnabled = false }
            if r == .alertFirstButtonReturn { report() }
        }
    }

    // MARK: - 予期しない終了

    /// 起動時：例外を記録する仕組みを入れ、前回が予期せず終了していたら知らせる
    static func startSession() {
        NSSetUncaughtExceptionHandler { e in
            ErrorLog.record("exception", "\(e.name.rawValue): \(e.reason ?? "")\n\(e.callStackSymbols.prefix(12).joined(separator: "\n"))", prompt: false)
        }
        let crashed = UserDefaults.standard.bool(forKey: runningKey)
        UserDefaults.standard.set(true, forKey: runningKey)
        if crashed {
            record("crash", "The previous session ended unexpectedly", prompt: true)
        }
    }

    /// 正常に終了したとき
    static func endSession() { UserDefaults.standard.set(false, forKey: runningKey) }
}
