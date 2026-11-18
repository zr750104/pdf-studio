// スキャン画像のページ（全面に 1 ビットの画像が 1 枚だけ）を、表示する大きさに縮めた画像にする（renderer/scanpages.js から使う）
// pdf.js に描かせると、大きな白黒画像を毎回すべて展開して重いため、ここで展開・縮小して ImageBitmap で返す。
// 受け取る：{ id, key, filter: 'CCITTFaxDecode' | 'FlateDecode', params, bytes, w, h, invert, tw, th, warm }（warm は展開だけ）
// 返す：{ id, bitmap } か { id, warmed } か { id, error }
importScripts('./vendor/ccitt/ccitt.js');

// 展開した画素（1 ビット）を、ページごとに少し残す（倍率を変えたとき・サムネイルで展開し直さないため）
let RAW_LIMIT = 64 * 1024 * 1024; // 画面側が PC のメモリに合わせて変える
const raws = new Map(); // key → { bits, bpr, bytes }
let rawBytes = 0;

const POP = new Uint8Array(256);
for (let i = 0; i < 256; i++) POP[i] = (i & 1) + POP[i >> 1];
const HI = new Uint8Array(256), LO = new Uint8Array(256); // 1 バイトの上・下 4 画素の白の数
for (let i = 0; i < 256; i++) { HI[i] = POP[i >> 4]; LO[i] = POP[i & 15]; }

// ---------------------------------------------------------------- 縮小版（大きな図面用）
// 5 億画素の図面を、拡大・縮小のたびに全部の画素から縮めると遅い。
// 1/4・1/8・1/16 の大きさのグレー（白の割合）を一度だけ作り、表示する大きさに近いものから縮める
let PYRAMID_MIN = 80e6; // これより大きな画像だけ作る（自動テストでは小さくして確かめる）

/** 1 ビットの画素から、1/4 の大きさのグレー（0 = 黒 … 255 = 白。白の割合）を作る */
function quarter({ bits, bpr }, w, h) {
  const qw = Math.ceil(w / 4), qh = Math.ceil(h / 4);
  const out = new Uint8Array(qw * qh);
  const cnt = new Uint16Array(qw);
  // 右端のバイトは、画像に入る画素のビットだけを数える
  const lastMask = 0xff & (0xff << (8 - ((w & 7) || 8)));
  const lastB = bpr - 1;
  for (let qy = 0; qy < qh; qy++) {
    cnt.fill(0);
    const yEnd = Math.min(h, qy * 4 + 4);
    for (let y = qy * 4; y < yEnd; y++) {
      const row = y * bpr;
      for (let b = 0; b < bpr; b++) {
        const v = b === lastB ? bits[row + b] & lastMask : bits[row + b];
        const q = b * 2;
        cnt[q] += HI[v];
        if (q + 1 < qw) cnt[q + 1] += LO[v];
      }
    }
    // 端の半端な行・列は、入っている画素の数で割る
    const rows = yEnd - qy * 4;
    const o = qy * qw;
    for (let qx = 0; qx < qw; qx++) {
      const cols = Math.min(4, w - qx * 4);
      // 右端のバイトの余りのビットも数えてしまうので、255 を超えないようにする
      out[o + qx] = Math.min(255, Math.round((cnt[qx] * 255) / (rows * cols)));
    }
  }
  return { gray: out, w: qw, h: qh, f: 4 };
}

/** グレーを 1/2 にする */
function half(g) {
  const w = Math.ceil(g.w / 2), h = Math.ceil(g.h / 2);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = y * 2, y1 = Math.min(g.h - 1, y0 + 1);
    for (let x = 0; x < w; x++) {
      const x0 = x * 2, x1 = Math.min(g.w - 1, x0 + 1);
      out[y * w + x] = (g.gray[y0 * g.w + x0] + g.gray[y0 * g.w + x1] + g.gray[y1 * g.w + x0] + g.gray[y1 * g.w + x1] + 2) >> 2;
    }
  }
  return { gray: out, w, h, f: g.f * 2 };
}

function pyramid(raw, w, h) {
  if (raw.levels || w * h < PYRAMID_MIN) return raw.levels || null;
  const l4 = quarter(raw, w, h);
  const l8 = half(l4), l16 = half(l8);
  raw.levels = [l16, l8, l4]; // 小さい順
  raw.bytes += l4.gray.length + l8.gray.length + l16.gray.length;
  rawBytes += l4.gray.length + l8.gray.length + l16.gray.length;
  evict(raw);
  return raw.levels;
}

/** グレーの縮小版から、範囲 r（元の画像の画素）を tw × th に面積平均で縮める */
function shrinkGray(g, tw, th, invert, r) {
  const out = new Uint8ClampedArray(tw * th * 4);
  // 元の画素の範囲を縮小版の画素にする
  const gx = Math.floor(r.x / g.f), gy = Math.floor(r.y / g.f);
  const gw = Math.max(1, Math.min(g.w - gx, Math.ceil((r.x + r.w) / g.f) - gx)), gh = Math.max(1, Math.min(g.h - gy, Math.ceil((r.y + r.h) / g.f) - gy));
  // 出力の各列・各行が、縮小版のどの画素から来るか（縮小版の方が小さいときは、同じ画素を繰り返す）
  const colOf = new Int32Array(gw);
  for (let x = 0; x < gw; x++) colOf[x] = Math.min(tw - 1, Math.floor((x * tw) / gw));
  const acc = new Float64Array(tw), area = new Float64Array(tw);
  for (let x = 0; x < gw; x++) area[colOf[x]]++;
  const srcCol = new Int32Array(tw);
  for (let tx = 0; tx < tw; tx++) srcCol[tx] = Math.min(gw - 1, Math.floor(((tx + 0.5) * gw) / tw));
  let y = 0;
  for (let ty = 0; ty < th; ty++) {
    let y0 = y;
    let y1 = Math.min(gh, Math.max(y + 1, Math.round(((ty + 1) * gh) / th)));
    if (gh < th) { y0 = Math.min(gh - 1, Math.floor(((ty + 0.5) * gh) / th)); y1 = y0 + 1; }
    acc.fill(0);
    const rows = y1 - y0;
    for (let yy = y0; yy < y1; yy++) {
      const row = (gy + yy) * g.w + gx;
      for (let x = 0; x < gw; x++) acc[colOf[x]] += g.gray[row + x];
    }
    if (gh >= th) y = y1;
    let o = ty * tw * 4;
    for (let tx = 0; tx < tw; tx++) {
      // この列に縮小版の画素が無いとき（縮小版の方が細かくない）は、いちばん近い画素
      let v = area[tx] ? acc[tx] / (area[tx] * rows) : g.gray[(gy + y0) * g.w + gx + srcCol[tx]];
      if (invert) v = 255 - v;
      out[o] = out[o + 1] = out[o + 2] = v;
      out[o + 3] = 255;
      o += 4;
    }
  }
  return new ImageData(out, tw, th);
}

/** 必要な長さ（need バイト）まで展開する。それ以上は読まない（末尾のゴミや、異常に大きく展開されるデータに備える） */
async function inflate(u8, need) {
  const out = new Uint8Array(need);
  let n = 0;
  const reader = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
  try {
    while (n < need) {
      const { value, done } = await reader.read();
      if (done) break;
      const take = Math.min(value.length, need - n);
      out.set(value.subarray(0, take), n);
      n += take;
    }
  } catch (e) {
    if (n === 0) throw e; // 途中まで読めていれば、残りは白で埋める
  } finally {
    reader.cancel().catch(() => {});
  }
  return { out, n };
}

/** 上限を超えたら、古いものから捨てる（keep は残す） */
function evict(keep) {
  for (const [k, v] of raws) {
    if (rawBytes <= RAW_LIMIT) break;
    if (v === keep) continue;
    raws.delete(k);
    rawBytes -= v.bytes;
  }
}

/** 1 ビットの画素データ（PDF のサンプル値：1 = 白、0 = 黒。Decode [1 0] なら逆） */
async function decode(m) {
  const hit = raws.get(m.key);
  if (hit) {
    raws.delete(m.key);
    raws.set(m.key, hit); // 最近使ったものとして後ろへ
    return hit;
  }
  const p = m.params || {};
  let bits, bpr;
  if (m.filter === 'CCITTFaxDecode') {
    const cols = p.Columns || 1728;
    bpr = Math.ceil(cols / 8);
    bits = new Uint8Array(bpr * m.h);
    let k = 0;
    const src = m.bytes;
    const dec = new self.CCITTFaxDecoder({ next: () => (k < src.length ? src[k++] : -1) }, {
      K: p.K || 0, Columns: cols, Rows: m.h, BlackIs1: !!p.BlackIs1, EncodedByteAlign: !!p.EncodedByteAlign,
      EndOfLine: !!p.EndOfLine, EndOfBlock: p.EndOfBlock ?? true
    });
    for (let pos = 0; pos < bits.length; pos++) {
      const c = dec.readNextChar();
      if (c < 0) { bits.fill(m.invert ? 0 : 0xff, pos); break; } // 足りない行は白
      bits[pos] = c;
    }
  } else {
    bpr = Math.ceil(m.w / 8);
    const { out, n } = await inflate(m.bytes, bpr * m.h);
    if (n < out.length) out.fill(m.invert ? 0 : 0xff, n); // 足りない行は白
    bits = out;
  }
  const e = { bits, bpr, bytes: bits.length };
  raws.set(m.key, e);
  rawBytes += e.bytes;
  evict(e);
  return e;
}

/**
 * 面積平均で tw × th に縮める（白の割合を明るさにする）。tw ≥ 幅 のときはそのままの大きさ。
 * r を渡すと、画像のその範囲（{ x, y, w, h }、画素）だけを縮める（拡大したとき、見えている部分だけを細かく描くため）
 */
function shrink({ bits, bpr }, w, h, tw, th, invert, r = { x: 0, y: 0, w, h }) {
  const out = new Uint8ClampedArray(tw * th * 4);
  const rx = r.x, rw = r.w, rh = r.h;
  const colOf = new Int32Array(rw);
  for (let x = 0; x < rw; x++) colOf[x] = Math.min(tw - 1, Math.floor((x * tw) / rw));
  const acc = new Float64Array(tw);
  const area = new Float64Array(tw);
  for (let x = 0; x < rw; x++) area[colOf[x]]++;
  const b0 = rx >> 3, b1 = Math.min(bpr - 1, (rx + rw - 1) >> 3);
  let y = r.y;
  const yEnd = r.y + rh;
  for (let ty = 0; ty < th; ty++) {
    const y1 = Math.min(yEnd, Math.max(y + 1, r.y + Math.round(((ty + 1) * rh) / th)));
    acc.fill(0);
    const rows = y1 - y;
    for (; y < y1; y++) {
      const row = y * bpr;
      for (let b = b0; b <= b1; b++) {
        // この 1 バイトの 8 画素のうち、範囲に入るもの（範囲の左端からの位置で数える）
        const x0 = b * 8 - rx;
        const v = bits[row + b];
        const lo = Math.max(0, x0), hi = Math.min(rw - 1, x0 + 7);
        if (lo === x0 && hi === x0 + 7 && colOf[lo] === colOf[hi]) { acc[colOf[lo]] += POP[v]; continue; }
        for (let x = lo; x <= hi; x++) if (v & (0x80 >> (x - x0))) acc[colOf[x]]++;
      }
    }
    let o = ty * tw * 4;
    for (let tx = 0; tx < tw; tx++) {
      let g = (acc[tx] / (area[tx] * rows)) * 255; // 1 の割合
      if (invert) g = 255 - g;
      out[o] = out[o + 1] = out[o + 2] = g;
      out[o + 3] = 255;
      o += 4;
    }
  }
  return new ImageData(out, tw, th);
}

/** 範囲を画像の中に収める（整数の画素） */
function clampRegion(g, w, h) {
  const x = Math.max(0, Math.min(w - 1, Math.floor(g.x))), y = Math.max(0, Math.min(h - 1, Math.floor(g.y)));
  return { x, y, w: Math.max(1, Math.min(w - x, Math.ceil(g.x + g.w) - x)), h: Math.max(1, Math.min(h - y, Math.ceil(g.y + g.h) - y)) };
}

// 1 つずつ順に処理する（展開した画素を使い回すため）
let chain = Promise.resolve();
self.onmessage = (e) => {
  const m = e.data;
  if (m.rawLimit) { RAW_LIMIT = m.rawLimit; return; }
  if (m.pyramidMin != null) { PYRAMID_MIN = m.pyramidMin; raws.clear(); rawBytes = 0; return; }
  chain = chain.then(async () => {
    try {
      // 展開しても 1 枚で上限を超える大きな画像は、先読みしない（いま表示するときだけ展開する）
      if (m.warm && (m.w * m.h) / 8 > RAW_LIMIT && !raws.has(m.key)) { self.postMessage({ id: m.id, warmed: false }); return; }
      const raw = await decode(m);
      // 先読み：展開だけしておく（次に表示するときは縮めるだけで済む）
      if (m.warm) { self.postMessage({ id: m.id, warmed: true }); return; }
      // 範囲（見えている部分）だけのときは、その範囲の画素数が大きさの上限
      const r = m.region ? clampRegion(m.region, m.w, m.h) : null;
      const sw = r ? r.w : m.w, sh = r ? r.h : m.h;
      const tw = Math.max(1, Math.min(m.tw, sw)), th = Math.max(1, Math.min(m.th, sh));
      // 大きな図面は、縮める先より大きい中でいちばん小さい縮小版から縮める（全部の画素を毎回見ない）
      const levels = pyramid(raw, m.w, m.h);
      // 少し小さい縮小版でもよい（元の画素から 1 ビットずつ数えるより、ずっと速い）
      // 見えている部分を細かく描くとき（region あり）は、引き伸ばすと細い線が薄くなるので余裕を持たせない
      const slack = r ? 1 : 0.7;
      const lv = levels?.find((g) => sw / g.f >= tw * slack && sh / g.f >= th * slack);
      const img = lv ? shrinkGray(lv, tw, th, m.invert, r || { x: 0, y: 0, w: m.w, h: m.h }) : shrink(raw, m.w, m.h, tw, th, m.invert, r || undefined);
      const bitmap = await createImageBitmap(img);
      self.postMessage({ id: m.id, bitmap }, [bitmap]);
    } catch (err) {
      self.postMessage({ id: m.id, error: String((err && err.message) || err) });
    }
  });
};
