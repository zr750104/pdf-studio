## PDF Studio 1.5.23

- 「ファイル」メニューとようこそ画面に「最近使ったファイル」を付けました（最大 10 件）。インストール版では、タスクバーのアイコンの右クリック（ジャンプリスト）にも出ます
- 起動すると、前回開いていたファイルを、見ていたページと倍率のまま開くようにしました。ファイルを指定して起動したとき（ダブルクリックなど）は、そのファイルだけを開きます。「ファイル」→「最近使ったファイル」→「起動時に前回のファイルを開く」で切れます
- 編集中の文書の写しを時々保存しておき、アプリが正しく終了しなかったときは、次の起動で「復元する」かを聞くようにしました。復元した文書を保存するときは保存先を聞きます。パスワードで保護された文書は、写しも暗号化されたままです
- ファイルを開くのにかかった時間を記録するようにしました（ファイル名は記録しません）。開くのが遅いときの調査に使います

**インストール版**：`PDF-Studio-Setup-1.5.23.exe` をダウンロードし、PDF Studio を閉じてから実行してください。
**インストール不要版**：`PDF-Studio-1.5.23-win.zip` をダウンロードして展開し、中の `PDF Studio.exe` を起動してください。

---

- Added "Recent Files" to the File menu and the start screen (up to 10). The installer version also shows them in the taskbar jump list.
- On startup, the files you had open are reopened at the same page and zoom. When started with a file (e.g. double-click), only that file opens. Turn this off in File > Recent Files > Reopen Previous Files at Startup.
- Unsaved documents are backed up periodically. If PDF Studio does not close properly, you are asked whether to restore them at the next start (you choose where to save them). Password-protected documents stay encrypted.
- The time taken to open files is logged (without file names) to help investigate slow opening.

---

- เพิ่ม "ไฟล์ล่าสุด" ในเมนูไฟล์และหน้าจอเริ่มต้น (สูงสุด 10 ไฟล์)
- เมื่อเริ่มโปรแกรม จะเปิดไฟล์ที่เปิดไว้ครั้งก่อนที่หน้าและการซูมเดิม
- สำรองเอกสารที่ยังไม่ได้บันทึกเป็นระยะ หากโปรแกรมปิดไม่สมบูรณ์ จะถามว่าจะกู้คืนหรือไม่เมื่อเริ่มครั้งถัดไป
- บันทึกเวลาที่ใช้ในการเปิดไฟล์ (ไม่บันทึกชื่อไฟล์)
