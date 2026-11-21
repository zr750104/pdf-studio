## PDF Studio 1.5.26

- しおりを編集できるようにしました。左の「しおり」の欄の上のボタンで、今のページへのしおりの追加・名前の変更（ダブルクリックでも可）・削除・上下の並べ替え・1 段下げる／上げるができます。元に戻すこともできます
- 「ページ」メニューに「ページの大きさをそろえる」を付けました。A3・A4・B4 などの用紙を選ぶと、ページごとに縦横の向きはそのまま、縦横比を保って中央に収めます。注釈やリンクも一緒に動きます。「大きいページだけ縮める」も選べます
  - スキャンした図面のページは、画像と用紙の縦横比がほぼ同じ（A3 判のスキャンを A4 にするなど）ときだけ表示の速さが保たれます。違うときは保存後の表示が遅くなるので、終わったときにお知らせします
  - 測定の注釈は、測った長さ（実寸）が変わらないように縮尺も一緒に直します。これから測るときは、縮尺を合わせ直してください
  - しおりを正しく読み取れない文書では、しおりの編集はできません（元のしおりを壊さないため）
- 動作の記録（ログ）に、アプリの置き場所や開いたファイルの場所（ユーザー名を含むことがあります）を書かないようにしました

**インストール版**：`PDF-Studio-Setup-1.5.26.exe` をダウンロードし、PDF Studio を閉じてから実行してください。
**インストール不要版**：`PDF-Studio-1.5.26-win.zip` をダウンロードして展開し、中の `PDF Studio.exe` を起動してください。

---

- Bookmarks can now be edited. Use the buttons above the Bookmarks panel to add a bookmark to the current page, rename (or double-click), delete, move up/down, and indent/outdent. Changes can be undone.
- Added Page > Normalize Page Size. Choose a paper size (A3, A4, B4, ...) and each page keeps its orientation and is scaled to fit and centered. Annotations and links move with it. "Only shrink larger pages" is available.
  - Scanned drawing pages keep fast display only when the image and paper aspect ratios almost match (e.g. an A3 scan to A4). Otherwise they display more slowly after saving; you are told when this happens.
  - Measurement annotations keep their real-world lengths (the scale is adjusted). Recalibrate the scale for new measurements.
  - Bookmarks cannot be edited in documents whose bookmarks this app cannot read correctly (to avoid damaging them).
- The activity log no longer records the app location or the paths of opened files (which can include your user name).

---

- แก้ไขบุ๊กมาร์กได้แล้ว (เพิ่ม เปลี่ยนชื่อ ลบ เลื่อนขึ้นลง เยื้องเข้าออก)
- เพิ่ม "ปรับขนาดหน้าให้เท่ากัน" ในเมนูหน้า (A3, A4, B4 ฯลฯ) คำอธิบายประกอบและลิงก์จะย้ายตามด้วย
- บันทึกการทำงานจะไม่บันทึกตำแหน่งของแอปหรือไฟล์ที่เปิดอีกต่อไป
