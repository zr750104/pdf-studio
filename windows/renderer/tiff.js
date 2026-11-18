// TIFF（複数ページ対応）を読み込んで PDF のページにする
// デコーダ（UTIF.js と pako）は TIFF を開くときだけ読み込む
import { canvasToBytes } from './util.js';
import * as PL from './vendor/pdf-lib.esm.min.js';

let loading = null;
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = new URL(src, import.meta.url).href;
    s.onload = resolve;
    s.onerror = () => reject(new Error('TIFF の読み込み機能を準備できませんでした'));
    document.head.append(s);
  });
}
function loadUTIF() {
  loading ||= loadScript('./vendor/utif/pako_inflate.min.js').then(() => loadScript('./vendor/utif/UTIF.js'))
    .then(() => loadScript('./vendor/ccitt/ccitt.js').then(() => loadScript('./tiff-g4.js')).catch(() => null))
    .then(() => window.UTIF)
    .catch((e) => { loading = null; throw e; }); // 失敗したら次は読み込み直す
  return loading;
}

/** 直近の読み込みの段階ごとの時間（ms）。計測とログ用 */
export const lastStats = { stages: {} };
const tick = (k, t0) => { lastStats.stages[k] = (lastStats.stages[k] || 0) + performance.now() - t0; return performance.now(); };

export const isTiff = (name) => /\.tiff?$/i.test(name || '');

/** 解像度（dpi）。なければ 96 dpi とみなす */
function dpiOf(ifd) {
  const val = (t) => {
    const v = ifd[t];
    if (!v) return 0;
    const n = Array.isArray(v) ? v[0] : v;
    return Array.isArray(n) ? n[0] / (n[1] || 1) : Number(n);
  };
  const unit = ifd.t296 ? ifd.t296[0] : 2;
  const conv = unit === 3 ? 2.54 : unit === 1 ? 0 : 1;
  const x = val('t282') * conv, y = val('t283') * conv;
  const ok = (d) => d >= 20 && d <= 4800;
  return { x: ok(x) ? x : ok(y) ? y : 96, y: ok(y) ? y : ok(x) ? x : 96 };
}

/**
 * TIFF の各ページを pdf-lib の文書に追加する。
 * - ページは複数のワーカーで並行して展開する。G4（ファクス形式）は pdf.js の速い CCITT デコーダ、それ以外は UTIF.js。
 * - 白黒・グレーは画素データをそのまま圧縮して（劣化なし）、カラーなどは canvas 経由の JPEG / PNG で埋め込む。
 * - 1 ストリップの G4 は、展開せずにそのまま埋め込む（passthruG4、既定）。開くのが速く、ファイルも小さい。
 *   表示は scanpages.js がワーカーで展開・縮小する（pdf.js に描かせると重い）
 * insertAt を指定するとその位置に挿入する。workers に 0 を渡すとワーカーを使わない。戻り値は追加したページ数
 */
export async function addTiffPages(doc, bytes, { insertAt = null, onPage = null, onStart = null, workers = null, fastG4 = true, passthruG4 = true, testFailG4 = false } = {}) {
  const UTIF = await loadUTIF();
  const buf = bytes instanceof ArrayBuffer ? bytes : new Uint8Array(bytes).slice().buffer;
  const ifds = UTIF.decode(buf).filter((ifd) => ifd.t256 && ifd.t257);
  if (!ifds.length) throw new Error('TIFF に画像が見つかりません');
  // サムネイル（縮小画像：NewSubfileType の bit0）は省く
  const pages = ifds.filter((ifd) => !(ifd.t254 && (ifd.t254[0] & 1))) ;
  const list = pages.length ? pages : ifds;
  const tag = (ifd, t, d) => (ifd[t] ? ifd[t][0] : d);
  // 1 ストリップの G4 はそのまま埋め込む。複数ストリップの G4 は速いデコーダで展開する（fastG4=false なら UTIF）
  const g4 = list.map((ifd) => ccittInfo(ifd, buf.byteLength));
  const passthru = g4.map((x) => (passthruG4 && x && x.strips.length === 1 ? x : null));
  // 速い G4 デコーダが読み込めていないときは UTIF で展開する
  if (typeof window.CCITTFaxDecoder !== 'function' || typeof window.decodeTiffG4 !== 'function') fastG4 = false;
  const g4ByIndex = new Map(list.map((ifd, k) => [ifds.indexOf(ifd), fastG4 && g4[k] && !passthru[k] ? { width: ifd.t256[0], strips: g4[k].strips, fail: testFailG4 } : null]));
  const toDecode = list.map((ifd) => ifds.indexOf(ifd)).filter((i, k) => !passthru[k]);
  const nWorkers = toDecode.length < 2 ? 0 : workers != null ? workers : workerCount(buf.byteLength);
  lastStats.stages = {};
  lastStats.info = {
    pages: list.length, workerPages: 0, g4fallback: 0, ccitt: 0, g4fast: g4.filter((x, k) => fastG4 && x && !passthru[k]).length, direct: 0, canvas: 0,
    cmpr: [...new Set(list.map((d) => tag(d, 't259', 1)))],
    bps: [...new Set(list.map((d) => tag(d, 't258', 1)))],
    pm: [...new Set(list.map((d) => tag(d, 't262', -1)))],
    strips: Math.max(...list.map((d) => (d.t273 || d.t324 || []).length)),
    tiled: list.some((d) => d.t322), px: tag(list[0], 't256', 0) * tag(list[0], 't257', 0),
    mb: +(buf.byteLength / 1048576).toFixed(1), workers: nWorkers
  };
  onStart?.(lastStats.info);
  const decoder = toDecode.length ? makeDecoder(buf, ifds, toDecode, UTIF, nWorkers, g4ByIndex) : null;
  let n = 0;
  let lastYield = performance.now();
  try {
    for (const [k, ifd] of list.entries()) {
      let t = performance.now();
      let ref;
      const w = tag(ifd, 't256', 1), h = tag(ifd, 't257', 1);
      // ページに並べる画像（G4 の複数ストリップは、ストリップごとの画像を縦に並べる）
      let parts;
      if (passthru[k]) {
        parts = ccittImages(doc, buf, ifd, passthru[k]);
        lastStats.info.ccitt++;
        t = tick('embed', t);
      } else {
        await decoder.load(ifds.indexOf(ifd));
        t = tick('decode', t);
        // 白黒・グレーは、展開したデータをそのまま圧縮して埋め込む（速く、劣化もしない）
        ref = await directImage(doc, ifd);
        if (ref) lastStats.info.direct++;
        else { ref = await viaCanvas(doc, ifd, UTIF); lastStats.info.canvas++; }
        ifd.data = null;
        t = tick('embed', t);
        parts = [{ ref, row0: 0, rows: h }];
      }
      const dpi = dpiOf(ifd);
      const pw = (w * 72) / dpi.x, ph = (h * 72) / dpi.y;
      const page = insertAt == null ? doc.addPage([pw, ph]) : doc.insertPage(insertAt + n, [pw, ph]);
      for (const part of parts) {
        const name = page.node.newXObject('Im', part.ref);
        const y = ph - ((part.row0 + part.rows) * ph) / h, ih = (part.rows * ph) / h;
        page.pushOperators(PL.pushGraphicsState(), PL.concatTransformationMatrix(pw, 0, 0, ih, 0, y), PL.drawObject(name), PL.popGraphicsState());
      }
      n++;
      onPage?.(k + 1, list.length);
      // 画面の更新（進み具合の表示）を、ときどき挟む（毎ページだと待ち時間が積み重なる）
      if (performance.now() - lastYield > 50) { await new Promise((r) => setTimeout(r, 0)); lastYield = performance.now(); }
    }
  } finally {
    decoder?.close();
  }
  return n;
}

/** ワーカーの数：コア数 − 1（最大 4）。ファイルを各ワーカーに写すので、大きいファイルでは減らす */
function workerCount(size) {
  if (typeof Worker === 'undefined') return 0;
  const cores = Math.max(1, (navigator.hardwareConcurrency || 2) - 1);
  const cap = size > 300 * 1048576 ? 1 : size > 100 * 1048576 ? 2 : 4;
  return Math.min(cores, cap);
}

/**
 * ページの展開役。ワーカーがあれば先読みしながら並行して展開し、なければ（失敗したときも）この画面で展開する。
 * load(i) で ifds[i] の data・width・height・isLE を、UTIF.decodeImage と同じ形でそろえる
 */
function makeDecoder(buf, ifds, order, UTIF, nWorkers, g4ByIndex) {
  const isLE = new Uint8Array(buf, 0, 2)[0] === 0x49;
  const fill = (i, data) => {
    const ifd = ifds[i];
    ifd.width = ifd.t256[0];
    ifd.height = ifd.t257[0];
    ifd.isLE = isLE;
    ifd.data = data;
  };
  const local = (i) => {
    const g = g4ByIndex.get(i);
    if (g) {
      try { fill(i, window.decodeTiffG4(buf, g.width, g.strips, { fail: g.fail })); return; } catch { lastStats.info.g4fallback++; /* 速いデコーダで読めなければ UTIF で */ }
    }
    UTIF.decodeImage(buf, ifds[i], ifds);
  };
  const pool = [];
  try {
    for (let k = 0; k < nWorkers; k++) {
      const w = new Worker(new URL('./tiff-worker.js', import.meta.url));
      w.postMessage({ init: buf });
      pool.push(w);
    }
  } catch {
    pool.forEach((w) => w.terminate());
    pool.length = 0;
  }
  if (!pool.length) return { load: async (i) => local(i), close() {} };
  const jobs = new Map(); // ページの番号 → { promise, resolve, reject }
  const idle = [...pool];
  let next = 0; // order の中で、次に依頼するもの
  let pos = 0; // order の中で、いま必要としているもの
  const ahead = pool.length * 2;
  // 先読みは、展開後の大きさの合計でも抑える（大きなカラー TIFF で何ページ分も抱えないように）
  const BUDGET = 256 * 1048576;
  const sizeOf = (i) => { const d = ifds[i]; const bits = (d.t258 || [1]).reduce((a, b) => a + b, 0); return (d.t256[0] * d.t257[0] * bits) / 8; };
  let held = 0;
  const pump = () => {
    while (idle.length && next < order.length && next < pos + ahead && (held === 0 || held + sizeOf(order[next]) <= BUDGET)) {
      const w = idle.pop();
      const i = order[next++];
      const job = { size: sizeOf(i) };
      held += job.size;
      job.promise = new Promise((res, rej) => { job.resolve = res; job.reject = rej; });
      job.promise.catch(() => {});
      jobs.set(i, job);
      w.job = job;
      w.postMessage({ i, g4: g4ByIndex.get(i) || null });
    }
  };
  for (const w of pool) {
    w.onmessage = (e) => {
      const { data, z, t262, fallback, error } = e.data;
      // 受け持ちのページの結果（load 側で jobs から外していても届くよう、ワーカーが持つ）
      const job = w.job;
      if (error) job?.reject(new Error(error)); else job?.resolve(z ? { z } : { data, t262, fallback });
      w.job = null;
      idle.push(w);
      pump();
    };
    w.onerror = (e) => {
      e.preventDefault?.();
      window.api?.logInfo?.(`tiff worker error: ${e.message || 'load failed'}`);
      // 落ちたワーカーは使わない。受け持っていたページはこの画面で展開する
      w.job?.reject(new Error('worker'));
      w.job = null;
      w.dead = true;
      w.terminate();
      for (const arr of [pool, idle]) { const k = arr.indexOf(w); if (k >= 0) arr.splice(k, 1); }
    };
  }
  return {
    async load(i) {
      pos = Math.max(pos, order.indexOf(i));
      pump();
      const job = jobs.get(i);
      jobs.delete(i);
      if (job) { held -= job.size; pump(); }
      let data = null;
      if (job) { try { data = await job.promise; } catch { data = null; } }
      if (!data) return local(i);
      lastStats.info.workerPages++;
      if (data.fallback) lastStats.info.g4fallback++;
      if (data.z) { fill(i, null); ifds[i].z = data.z; return; }
      fill(i, data.data);
      if (data.t262) ifds[i].t262 = data.t262;
    },
    close() { pool.forEach((w) => w.terminate()); jobs.clear(); }
  };
}

/**
 * G4 の白黒ページなら、ストリップごとの圧縮データの位置・行数と白黒の向きを返す（展開せずに埋め込める）。対象外なら null。
 * （そのまま埋め込むのは 1 ストリップのときだけ。複数ストリップを画像に分けて並べると、縮小表示で継ぎ目の線が出るため）
 */
function ccittInfo(ifd, size) {
  const tag = (t, d) => (ifd[t] ? ifd[t][0] : d);
  if (tag('t259', 1) !== 4 || ifd.t322) return null;
  if (tag('t258', 1) !== 1 || tag('t277', 1) !== 1 || (ifd.t258 && ifd.t258.length !== 1)) return null;
  const pm = tag('t262', -1);
  if (pm !== 0 && pm !== 1) return null;
  // FillOrder=2（ビットの並びが逆）と、非圧縮モード（T6Options の bit1）は対象外
  if (tag('t266', 1) !== 1 || (tag('t293', 0) & 2)) return null;
  const off = ifd.t273, len = ifd.t279;
  const h = tag('t257', 0);
  if (!off || !len || off.length !== len.length || !off.length || !(h > 0)) return null;
  const rps = Math.min(h, tag('t278', h));
  if (Math.ceil(h / rps) !== off.length) return null;
  const strips = [];
  for (let k = 0; k < off.length; k++) {
    if (!(len[k] > 0) || off[k] + len[k] > size) return null;
    strips.push({ off: off[k], len: len[k], row0: k * rps, rows: Math.min(rps, h - k * rps) });
  }
  return { strips, pm };
}

/** G4 の圧縮データをそのまま CCITTFaxDecode の画像として登録する（ストリップごとに 1 つ） */
function ccittImages(doc, buf, ifd, { strips, pm }) {
  const w = ifd.t256[0];
  return strips.map(({ off, len, row0, rows }) => {
    const dict = {
      Type: 'XObject', Subtype: 'Image', Width: w, Height: rows, BitsPerComponent: 1, ColorSpace: 'DeviceGray',
      Filter: 'CCITTFaxDecode', DecodeParms: { K: -1, Columns: w, Rows: rows, BlackIs1: false }
    };
    // 符号の白・黒はそのまま白・黒として出る（WhiteIsZero のとき正しい向き）。BlackIsZero は白黒を入れ替えて表示する
    if (pm === 1) dict.Decode = [1, 0];
    return { ref: doc.context.register(doc.context.stream(new Uint8Array(buf, off, len).slice(), dict)), row0, rows };
  });
}

/** zlib 形式で圧縮する（PDF の FlateDecode と同じ形式。ブラウザ内蔵の圧縮を使う） */
async function deflate(u8) {
  const cs = new CompressionStream('deflate');
  return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(cs)).arrayBuffer());
}

/**
 * 1 ビット白黒・8 ビットグレーのページを、画素データのまま画像として登録する。
 * 対応しない形（カラー、パレット、16 ビット、JPEG 圧縮など）は null を返し、canvas 経由にする
 */
async function directImage(doc, ifd) {
  const tag = (t, d) => (ifd[t] ? ifd[t][0] : d);
  const photometric = tag('t262', -1);
  const bps = tag('t258', 1), spp = tag('t277', 1), cmpr = tag('t259', 1);
  if (photometric !== 0 && photometric !== 1) return null;
  if (spp !== 1 || (bps !== 1 && bps !== 8)) return null;
  // t277 がなくても t258 が複数値なら 1 画素に複数の値がある（壊れたファイルなど）ので対象外
  if (ifd.t258 && ifd.t258.length !== 1) return null;
  if (cmpr === 6 || cmpr === 7) return null;
  // 非圧縮などで並びが逆（FillOrder=2）のときは、UTIF が並べ直さないので対象外（G3/G4 は UTIF が考慮する）
  if (tag('t266', 1) === 2 && cmpr !== 3 && cmpr !== 4) return null;
  const w = ifd.width, h = ifd.height;
  const size = Math.ceil((w * bps) / 8) * h;
  let z = ifd.z;
  ifd.z = null;
  if (!z) {
    if (!ifd.data || ifd.data.length < size) return null;
    z = await deflate(ifd.data.subarray(0, size));
  }
  const dict = { Type: 'XObject', Subtype: 'Image', Width: w, Height: h, BitsPerComponent: bps, ColorSpace: 'DeviceGray', Filter: 'FlateDecode' };
  // WhiteIsZero（0 が白）は PDF の既定（0 が黒）と逆なので、Decode で反転する
  if (photometric === 0) dict.Decode = [1, 0];
  return doc.context.register(doc.context.stream(z, dict));
}

/** それ以外：RGBA に直して canvas から JPEG（カラー）か PNG にして埋め込む */
async function viaCanvas(doc, ifd, UTIF) {
  const rgba = UTIF.toRGBA8(ifd);
  const w = ifd.width, h = ifd.height;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, w * h * 4), w, h), 0, 0);
  const photometric = ifd.t262 ? ifd.t262[0] : 2;
  const bps = ifd.t258 ? ifd.t258[0] : 1;
  const gray = photometric <= 1 || bps === 1;
  const img = gray ? await doc.embedPng(await canvasToBytes(c, 'image/png')) : await doc.embedJpg(await canvasToBytes(c, 'image/jpeg', 0.92));
  c.width = c.height = 0;
  // 埋め込みは保存時に行われるので、ここで済ませて参照を返す
  await img.embed();
  return img.ref;
}
