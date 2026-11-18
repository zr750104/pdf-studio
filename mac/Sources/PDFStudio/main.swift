import AppKit

// Mac が用意する文字（保存の確認・取り消しなど）も表示言語にする（アプリの文字を読む前に決める）
UserDefaults.standard.setVolatileDomain(["AppleLanguages": [I18n.lang]], forName: UserDefaults.argumentDomain)
UserDefaults.standard.removeObject(forKey: "AppleLanguages")   // 以前の版で保存したものを消す
// 画面の文字を表示言語に訳す仕組み（メニューやウィンドウを作る前に入れる）
I18n.install()

// 最初に生成した NSDocumentController が共有インスタンスになる
_ = PDFStudioDocumentController()

if let i = CommandLine.arguments.firstIndex(of: "--snapshot"), i + 2 < CommandLine.arguments.count {
    SelfTest.snapshot(pdf: CommandLine.arguments[i + 1], png: CommandLine.arguments[i + 2])
    exit(0)
}

if CommandLine.arguments.contains("--selftest") {
    SelfTest.run()
    exit(0)
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
