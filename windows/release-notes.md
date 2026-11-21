## PDF Studio 1.5.24

- TIFF を開いて見ただけのときは、異常終了時の写しを作らないようにしました（1.5.23 では、見ただけの TIFF でも写しを作っていたため、大きな図面で動きが重くなることがあり、正しく終了しなかったときに復元を聞いていました）。書き込みをしたときだけ写しを作ります
- 起動時に前回のファイルを開くとき、つながらないネットワークドライブなどにあるファイルで起動が止まらないようにしました（つながらない場所のファイルはその回は開かず、次の起動でまた試します。3 回続けて開けなければ、前回のファイルから外します）
- 前回のファイルを開いている途中（大きな図面の読み込み中など）にアプリを閉じたり、正しく終了しなかったりしても、次の起動で開くファイルから消えないようにしました

**インストール版**：`PDF-Studio-Setup-1.5.24.exe` をダウンロードし、PDF Studio を閉じてから実行してください。
**インストール不要版**：`PDF-Studio-1.5.24-win.zip` をダウンロードして展開し、中の `PDF Studio.exe` を起動してください。

---

- Opening a TIFF just to view it no longer creates a crash-recovery backup (1.5.23 did, which could slow down large drawings and ask to restore them after an unclean exit). A backup is made only after you edit it.
- Reopening previous files at startup no longer hangs on files on unreachable network drives (files there are skipped and tried again at the next start, up to 3 times).
- Files that were still loading when the app was closed (or did not close properly) are no longer dropped from the files reopened at the next start.

---

- การเปิดไฟล์ TIFF เพื่อดูอย่างเดียวจะไม่สร้างสำเนาสำรองอีกต่อไป จะสร้างเมื่อมีการแก้ไขเท่านั้น
- การเปิดไฟล์ครั้งก่อนเมื่อเริ่มโปรแกรม จะไม่ค้างเพราะไฟล์บนไดรฟ์เครือข่ายที่เชื่อมต่อไม่ได้ (จะลองเปิดอีกครั้งในการเริ่มครั้งถัดไป สูงสุด 3 ครั้ง)
