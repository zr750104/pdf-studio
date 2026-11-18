import AppKit

/// 新しい版のお知らせ。GitHub の配布ページ（zr750104/pdf-studio）にある Mac 版（PDF-Studio-Mac-x.y.z.zip）を調べる。
/// 署名なしのアプリは自動で入れ替えられないので、お知らせしてダウンロードページを開くだけ。
/// 送るのはアプリ名だけ（個人の情報は送らない）。
enum UpdateCheck {
    static let releasesAPI = URL(string: "https://api.github.com/repos/zr750104/pdf-studio/releases?per_page=50")!
    static let releasesPage = URL(string: "https://github.com/zr750104/pdf-studio/releases")!
    private static let lastCheckKey = "PDFStudioUpdateLastCheck"
    private static let skipKey = "PDFStudioUpdateSkipVersion"

    static var currentVersion: String {
        (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? "0"
    }

    struct Found {
        let version: String
        let page: URL
    }

    /// "2.1.0" のような版を比べる
    static func isNewer(_ a: String, than b: String) -> Bool {
        let pa = a.split(separator: ".").map { Int($0) ?? 0 }, pb = b.split(separator: ".").map { Int($0) ?? 0 }
        for i in 0..<max(pa.count, pb.count) {
            let x = i < pa.count ? pa[i] : 0, y = i < pb.count ? pb[i] : 0
            if x != y { return x > y }
        }
        return false
    }

    /// 配布ページの一覧から、いちばん新しい Mac 版を探す
    static func newestMac(in json: Data) -> Found? {
        guard let list = try? JSONSerialization.jsonObject(with: json) as? [[String: Any]] else { return nil }
        let re = try! NSRegularExpression(pattern: "^PDF-Studio-Mac-(\\d+(?:\\.\\d+)*)\\.zip$")
        var best: Found?
        for r in list where (r["draft"] as? Bool) != true && (r["prerelease"] as? Bool) != true {
            let page = (r["html_url"] as? String).flatMap(URL.init(string:)) ?? releasesPage
            for a in (r["assets"] as? [[String: Any]]) ?? [] {
                guard let name = a["name"] as? String,
                      let m = re.firstMatch(in: name, range: NSRange(name.startIndex..., in: name)),
                      let vr = Range(m.range(at: 1), in: name) else { continue }
                let v = String(name[vr])
                if best == nil || isNewer(v, than: best!.version) { best = Found(version: v, page: page) }
            }
        }
        return best
    }

    /// 起動時の確認（1 日 1 回まで）
    static func checkAtLaunch() {
        let last = UserDefaults.standard.double(forKey: lastCheckKey)
        guard Date().timeIntervalSince1970 - last > 20 * 3600 else { return }
        check(manual: false)
    }

    /// manual = true（メニューから）のときは、最新でも結果を知らせる
    static func check(manual: Bool) {
        var req = URLRequest(url: releasesAPI, timeoutInterval: 15)
        req.setValue("PDF-Studio-Mac", forHTTPHeaderField: "User-Agent")
        req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        URLSession.shared.dataTask(with: req) { data, response, error in
            let ok = (response as? HTTPURLResponse)?.statusCode == 200
            let found = ok ? data.flatMap(newestMac(in:)) : nil
            DispatchQueue.main.async {
                if ok { UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: lastCheckKey) }
                guard ok else {
                    if manual { Dialog.alert("アップデートを確認できませんでした", "インターネットに接続できているか確認してください。") }
                    return
                }
                guard let f = found, isNewer(f.version, than: currentVersion) else {
                    if manual { Dialog.alert("最新のバージョンです", L("バージョン \(currentVersion)")) }
                    return
                }
                if !manual, UserDefaults.standard.string(forKey: skipKey) == f.version { return }
                let a = NSAlert()
                a.messageText = "新しいバージョン \(f.version) があります"
                a.informativeText = "ダウンロードページを開き、Mac 版の zip をダウンロードしてください。展開した PDF Studio を「アプリケーション」フォルダーに入れ替えると更新できます。"
                a.addButton(withTitle: "ダウンロードページを開く")
                a.addButton(withTitle: "あとで")
                if !manual { a.addButton(withTitle: "このバージョンはスキップ") }
                switch a.runModal() {
                case .alertFirstButtonReturn: NSWorkspace.shared.open(f.page)
                case .alertThirdButtonReturn: UserDefaults.standard.set(f.version, forKey: skipKey)
                default: break
                }
            }
        }.resume()
    }
}
