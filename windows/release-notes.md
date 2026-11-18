## PDF Studio 1.5.20

- 「ファイルから PDF を作成」「複数のファイルを結合」「ファイルからページを挿入」で、拡張子と中身が違う画像（中身が JPEG や WebP の .png など）も読み込めるようにしました（これまでは「The input is not a PNG file!」と出て作成できませんでした）
- 「ファイルから PDF を作成」で PowerPoint・Excel など対応していないファイルを選んだとき、文字化けしたページを作らず、PDF にできなかったファイルとして知らせるようにしました
- 最後のタブを閉じても PDF Studio が終了しないようにしました（空のタブが残ります）。終了するときはウィンドウの × で閉じてください（空のタブを閉じたときも終了します）

**インストール版**：`PDF-Studio-Setup-1.5.20.exe` をダウンロードし、PDF Studio を閉じてから実行してください。
**インストール不要版**：`PDF-Studio-1.5.20-win.zip` をダウンロードして展開し、中の `PDF Studio.exe` を起動してください。

---

- "Create PDF from Files", "Combine Files" and "Insert Pages from File" now read images whose extension does not match their content (for example a .png that is actually a JPEG or WebP). Previously this failed with "The input is not a PNG file!".
- "Create PDF from Files" no longer makes garbled pages from unsupported files such as PowerPoint or Excel; it lists them as files that could not be converted.
- Closing the last tab no longer quits PDF Studio; an empty tab remains. Close the window (or the empty tab) to quit.

---

- "สร้างจากไฟล์" "รวม" และ "แทรกหน้า" อ่านรูปภาพที่นามสกุลไม่ตรงกับเนื้อหาได้แล้ว (เช่น ไฟล์ .png ที่จริงเป็น JPEG หรือ WebP)
- "สร้างจากไฟล์" จะไม่สร้างหน้าที่อ่านไม่ออกจากไฟล์ที่ไม่รองรับ เช่น PowerPoint หรือ Excel แต่จะแจ้งรายชื่อไฟล์ที่แปลงไม่ได้
- การปิดแท็บสุดท้ายจะไม่ปิด PDF Studio อีกต่อไป (จะเหลือแท็บว่าง) ปิดหน้าต่างเพื่อออกจากโปรแกรม
