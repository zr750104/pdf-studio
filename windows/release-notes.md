## PDF Studio 1.5.29

- 「重ねて比較（図面）」の結果がぼやけていたのを直しました。CAD などから書き出した線の図面は、画像にせず線のまま色分けして重ねるので、どれだけ拡大しても線と文字がくっきり見えます（共通の線は黒、古い版だけの線は赤、新しい版だけの線は青）。スキャン画像のページは、これまでより細かい画像で重ねます
- 「重ねて比較（図面）」の途中で、いま何をしているか（ページ番号と段階）を表示するようにしました。計算中も画面と「中止」が動きます
- 起動したとき、前回開いていたファイルを開く前に「開く／開かない」を聞くようにしました。「開かない」を選んでも記録は残り、次の起動でまた聞きます。聞かずに開かないようにするには、「ファイル」→「最近使ったファイル」→「起動時に前回のファイルを開く」のチェックを外してください

**インストール版**：`PDF-Studio-Setup-1.5.29.exe` をダウンロードし、PDF Studio を閉じてから実行してください。
**インストール不要版**：`PDF-Studio-1.5.29-win.zip` をダウンロードして展開し、中の `PDF Studio.exe` を起動してください。

---

- Overlay Compare (Drawings) results are no longer blurry. Vector drawings (such as CAD exports) are now overlaid as color-coded vector lines instead of an image, so lines and text stay sharp at any zoom (black: lines in both, red: only in the old version, blue: only in the new version). Scanned pages are overlaid at a higher resolution.
- Overlay Compare (Drawings) now shows what it is doing (page number and step). The screen and the Cancel button keep responding during the calculation.
- At startup, PDF Studio now asks whether to open the files that were open last time. If you choose "Don't Open", the list is kept and you will be asked again next time. To never reopen them without asking, turn off File > Recent Files > "Reopen Previous Files at Startup".

---

- แก้ไขผลลัพธ์ของ "เปรียบเทียบแบบซ้อนทับ (แบบแปลน)" ที่ดูพร่ามัว แบบที่เป็นเส้นเวกเตอร์ (เช่น ส่งออกจาก CAD) จะซ้อนทับเป็นเส้นแยกสีโดยไม่แปลงเป็นภาพ เส้นและตัวอักษรจึงคมชัดไม่ว่าจะขยายเท่าใด (ดำ: เส้นที่มีในทั้งสองเวอร์ชัน แดง: มีเฉพาะฉบับเก่า น้ำเงิน: มีเฉพาะฉบับใหม่) หน้าที่เป็นภาพสแกนจะซ้อนทับด้วยภาพที่ละเอียดขึ้น
- "เปรียบเทียบแบบซ้อนทับ (แบบแปลน)" แสดงสิ่งที่กำลังทำ (หมายเลขหน้าและขั้นตอน) หน้าจอและปุ่มยกเลิกยังตอบสนองระหว่างการคำนวณ
- เมื่อเริ่มโปรแกรม PDF Studio จะถามก่อนว่าจะเปิดไฟล์ที่เปิดไว้ครั้งก่อนหรือไม่ หากเลือก "ไม่เปิด" รายการจะยังคงอยู่และจะถามอีกครั้งในครั้งถัดไป หากไม่ต้องการให้ถามและไม่เปิด ให้ยกเลิกเครื่องหมาย ไฟล์ > ไฟล์ล่าสุด > "เปิดไฟล์ครั้งก่อนเมื่อเริ่มโปรแกรม"
