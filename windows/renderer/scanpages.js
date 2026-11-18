// スキャン画像のページを速く表示する。
// 「全面に 1 ビットの白黒画像が 1 枚あるだけ（注釈・トリミングなし）」のページは、pdf.js に描かせず、
// ワーカー（scan-worker.js）で画像を展開・縮小して表示する。pdf.js は大きな白黒画像を描くたびに全部展開するので重い。
// 判定は、いまの PDF（state.lib）のページの中身から行う（TIFF から開いたかどうかやページ番号では決めない）。
// 透かし・墨消し・ヘッダーなどで中身が変わったページは条件から外れ、これまでどおり pdf.js で描く。
import { state, PL } from './doc.js';

const { PDFName, PDFDict, PDFArray, PDFRawStream, PDFNumber, decodePDFRawStream } = PL;

let infoFor = null; // { pdf, list: Map(ページ番号 → 情報 | null) }

/** ページ i が速く表示できるページなら、その画像の情報を返す（できなければ null） */
export function scanInfo(i) {
  if (!state.lib || !state.pdf || window.__noScanFast) return null;
  // lib を書き換えている途中（pdf.js の文書がまだ古い）は判定しない（ずれたページの画像を描かないため）
  if (state.libFor !== state.pdf) return null;
  if (!infoFor || infoFor.pdf !== state.pdf) infoFor = { pdf: state.pdf, list: new Map() };
  if (!infoFor.list.has(i)) {
    let v = null;
    try { v = analyze(i); } catch { v = null; }
    infoFor.list.set(i, v);
  }
  return infoFor.list.get(i);
}

const num = (o) => (o instanceof PDFNumber ? o.asNumber() : NaN);
const near = (a, b) => Math.abs(a - b) < 0.02;

function streamText(s) {
  if (s instanceof PDFRawStream) return new TextDecoder('latin1').decode(decodePDFRawStream(s).decode());
  if (s?.getUnencodedContents) return new TextDecoder('latin1').decode(s.getUnencodedContents());
  return null;
}

let keySeq = 0;
const keys = new WeakMap(); // 画像のストリーム → 番号（ワーカーが展開した画素を使い回すため）

function analyze(i) {
  const lib = state.lib;
  if (i >= lib.getPageCount()) return null;
  const page = lib.getPage(i);
  const node = page.node;
  // 注釈はリンクだけなら可（ほかの注釈は pdf.js がページに描くため）
  const annots = node.Annots();
  if (annots) {
    for (let k = 0; k < annots.size(); k++) {
      const a = annots.lookup(k);
      if (!(a instanceof PDFDict) || a.lookup(PDFName.of('Subtype'))?.asString?.() !== '/Link' || a.lookup(PDFName.of('AP'))) return null;
    }
  }
  const mb = page.getMediaBox(), cb = page.getCropBox();
  if (!near(mb.x, cb.x) || !near(mb.y, cb.y) || !near(mb.width, cb.width) || !near(mb.height, cb.height)) return null;
  // 中身は「q a 0 0 d e f cm /名前 Do Q」だけ
  const contents = node.Contents();
  if (!contents) return null;
  const parts = contents instanceof PDFArray ? contents.asArray().map((r) => lib.context.lookup(r)) : [contents];
  // 対象のページの中身は数十バイト。大きいもの（図面など）は展開せずに外す（展開は画面を止めるため）
  if (parts.length > 4) return null;
  let size = 0;
  for (const s of parts) {
    if (s instanceof PDFRawStream) size += s.contents.length;
    else if (Array.isArray(s?.operators)) size += s.operators.length * 16;
    else return null;
  }
  if (size > 2048) return null;
  const texts = parts.map(streamText);
  if (texts.some((t) => t == null)) return null;
  const m = texts.join('\n').match(/^\s*q\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+cm\s*\/([^\s/[\]()<>{}%]+)\s*Do\s+Q\s*$/);
  if (!m) return null;
  const [a, b, c, d, e, f] = m.slice(1, 7).map(Number);
  if (!near(a, mb.width) || !near(b, 0) || !near(c, 0) || !near(d, mb.height) || !near(e, mb.x) || !near(f, mb.y)) return null;
  const xobjs = node.Resources()?.lookup(PDFName.of('XObject'));
  if (!(xobjs instanceof PDFDict)) return null;
  const img = xobjs.lookup(PDFName.of(decodeName(m[7])));
  if (!(img instanceof PDFRawStream)) return null;
  const dict = img.dict;
  const get = (k) => dict.lookup(PDFName.of(k));
  if (get('Subtype')?.asString?.() !== '/Image' || num(get('BitsPerComponent')) !== 1) return null;
  if (get('ImageMask') || get('SMask') || get('Mask') || get('SMaskInData')) return null;
  if (get('ColorSpace')?.asString?.() !== '/DeviceGray') return null;
  const w = num(get('Width')), h = num(get('Height'));
  // 展開すると 1 画素 1 ビット。大きな図面（5 億画素で約 60MB）も対象にする（上限は約 13 億画素・160MB）
  if (!(w > 0 && h > 0) || w * h > 1.3e9) return null;
  // 圧縮は CCITT（G3/G4）か Flate（予測なし）を 1 つだけ
  let filter = get('Filter');
  if (filter instanceof PDFArray) { if (filter.size() !== 1) return null; filter = filter.lookup(0); }
  filter = filter?.asString?.().slice(1);
  let parms = get('DecodeParms');
  if (parms instanceof PDFArray) parms = parms.size() === 1 ? parms.lookup(0) : null;
  const params = {};
  if (parms instanceof PDFDict) {
    for (const [k] of parms.entries()) {
      const v = parms.lookup(k); // 間接参照も引く
      if (v instanceof PDFNumber) params[k.asString().slice(1)] = v.asNumber();
      else if (v?.asBoolean) params[k.asString().slice(1)] = v.asBoolean();
      else return null; // 数値・真偽値以外は pdf.js に任せる
    }
  } else if (parms) return null;
  if (filter === 'FlateDecode') { if ((params.Predictor || 1) !== 1) return null; }
  else if (filter !== 'CCITTFaxDecode') return null;
  // CCITT の 1 行の幅（Columns、既定 1728）が画像の幅と違うものは pdf.js に任せる
  else if ((params.Columns ?? 1728) !== w || (params.Rows != null && params.Rows !== h)) return null;
  if (get('OC')) return null; // 表示・非表示の切り替えがある画像
  // Decode は [0 1]（既定）か [1 0]（白黒を入れ替え）
  const dec = get('Decode');
  let invert = false;
  if (dec instanceof PDFArray) {
    const v = dec.asArray().map(num);
    if (v.length !== 2) return null;
    if (v[0] === 1 && v[1] === 0) invert = true;
    else if (!(v[0] === 0 && v[1] === 1)) return null;
  }
  if (!keys.has(img)) keys.set(img, ++keySeq);
  return { key: `s${keys.get(img)}`, stream: img, filter, params, w, h, invert, interpolate: get('Interpolate')?.asBoolean?.() === true, rotate: ((page.getRotation().angle % 360) + 360) % 360 };
}

/** PDF の名前の #xx を戻す */
function decodeName(s) {
  return s.replace(/#([0-9a-fA-F]{2})/g, (_, x) => String.fromCharCode(parseInt(x, 16)));
}

// ---------------------------------------------------------------- ワーカー

const pool = [];
let nextId = 0;
const waiting = new Map(); // id → { resolve, reject }
let broken = false;

function workers() {
  if (pool.length || broken) return pool;
  const n = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
  try {
    for (let k = 0; k < n; k++) {
      const w = new Worker(new URL('./scan-worker.js', import.meta.url));
      // 展開した画素を残す量：1 ワーカー 64MB（メモリの少ない PC では 32MB）
      w.postMessage({ rawLimit: ((navigator.deviceMemory || 8) >= 8 ? 64 : 32) * 1048576 });
      w.busy = 0;
      w.onmessage = (e) => {
        const { id, bitmap, error } = e.data;
        w.busy = Math.max(0, w.busy - 1);
        const p = waiting.get(id);
        waiting.delete(id);
        pumpWarm();
        if (!p) { bitmap?.close(); return; }
        if (error) p.reject(new Error(error)); else p.resolve(bitmap);
      };
      w.onerror = (e) => {
        e.preventDefault?.();
        window.api?.logInfo?.(`scan worker error: ${e.message || 'load failed'}`);
        // ワーカーが使えなければ、以後は pdf.js で描く
        broken = true;
        for (const [id, p] of waiting) { waiting.delete(id); p.reject(new Error('worker')); }
        pool.forEach((x) => x.terminate());
        pool.length = 0;
      };
      pool.push(w);
    }
  } catch {
    broken = true;
    pool.forEach((x) => x.terminate());
    pool.length = 0;
  }
  return pool;
}

/** 自動テスト用：縮小版を作る画像の大きさを変える（展開した画素も捨てる） */
export function setScanTestOptions({ pyramidMin }) {
  for (const w of workers()) w.postMessage({ pyramidMin });
}

/** 速く表示できるか（ワーカーが使えるか）。使えないときは pdf.js で描く */
export const scanAvailable = () => typeof Worker !== 'undefined' && !broken;

/**
 * 画像を tw × th（画像の大きさが上限）に縮めた ImageBitmap を作る。回転はしない（描くときに回す）。
 * 同じ画像は同じワーカーに頼む（展開した画素を使い回せるように）
 */
export function renderScan(info, tw, th, region = null) {
  if (info.failed) return Promise.reject(new Error('failed before'));
  const ws = workers();
  if (!ws.length) return Promise.reject(new Error('no worker'));
  const id = ++nextId;
  const w = ws[Number(info.key.slice(1)) % ws.length];
  w.busy++;
  return new Promise((resolve, reject) => {
    // 一度失敗した画像は、以後ワーカーに頼まない（pdf.js で描く）。見えている部分だけの依頼の失敗では止めない
    waiting.set(id, { resolve, reject: (e) => { if (!region) info.failed = true; reject(e); } });
    // 応答が来ないまま止まらないよう、時間切れにする（そのページは pdf.js で描く）
    setTimeout(() => { const p = waiting.get(id); if (p) { waiting.delete(id); w.busy = Math.max(0, w.busy - 1); p.reject(new Error('timeout')); } }, 60000);
    // ストリームの中身は写して渡す（pdf-lib が持っている配列はそのまま使い続ける）
    const bytes = info.stream.contents.slice();
    w.postMessage({ id, key: info.key, filter: info.filter, params: info.params, bytes, w: info.w, h: info.h, invert: info.invert, tw: Math.round(tw), th: Math.round(th), region }, [bytes.buffer]);
  });
}

/**
 * 先読み：これから表示しそうなページの画像を、ワーカーが空いているときに展開だけしておく。
 * 表示の依頼を待たせないよう、そのワーカーに何も頼んでいないときだけ送る
 */
let warmList = [];
const warmed = new Map(); // key → 展開を頼んだ時刻（ワーカー側で捨てられていることもあるので、1 分たてば頼み直す）
export function warmScan(infos) {
  const now = Date.now();
  warmList = infos.filter((x) => x && !(now - (warmed.get(x.key) || 0) < 60000));
  pumpWarm();
}
function pumpWarm() {
  const ws = pool;
  if (!ws.length) return;
  for (let k = 0; k < warmList.length; k++) {
    const info = warmList[k];
    const w = ws[Number(info.key.slice(1)) % ws.length];
    if (w.busy) continue;
    warmList.splice(k--, 1);
    warmed.set(info.key, Date.now());
    if (warmed.size > 2000) warmed.clear();
    const id = ++nextId;
    w.busy++;
    waiting.set(id, { resolve: () => {}, reject: () => {} });
    const bytes = info.stream.contents.slice();
    w.postMessage({ id, key: info.key, filter: info.filter, params: info.params, bytes, w: info.w, h: info.h, invert: info.invert, warm: true }, [bytes.buffer]);
  }
}

/** ImageBitmap を canvas に描く（ページの回転に合わせて回す）。canvas はすでに回転後の大きさ */
export function drawScan(ctx, bitmap, rotate, cw, ch, interpolate = false) {
  ctx.save();
  // 画像より大きく描くときは、pdf.js と同じく補間しない（Interpolate がない画像。文字がぼけないように）
  const swap = rotate === 90 || rotate === 270;
  ctx.imageSmoothingEnabled = interpolate || bitmap.width >= (swap ? ch : cw);
  ctx.imageSmoothingQuality = 'high';
  if (rotate === 90) { ctx.translate(cw, 0); ctx.rotate(Math.PI / 2); ctx.drawImage(bitmap, 0, 0, ch, cw); }
  else if (rotate === 180) { ctx.translate(cw, ch); ctx.rotate(Math.PI); ctx.drawImage(bitmap, 0, 0, cw, ch); }
  else if (rotate === 270) { ctx.translate(0, ch); ctx.rotate(-Math.PI / 2); ctx.drawImage(bitmap, 0, 0, ch, cw); }
  else ctx.drawImage(bitmap, 0, 0, cw, ch);
  ctx.restore();
}

/** 回転後の canvas の大きさ cw × ch に対して、回転前の画像として作る大きさ */
export function scanTarget(info, cw, ch) {
  const swap = info.rotate === 90 || info.rotate === 270;
  return { tw: swap ? ch : cw, th: swap ? cw : ch };
}
