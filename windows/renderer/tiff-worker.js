// TIFF のページを別スレッドで展開する（renderer/tiff.js から使う）
// 受け取る：{ init: ArrayBuffer }（最初に 1 回）、{ i: ページの番号（ifds の位置）, g4: { width, strips } }（G4 なら速い展開を使う）
// 返す：{ i, data: Uint8Array }（展開した画素データ）か { i, error }
importScripts('./vendor/utif/pako_inflate.min.js', './vendor/utif/UTIF.js', './vendor/ccitt/ccitt.js', './tiff-g4.js');

let buf = null;
let ifds = null;

/** zlib 形式で圧縮する（PDF の FlateDecode と同じ形式） */
async function deflate(u8) {
  const cs = new CompressionStream('deflate');
  return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(cs)).arrayBuffer());
}

self.onmessage = async (e) => {
  const m = e.data;
  if (m.init) {
    buf = m.init;
    // 画面側と同じ条件で並べる（番号を合わせるため）
    ifds = self.UTIF.decode(buf).filter((ifd) => ifd.t256 && ifd.t257);
    return;
  }
  const { i, g4 } = m;
  let t262 = null;
  try {
    let d;
    let fallback = false;
    if (g4) {
      // G4 は白黒なので、圧縮までここで済ませて返す（画面側の負担を減らす）。速いデコーダが失敗したら、ここで UTIF で展開する
      let raw = null;
      try { raw = self.decodeTiffG4(buf, g4.width, g4.strips, { fail: g4.fail }); } catch { raw = null; fallback = true; }
      if (raw) {
        const z = await deflate(raw);
        self.postMessage({ i, z }, [z.buffer]);
        return;
      }
    }
    {
      const ifd = ifds[i];
      self.UTIF.decodeImage(buf, ifd, ifds);
      d = ifd.data;
      ifd.data = null;
      // 展開で書き換わるタグ（JPEG は YCbCr→RGB で PhotometricInterpretation が 6→2 になる）も返す
      t262 = ifd.t262 ? [...ifd.t262] : null;
    }
    // 大きいバッファの一部のことがあるので、ちょうどの長さに切り出してから渡す
    const out = d.byteOffset === 0 && d.byteLength === d.buffer.byteLength ? d : d.slice();
    self.postMessage({ i, data: out, t262, fallback }, [out.buffer]);
  } catch (err) {
    self.postMessage({ i, error: String((err && err.message) || err) });
  }
};
