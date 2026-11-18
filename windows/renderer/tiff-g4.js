// G4（ファクス形式）の TIFF ページを、pdf.js の CCITT デコーダ（vendor/ccitt/ccitt.js）で展開する。
// UTIF.js の G4 展開より大幅に速い。結果は UTIF.decodeImage と同じ形（1 行ごとにバイト境界で詰め、黒 = 1）。
// ワーカー（importScripts）と画面（script 要素）の両方から読み込む。
// 行が足りないなど読めなかったときは例外にする（呼び出し側が UTIF で展開し直す）。
self.decodeTiffG4 = function (buf, width, strips, { fail = false } = {}) {
  if (fail) throw new Error('G4 test failure'); // 自動テストで、読めなかったときの経路を通すため
  const bpr = Math.ceil(width / 8);
  const height = strips.reduce((s, st) => s + st.rows, 0);
  const out = new Uint8Array(bpr * height);
  let pos = 0;
  for (const st of strips) {
    const src = new Uint8Array(buf, st.off, st.len);
    let k = 0;
    const source = { next: () => (k < src.length ? src[k++] : -1) };
    // ストリップごとに符号化がやり直されているので、ストリップごとに展開する。
    // 行数で止める（EndOfBlock: false）：TIFF では末尾の EOFB は省かれることがあるため
    const dec = new self.CCITTFaxDecoder(source, { K: -1, Columns: width, Rows: st.rows, BlackIs1: true, EndOfBlock: false });
    const end = pos + bpr * st.rows;
    while (pos < end) {
      const c = dec.readNextChar();
      if (c < 0) throw new Error('G4 data ended early');
      out[pos++] = c;
    }
  }
  return out;
};
