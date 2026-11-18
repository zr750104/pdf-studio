// 文書モデル：pdf-lib（編集）と pdf.js（表示）を束ね、注釈オブジェクト・取り消し履歴・保存を管理する
import * as PL from './vendor/pdf-lib.esm.min.js';
import * as pdfjsLib from './vendor/pdfjs/pdf.min.mjs';
import { t } from './i18n.js';

export { PL, pdfjsLib };
const { PDFDocument, PDFName, PDFHexString, PDFString, PDFDict, PDFStream, PDFArray, PDFNumber, PDFRef, PDFPageLeaf, PDFPage, degrees } = PL;

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
export const PDFJS_OPTS = {
  cMapUrl: new URL('./vendor/pdfjs/cmaps/', import.meta.url).href,
  cMapPacked: true,
  standardFontDataUrl: new URL('./vendor/pdfjs/standard_fonts/', import.meta.url).href,
  isEvalSupported: false
};

const STUDIO_KEY = 'PDFStudioObject';
/** 取り消し履歴に残す PDF 本体の合計サイズの上限（大きな PDF でメモリを使いすぎないように） */
const UNDO_BYTES_LIMIT = 300 * 1024 * 1024;

export const bus = new EventTarget();
export const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));

export const state = {
  lib: null,           // pdf-lib の PDFDocument（ページ構造・フォームの正本）
  bytes: null,         // lib を保存したバイト列（pdf.js 表示用）
  pdf: null,           // pdf.js の PDFDocumentProxy
  pageIds: [],         // ページごとの安定 ID（並べ替えても注釈が付いていく）
  objects: {},         // pageId -> 注釈オブジェクト配列（PDF 座標）。オブジェクトは直接書き換えず、必ず複製して差し替える
  path: null,
  name: '名称未設定.pdf',
  dirty: false,
  security: null,      // { user, owner, permissions, inherited, restricted }
  perms: null,         // 元ファイルの権限制限（null なら制限なし）
  measureScale: null,  // 測定の縮尺（null なら DEFAULT_SCALE）
  formDirty: false,
  undo: [],
  redo: [],
  textCache: new Map()
};

let idCounter = 1;
export const newId = (p = 'o') => `${p}${Date.now().toString(36)}${(idCounter++).toString(36)}`;
export const hasDoc = () => !!state.pdf;
export const pageCount = () => state.pageIds.length;

export function setDirty(d = true) {
  state.dirty = d;
  window.api.setDirty(d);
  window.api.setTitle(`${d ? '● ' : ''}${t(state.name)} - PDF Studio`);
}

// ---------------------------------------------------------------- 権限（作成者による制限）

const P = pdfjsLib.PermissionFlag;
/** 操作が許可されているか。kind: modify | annotate | forms | assemble | print | copy */
export function can(kind) {
  const p = state.perms;
  if (!p) return true;
  switch (kind) {
    case 'modify': return p.includes(P.MODIFY_CONTENTS);
    case 'annotate': return p.includes(P.MODIFY_ANNOTATIONS);
    case 'forms': return p.includes(P.FILL_INTERACTIVE_FORMS) || p.includes(P.MODIFY_ANNOTATIONS);
    case 'assemble': return p.includes(P.ASSEMBLE) || p.includes(P.MODIFY_CONTENTS);
    case 'print': return p.includes(P.PRINT);
    case 'copy': return p.includes(P.COPY);
    default: return true;
  }
}

/** pdf.js の権限フラグを pdf-lib の暗号化設定に変換 */
function permsToLib(p) {
  if (!p) return null;
  return {
    printing: p.includes(P.PRINT_HIGH_QUALITY) ? 'highResolution' : p.includes(P.PRINT) ? 'lowResolution' : undefined,
    modifying: p.includes(P.MODIFY_CONTENTS),
    copying: p.includes(P.COPY),
    annotating: p.includes(P.MODIFY_ANNOTATIONS),
    fillingForms: p.includes(P.FILL_INTERACTIVE_FORMS),
    contentAccessibility: p.includes(P.COPY_FOR_ACCESSIBILITY),
    documentAssembly: p.includes(P.ASSEMBLE)
  };
}

function randomPassword() {
  const a = new Uint8Array(24);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------- フォント

/** fontkit（約 0.4MB）は日本語フォントを埋め込むときだけ読み込む */
let fontkitPromise = null;
function loadFontkit() {
  if (window.fontkit) return Promise.resolve(window.fontkit);
  fontkitPromise ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = new URL('./vendor/fontkit.umd.min.js', import.meta.url).href;
    s.onload = () => resolve(window.fontkit);
    s.onerror = () => reject(new Error('fontkit を読み込めませんでした'));
    document.head.append(s);
  });
  return fontkitPromise;
}

const fontBytes = {};
export async function getFontBytes(bold = false, family = 'JP') {
  const key = `NotoSans${family}-${bold ? 'Bold' : 'Regular'}.ttf`;
  if (!fontBytes[key]) fontBytes[key] = new Uint8Array(await window.api.readAsset('fonts/' + key));
  return fontBytes[key];
}

/** 文書ごとに日本語フォントを 1 回だけ埋め込む（保存するとキャッシュは破棄される） */
export async function jpFont(doc, bold = false) {
  doc.__jpFonts = doc.__jpFonts || {};
  if (!doc.__jpFonts[bold]) {
    doc.registerFontkit(await loadFontkit());
    doc.__jpFonts[bold] = await doc.embedFont(await getFontBytes(bold), { subset: true });
  }
  return doc.__jpFonts[bold];
}

/** タイ文字（日本語フォントには入っていない） */
export const THAI = /[\u0E00-\u0E7F]/;

/** 文書ごとにタイ語フォント（Noto Sans Thai。英数字も入っている）を 1 回だけ埋め込む */
async function thaiFont(doc, bold = false) {
  doc.__thFonts = doc.__thFonts || {};
  if (!doc.__thFonts[bold]) {
    doc.registerFontkit(await loadFontkit());
    doc.__thFonts[bold] = await doc.embedFont(await getFontBytes(bold, 'Thai'), { subset: true });
  }
  return doc.__thFonts[bold];
}

/**
 * 文字を書き込むときのフォント。タイ文字を含むときはタイ語フォント、それ以外は日本語フォント。
 * （1 つの文字列の中で日本語とタイ語を混ぜると、どちらかが表示できない）
 */
export function textFont(doc, text, bold = false) {
  return THAI.test(text || '') ? thaiFont(doc, bold) : jpFont(doc, bold);
}

// ---------------------------------------------------------------- 読み込み

/** 復号後に残る暗号化辞書・古い XRef ストリームを取り除く */
function stripEncryption(doc) {
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    const dict = obj instanceof PDFDict ? obj : obj instanceof PDFStream ? obj.dict : null;
    if (!dict) continue;
    const type = dict.get(PDFName.of('Type'));
    const filter = dict.get(PDFName.of('Filter'));
    if (type === PDFName.of('XRef') || (filter === PDFName.of('Standard') && dict.has(PDFName.of('O')))) {
      doc.context.delete(ref);
    }
  }
  delete doc.context.trailerInfo.Encrypt;
}

/** PDF を pdf-lib で読み込む。暗号化されていればパスワードを尋ねる */
export async function loadLib(bytes, askPassword, label = 'このPDF') {
  try {
    return { lib: await PDFDocument.load(bytes, { updateMetadata: false }), password: null };
  } catch (e) {
    if (!/encrypted/i.test(e.message)) throw e;
  }
  // 開くパスワードのない（権限の制限だけの）ファイルは空パスワードで開ける
  try {
    const lib = await PDFDocument.load(bytes, { password: '', updateMetadata: false });
    stripEncryption(lib);
    return { lib, password: '' };
  } catch { /* パスワードが必要 */ }
  let message = `${label}はパスワードで保護されています。`;
  for (;;) {
    const pw = askPassword ? await askPassword(message) : null;
    if (pw == null) throw new Error('CANCELLED');
    try {
      const lib = await PDFDocument.load(bytes, { password: pw, updateMetadata: false });
      stripEncryption(lib);
      return { lib, password: pw };
    } catch {
      message = 'パスワードが違います。もう一度入力してください。';
    }
  }
}

/** 暗号化された元ファイルの権限を pdf.js で読む（null = 制限なし） */
export async function readPermissions(bytes, password) {
  let pdf;
  try {
    pdf = await pdfjsLib.getDocument({ data: bytes.slice(), password, ...PDFJS_OPTS }).promise;
    const p = await pdf.getPermissions();
    if (!p) return null;
    const all = [P.PRINT, P.MODIFY_CONTENTS, P.COPY, P.MODIFY_ANNOTATIONS, P.FILL_INTERACTIVE_FORMS, P.ASSEMBLE];
    return all.every((f) => p.includes(f)) ? null : p;
  } catch {
    return null;
  } finally {
    pdf?.destroy();
  }
}

/** PDF のバイト列を開く。本アプリで作成した注釈は編集可能なオブジェクトとして取り出す */
export async function openBytes(bytes, { path = null, name = '名称未設定.pdf', askPassword }) {
  const src = new Uint8Array(bytes);
  const { lib, password } = await loadLib(src, askPassword);
  const perms = password != null ? await readPermissions(src, password) : null;
  const pageIds = [];
  const objects = {};
  lib.getPages().forEach((page) => {
    const pid = newId('p');
    pageIds.push(pid);
    objects[pid] = [];
    const annots = page.node.Annots();
    if (!annots) return;
    for (let i = annots.size() - 1; i >= 0; i--) {
      const a = annots.lookup(i);
      if (!(a instanceof PDFDict)) continue;
      const data = a.lookup(PDFName.of(STUDIO_KEY));
      if (!data) continue;
      try {
        const obj = JSON.parse(data.decodeText());
        obj.id = newId();
        objects[pid].unshift(obj);
        annots.remove(i);
      } catch { /* 壊れたデータは無視 */ }
    }
  });
  state.libFor = null;
  state.lib = lib;
  state.pageIds = pageIds;
  state.objects = objects;
  state.path = path;
  state.name = name;
  state.perms = perms;
  state.formDirty = false;
  // 暗号化されていたファイルは保存時も保護を引き継ぐ。権限の制限は元のまま残す
  state.security = password == null ? null : {
    user: password,
    owner: perms ? randomPassword() : password,
    permissions: permsToLib(perms),
    inherited: true,
    restricted: !!perms
  };
  state.undo = [];
  state.redo = [];
  // 前回の測定で使った縮尺を引き継ぐ
  const lastMeasure = Object.values(objects).flat().reverse().find((o) => o.type === 'measure' && o.scale);
  state.measureScale = lastMeasure ? { ...lastMeasure.scale } : null;
  await refreshFromLib();
  setDirty(false);
  emit('doc-opened');
}

export async function newBlankDocument() {
  const lib = await PDFDocument.create();
  lib.addPage([595.28, 841.89]);
  await openBytes(await lib.save(), { name: '名称未設定.pdf' });
  setDirty(true);
}

// ---------------------------------------------------------------- 保存の下準備

/**
 * どこからも参照されていないオブジェクトを削除する。
 * pdf-lib は削除・差し替えたページの中身もファイルに書き出してしまうため、
 * これをしないと墨消しした文字が残ったり、ファイルが肥大化したりする。
 */
export function collectGarbage(doc) {
  const ctx = doc.context;
  const seen = new Set();
  const stack = [ctx.trailerInfo.Root, ctx.trailerInfo.Info, ctx.trailerInfo.Encrypt].filter(Boolean);
  while (stack.length) {
    const v = stack.pop();
    if (v instanceof PDFRef) {
      if (seen.has(v.tag)) continue;
      seen.add(v.tag);
      const o = ctx.lookup(v);
      if (o) stack.push(o);
    } else if (v instanceof PDFDict) {
      for (const [, x] of v.entries()) stack.push(x);
    } else if (v instanceof PDFArray) {
      for (let i = 0; i < v.size(); i++) stack.push(v.get(i));
    } else if (v instanceof PDFStream) {
      stack.push(v.dict);
    }
  }
  let removed = 0;
  for (const [ref] of ctx.enumerateIndirectObjects()) {
    if (!seen.has(ref.tag)) { ctx.delete(ref); removed++; }
  }
  return removed;
}

/**
 * lib を保存する。pdf-lib は保存時にページの描画内容とサブセットフォントを確定させるため、
 * 保存後に同じページへ描画できるよう描画ストリームとフォントのキャッシュを破棄する。
 */
export async function saveLib(lib = state.lib) {
  await lib.flush();
  collectGarbage(lib);
  const bytes = await lib.save({ updateFieldAppearances: false, useObjectStreams: false });
  for (const p of lib.getPages()) { p.contentStream = undefined; p.contentStreamRef = undefined; }
  delete lib.__jpFonts;
  delete lib.__thFonts;
  return bytes;
}

/** lib の内容を pdf.js に反映する（ページ構造が変わったとき） */
export async function refreshFromLib() {
  state.libFor = null;
  state.bytes = await saveLib();
  await reloadPdfJs();
}

async function reloadPdfJs() {
  const old = state.pdf;
  state.pdf = await pdfjsLib.getDocument({ data: state.bytes.slice(), ...PDFJS_OPTS }).promise;
  // lib と pdf.js の文書がそろった印（scanpages.js は、そろっている間だけ lib からページの中身を判定する）
  state.libFor = state.pdf;
  state.textCache.clear();
  if (old) old.destroy();
}

// ---------------------------------------------------------------- 注釈オブジェクト（書き換えは必ず複製してから）

/** 1 つの注釈を複製（座標配列は深く、画像などの文字列は共有） */
export function cloneObject(o) {
  const c = { ...o, rect: [...o.rect] };
  if (o.points) c.points = o.points.map((p) => [...p]);
  if (o.strokes) c.strokes = o.strokes.map((s) => s.map((p) => [...p]));
  if (o.quads) c.quads = o.quads.map((q) => [...q]);
  return c;
}

// ---------------------------------------------------------------- 回転

/** 角度（反時計回り・度）で回転できる種類。rect は回転前の枠で、中心まわりに回す */
export const ANGLE_TYPES = new Set(['image', 'text', 'rect', 'ellipse']);
/** 点の座標そのものを回す種類 */
export const POINT_TYPES = new Set(['ink', 'line', 'arrow', 'measure']);
export const canRotate = (o) => ANGLE_TYPES.has(o.type) || POINT_TYPES.has(o.type);
const norm = (a) => ((a % 360) + 360) % 360;

/** 注釈がページ上で占める範囲（回転を含めた外接矩形） */
export function objBounds(o) {
  if (o.type === 'measure') return measureBounds(o);
  const [x, y, w, h] = o.rect;
  const a = norm(o.angle || 0);
  if (!a || !ANGLE_TYPES.has(o.type)) return o.rect;
  const r = (a * Math.PI) / 180;
  const c = Math.abs(Math.cos(r)), s = Math.abs(Math.sin(r));
  const bw = w * c + h * s, bh = w * s + h * c;
  const cx = x + w / 2, cy = y + h / 2;
  return [cx - bw / 2, cy - bh / 2, bw, bh];
}

/** 注釈を反時計回りに deg 度回す（PDF 座標。画面上で時計回りにしたいときは負の値） */
export function rotateObjectBy(o, deg) {
  if (ANGLE_TYPES.has(o.type)) {
    o.angle = norm((o.angle || 0) + deg);
    return;
  }
  if (!POINT_TYPES.has(o.type)) return;
  const [x, y, w, h] = o.rect;
  const cx = x + w / 2, cy = y + h / 2;
  const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  const rot = ([px, py]) => [cx + (px - cx) * c - (py - cy) * s, cy + (px - cx) * s + (py - cy) * c];
  let pts;
  if (o.points) { o.points = o.points.map(rot); pts = o.points; }
  if (o.strokes) { o.strokes = o.strokes.map((st) => st.map(rot)); pts = o.strokes.flat(); }
  if (o.type === 'measure') { o.rect = measureBounds(o); return; }
  const pad = o.type === 'ink' ? (o.width ?? 1) : 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [px, py] of pts) { minX = Math.min(minX, px); minY = Math.min(minY, py); maxX = Math.max(maxX, px); maxY = Math.max(maxY, py); }
  o.rect = [minX - pad, minY - pad, maxX - minX + pad * 2, maxY - minY + pad * 2];
}

// ---------------------------------------------------------------- 測定（距離・周長・面積）

/** 単位ごとの「1 mm あたりの値」 */
export const UNITS = { mm: 1, cm: 0.1, m: 0.001, in: 1 / 25.4, ft: 1 / 304.8, pt: 72 / 25.4 };
const MM_PER_PT = 25.4 / 72;
/** 縮尺 1:n を、PDF の 1pt あたりの実寸（unit）に変換 */
export const scaleFactor = (n, unit) => MM_PER_PT * n * UNITS[unit];
export const DEFAULT_SCALE = { factor: scaleFactor(1, 'mm'), unit: 'mm', label: '1:1', decimals: 1 };
export const MEASURE_LABEL_SIZE = 9;

const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);

/** 測定値（数値と表示用の文字列） */
export function measureValue(o) {
  const pts = o.points;
  const sc = o.scale || DEFAULT_SCALE;
  const dec = sc.decimals ?? 1;
  const fmt = (v) => v.toLocaleString('ja-JP', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  if (o.kind === 'area') {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
      a += x1 * y2 - x2 * y1;
    }
    const v = (Math.abs(a) / 2) * sc.factor * sc.factor;
    let per = 0;
    for (let i = 0; i < pts.length; i++) per += dist(pts[i], pts[(i + 1) % pts.length]);
    return { value: v, text: `${fmt(v)} ${sc.unit}²`, perimeter: per * sc.factor, label: t('面積') };
  }
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += dist(pts[i - 1], pts[i]);
  const v = len * sc.factor;
  return { value: v, text: `${fmt(v)} ${sc.unit}`, label: t(o.kind === 'perimeter' ? '周長' : '距離') };
}

/** ラベルの位置（PDF 座標の中心）と大きさ */
export function measureLabel(o) {
  const pts = o.points;
  const { text } = measureValue(o);
  const fs = MEASURE_LABEL_SIZE;
  const w = Array.from(text).reduce((s, ch) => s + (ch.charCodeAt(0) < 128 ? 0.58 : 1), 0) * fs + 6;
  const h = fs * 1.5;
  let c;
  if (o.kind === 'area') {
    // 多角形の重心（面積 0 のときは頂点の平均）
    let a = 0, cx = 0, cy = 0;
    for (let i = 0; i < pts.length; i++) {
      const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
      const k = x1 * y2 - x2 * y1;
      a += k; cx += (x1 + x2) * k; cy += (y1 + y2) * k;
    }
    c = Math.abs(a) > 1e-6 ? [cx / (3 * a), cy / (3 * a)] : [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
  } else if (o.kind === 'perimeter') {
    // いちばん長い辺の中点
    let best = 1, bl = -1;
    for (let i = 1; i < pts.length; i++) { const l = dist(pts[i - 1], pts[i]); if (l > bl) { bl = l; best = i; } }
    c = [(pts[best - 1][0] + pts[best][0]) / 2, (pts[best - 1][1] + pts[best][1]) / 2];
  } else {
    c = [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2];
  }
  return { text, cx: c[0], cy: c[1], w, h, angle: o.labelAngle || 0 };
}

function measureBounds(o) {
  const pts = o.points;
  const L = measureLabel(o);
  const half = Math.max(L.w, L.h) / 2;
  let minX = L.cx - half, minY = L.cy - half, maxX = L.cx + half, maxY = L.cy + half;
  for (const [x, y] of pts) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
  return [minX, minY, maxX - minX, maxY - minY];
}

/** 中心 (cx, cy) まわりに反時計回り deg 度回す変換行列 */
export function rotationMatrix(deg, cx, cy) {
  const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return [c, s, -s, c, cx - cx * c + cy * s, cy - cx * s - cy * c];
}

export function findObject(id) {
  if (!id) return null;
  for (let i = 0; i < state.pageIds.length; i++) {
    const list = state.objects[state.pageIds[i]];
    const k = list ? list.findIndex((x) => x.id === id) : -1;
    if (k >= 0) return { obj: list[k], page: i, index: k, pid: state.pageIds[i] };
  }
  return null;
}

export function objectsOf(pageIndex) {
  return state.objects[state.pageIds[pageIndex]] || [];
}

/** 注釈を差し替える（配列も新しくして、取り消し履歴の配列と共有しない） */
function replaceObject(pid, index, obj) {
  const list = [...(state.objects[pid] || [])];
  list[index] = obj;
  state.objects[pid] = list;
}

export function addObject(pageIndex, obj) {
  obj.id = obj.id || newId();
  const pid = state.pageIds[pageIndex];
  pushUndo(snapshot());
  state.objects[pid] = [...(state.objects[pid] || []), obj];
  touched([pageIndex]);
  return obj;
}

/** 複数の注釈をまとめて追加（取り消しは 1 回分） list: [[pageIndex, obj], ...] */
export function addObjects(list) {
  if (!list.length) return;
  pushUndo(snapshot());
  const pages = new Set();
  const grouped = new Map();
  for (const [i, obj] of list) {
    obj.id = obj.id || newId();
    const pid = state.pageIds[i];
    (grouped.get(pid) || grouped.set(pid, []).get(pid)).push(obj);
    pages.add(i);
  }
  for (const [pid, objs] of grouped) state.objects[pid] = [...(state.objects[pid] || []), ...objs];
  touched([...pages]);
}

export function removeObject(id) {
  const f = findObject(id);
  if (!f) return;
  pushUndo(snapshot());
  state.objects[f.pid] = state.objects[f.pid].filter((o) => o.id !== id);
  touched([f.page]);
}

export function updateObject(id, fn) {
  const f = findObject(id);
  if (!f) return;
  pushUndo(snapshot());
  const c = cloneObject(f.obj);
  fn(c);
  replaceObject(f.pid, f.index, c);
  touched([f.page]);
}

/** 測定の縮尺を変える。all なら既存の測定にも適用する（取り消しは 1 回分） */
export function setMeasureScale(scale, all) {
  state.measureScale = { ...scale };
  if (!all) return 0;
  const pages = [];
  let n = 0;
  const before = snapshot();
  state.pageIds.forEach((pid, i) => {
    const list = state.objects[pid];
    if (!list?.some((o) => o.type === 'measure')) return;
    state.objects[pid] = list.map((o) => {
      if (o.type !== 'measure') return o;
      const c = cloneObject(o);
      c.scale = { ...scale };
      c.rect = objBounds(c);
      c.contents = `${measureValue(c).label}: ${measureValue(c).text}`;
      n++;
      return c;
    });
    pages.push(i);
  });
  if (n) { pushUndo(before); touched(pages); }
  return n;
}

/**
 * ドラッグなど連続した変更の開始。変更前の状態を保存し、書き換え用の複製を返す。
 * 返したオブジェクトはジェスチャーの間だけ直接書き換えてよい。
 */
export function beginGesture(id) {
  const f = findObject(id);
  if (!f) return null;
  const snap = snapshot();
  const c = cloneObject(f.obj);
  replaceObject(f.pid, f.index, c);
  return { obj: c, page: f.page, snap };
}

export function endGesture(g, changed) {
  if (!g) return;
  if (changed) {
    pushUndo(g.snap);
    touched([g.page]);
  } else {
    // 変化がなければ元のオブジェクトに戻す（取り消し履歴は増やさない）
    state.objects = g.snap.objects;
  }
}

function touched(pages) {
  setDirty(true);
  emit('objects-changed', { pages });
}

// ---------------------------------------------------------------- 取り消し

function snapshot() {
  const objects = {};
  for (const [k, v] of Object.entries(state.objects)) objects[k] = v; // 配列ごと共有（書き換え時に新しい配列を作る）
  return { bytes: state.bytes, pageIds: [...state.pageIds], objects, security: state.security, perms: state.perms };
}

function pushUndo(s) {
  state.undo.push(s);
  if (state.undo.length > 100) state.undo.shift();
  state.redo = [];
  trimUndo();
}

/** 取り消し履歴が抱える PDF 本体のサイズを上限内に収める */
function trimUndo() {
  const size = () => {
    const seen = new Set([state.bytes]);
    let total = 0;
    for (const s of [...state.undo, ...state.redo]) {
      if (s.bytes && !seen.has(s.bytes)) { seen.add(s.bytes); total += s.bytes.length; }
    }
    return total;
  };
  while (state.undo.length > 1 && size() > UNDO_BYTES_LIMIT) state.undo.shift();
}

async function restore(s, { force = false } = {}) {
  const structural = force || s.bytes !== state.bytes;
  state.pageIds = [...s.pageIds];
  state.objects = { ...s.objects };
  state.security = s.security;
  state.perms = s.perms;
  if (structural) {
    state.bytes = s.bytes;
    state.libFor = null;
    state.lib = await PDFDocument.load(s.bytes, { updateMetadata: false });
    state.formDirty = false;
    await reloadPdfJs();
    emit('doc-changed');
  } else {
    emit('objects-changed', { pages: null });
  }
  setDirty(true);
}

/** ページ構造の変更（pdf-lib で編集して再読み込み） */
export async function changeStructure(fn) {
  if (state.formDirty) {
    state.bytes = await saveLib();
    state.formDirty = false;
  }
  const before = snapshot();
  state.objects = { ...state.objects };
  try {
    state.libFor = null; // ここから lib を書き換える（pdf.js の文書はまだ古い）
    await fn(state.lib);
    await refreshFromLib();
  } catch (e) {
    // 途中で失敗したら、編集途中の lib を捨てて元に戻す
    await restore(before, { force: true });
    state.undo = state.undo.filter((s) => s !== before);
    throw e;
  }
  pushUndo(before);
  setDirty(true);
  emit('doc-changed');
}

export async function undo() {
  const s = state.undo.pop();
  if (!s) return;
  state.redo.push(snapshot());
  await restore(s);
}

export async function redo() {
  const s = state.redo.pop();
  if (!s) return;
  state.undo.push(snapshot());
  await restore(s);
}

// ---------------------------------------------------------------- 検索用テキスト

/** ページのテキスト項目（PDF 座標の矩形付き） */
export async function pageText(index) {
  const pid = state.pageIds[index];
  if (state.textCache.has(pid)) return state.textCache.get(pid);
  const pdf = state.pdf;
  const page = await pdf.getPage(index + 1);
  const tc = await page.getTextContent();
  const items = tc.items.filter((it) => it.str !== undefined).map((it) => {
    const [a, b, c, d, e, f] = it.transform;
    const h = Math.hypot(c, d) || Math.hypot(a, b);
    const vertical = Math.abs(b) > Math.abs(a);
    return {
      str: it.str,
      eol: it.hasEOL,
      rect: vertical ? [e - h, f - it.height, h, it.height || h] : [e, f - h * 0.22, it.width, h * 1.18],
      fontSize: h,
      vertical
    };
  });
  const text = items.map((i) => i.str + (i.eol ? '\n' : '')).join('');
  const res = { items, text };
  if (pdf === state.pdf) state.textCache.set(pid, res);
  return res;
}

// ---------------------------------------------------------------- 色

export function hexToRgb(hex) {
  const h = (hex || '#000000').replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

// ---------------------------------------------------------------- 書き出し（注釈 → PDF）

/** 描画命令の出力先。ページ本体（フラット化）か注釈の外観ストリームかを抽象化する */
class OpSink {
  constructor(doc) {
    this.doc = doc;
    this.ops = [];
    this.fonts = {};
    this.xobjects = {};
    this.gstates = {};
    this.n = 0;
  }
  font(font) {
    for (const [k, v] of Object.entries(this.fonts)) if (v === font.ref) return k;
    const name = `F${++this.n}`;
    this.fonts[name] = font.ref;
    return name;
  }
  image(img) {
    const name = `Im${++this.n}`;
    this.xobjects[name] = img.ref;
    return name;
  }
  gs(opacity, blend) {
    const key = `${opacity}-${blend || ''}`;
    for (const [k, v] of Object.entries(this.gstates)) if (v.key === key) return k;
    const name = `GS${++this.n}`;
    const d = { Type: 'ExtGState', ca: opacity, CA: opacity };
    if (blend) d.BM = blend;
    this.gstates[name] = { key, dict: this.doc.context.obj(d) };
    return name;
  }
  resources() {
    const r = {};
    if (Object.keys(this.fonts).length) r.Font = this.fonts;
    if (Object.keys(this.xobjects).length) r.XObject = this.xobjects;
    if (Object.keys(this.gstates).length) r.ExtGState = Object.fromEntries(Object.entries(this.gstates).map(([k, v]) => [k, v.dict]));
    return r;
  }
}

/** 行の上端から 1 行目のベースラインまで（文字サイズ比）。画面表示と共通 */
export const TEXT_ASCENT = 0.96;
export const LINE_HEIGHT = 1.25;

const op = (name, ...args) => PL.PDFOperator.of(name, args.map((a) => (typeof a === 'number' ? PDFNumber.of(a) : a)));

function pathEllipse(ops, x, y, w, h) {
  const k = 0.5522847498;
  const cx = x + w / 2, cy = y + h / 2, rx = w / 2, ry = h / 2;
  ops.push(op('m', cx + rx, cy));
  ops.push(op('c', cx + rx, cy + ry * k, cx + rx * k, cy + ry, cx, cy + ry));
  ops.push(op('c', cx - rx * k, cy + ry, cx - rx, cy + ry * k, cx - rx, cy));
  ops.push(op('c', cx - rx, cy - ry * k, cx - rx * k, cy - ry, cx, cy - ry));
  ops.push(op('c', cx + rx * k, cy - ry, cx + rx, cy - ry * k, cx + rx, cy));
}

/** 長い行をボックス幅で折り返す（日本語は 1 文字単位） */
export function wrapText(text, font, size, width) {
  const out = [];
  for (const para of String(text).split('\n')) {
    if (!width) { out.push(para); continue; }
    let line = '';
    for (const ch of Array.from(para)) {
      const next = line + ch;
      if (line && font.widthOfTextAtSize(next, size) > width) {
        out.push(line);
        line = ch;
      } else {
        line = next;
      }
    }
    out.push(line);
  }
  return out;
}

function textOps(sink, font, str, size, colorHex, x, yTop, width, align = 'left') {
  const name = sink.font(font);
  const [r, g, b] = hexToRgb(colorHex);
  const lineH = size * LINE_HEIGHT;
  const lines = wrapText(str, font, size, width);
  sink.ops.push(op('BT'), op('rg', r, g, b), op('Tf', PDFName.of(name), size));
  lines.forEach((ln, i) => {
    let lx = x;
    if (align !== 'left' && width) {
      const w = font.widthOfTextAtSize(ln, size);
      lx = align === 'center' ? x + (width - w) / 2 : x + width - w;
    }
    sink.ops.push(op('Tm', 1, 0, 0, 1, lx, yTop - size * TEXT_ASCENT - i * lineH));
    sink.ops.push(op('Tj', font.encodeText(ln)));
  });
  sink.ops.push(op('ET'));
}

/** dataURL の画像を文書に埋め込む（同じ画像は 1 回だけ） */
async function embedDataUrl(doc, src) {
  doc.__images = doc.__images || new Map();
  if (!doc.__images.has(src)) {
    const bytes = Uint8Array.from(atob(src.split(',')[1]), (c) => c.charCodeAt(0));
    doc.__images.set(src, src.startsWith('data:image/png') ? doc.embedPng(bytes) : doc.embedJpg(bytes));
  }
  return doc.__images.get(src);
}

/** 1 つの注釈オブジェクトを描画命令に変換 */
async function drawObject(sink, o) {
  const doc = sink.doc;
  const ops = sink.ops;
  const [x, y, w, h] = o.rect;
  const opacity = o.opacity ?? 1;
  ops.push(op('q'));
  if (o.angle && ANGLE_TYPES.has(o.type)) ops.push(op('cm', ...rotationMatrix(o.angle, x + w / 2, y + h / 2)));
  if (o.type === 'highlight') ops.push(op('gs', PDFName.of(sink.gs(opacity, 'Multiply'))));
  else if (opacity < 1) ops.push(op('gs', PDFName.of(sink.gs(opacity))));

  const stroke = () => { const [r, g, b] = hexToRgb(o.color); ops.push(op('RG', r, g, b), op('w', o.width ?? 1)); };
  const fill = (hex) => { const [r, g, b] = hexToRgb(hex); ops.push(op('rg', r, g, b)); };

  switch (o.type) {
    case 'rect':
    case 'ellipse':
    case 'redact': {
      const lw = o.type === 'redact' ? 1.5 : (o.width ?? 1);
      const inset = lw / 2;
      if (o.type === 'redact') { ops.push(op('RG', 0.9, 0.1, 0.1), op('w', lw)); fill('#000000'); ops.push(op('gs', PDFName.of(sink.gs(0.35)))); }
      else { stroke(); if (o.fill) fill(o.fill); }
      if (o.type === 'ellipse') pathEllipse(ops, x + inset, y + inset, w - lw, h - lw);
      else ops.push(op('re', x + inset, y + inset, w - lw, h - lw));
      ops.push(op(o.type === 'redact' || o.fill ? 'B' : 'S'));
      break;
    }
    case 'line':
    case 'arrow': {
      stroke();
      ops.push(op('J', 1));
      const [p1, p2] = o.points;
      ops.push(op('m', p1[0], p1[1]), op('l', p2[0], p2[1]), op('S'));
      if (o.type === 'arrow') {
        const ang = Math.atan2(p2[1] - p1[1], p2[0] - p1[0]);
        const len = Math.max(8, (o.width ?? 1) * 4);
        const a1 = ang + Math.PI * 0.85, a2 = ang - Math.PI * 0.85;
        fill(o.color);
        ops.push(op('m', p2[0], p2[1]), op('l', p2[0] + Math.cos(a1) * len, p2[1] + Math.sin(a1) * len),
          op('l', p2[0] + Math.cos(a2) * len, p2[1] + Math.sin(a2) * len), op('h'), op('f'));
      }
      break;
    }
    case 'ink': {
      stroke();
      ops.push(op('J', 1), op('j', 1));
      for (const s of o.strokes) {
        s.forEach((p, i) => ops.push(op(i ? 'l' : 'm', p[0], p[1])));
        if (s.length === 1) ops.push(op('l', s[0][0] + 0.1, s[0][1]));
        ops.push(op('S'));
      }
      break;
    }
    case 'highlight':
    case 'underline':
    case 'strike': {
      const [r, g, b] = hexToRgb(o.color);
      for (const q of o.quads) {
        const [qx, qy, qw, qh] = q;
        if (o.type === 'highlight') { ops.push(op('rg', r, g, b), op('re', qx, qy, qw, qh), op('f')); continue; }
        const ly = o.type === 'underline' ? qy + qh * 0.08 : qy + qh * 0.45;
        ops.push(op('RG', r, g, b), op('w', Math.max(0.8, qh * 0.07)), op('m', qx, ly), op('l', qx + qw, ly), op('S'));
      }
      break;
    }
    case 'text':
    case 'edit': {
      if (o.type === 'edit' || o.fill) { fill(o.type === 'edit' ? '#ffffff' : o.fill); ops.push(op('re', x, y, w, h), op('f')); }
      if (o.type === 'text' && o.borderColor) { const [r, g, b] = hexToRgb(o.borderColor); ops.push(op('RG', r, g, b), op('w', 1), op('re', x + 0.5, y + 0.5, w - 1, h - 1), op('S')); }
      const font = await textFont(doc, o.text, !!o.bold);
      const pad = o.type === 'edit' ? 0 : 3;
      textOps(sink, font, o.text || '', o.fontSize || 12, o.fontColor || '#000000', x + pad, y + h - pad, o.type === 'edit' ? 0 : w - pad * 2, o.align);
      break;
    }
    case 'note': {
      fill(o.color || '#ffd43b');
      ops.push(op('RG', 0.45, 0.35, 0), op('w', 0.8));
      ops.push(op('m', x, y), op('l', x + w, y), op('l', x + w, y + h * 0.7), op('l', x + w * 0.7, y + h), op('l', x, y + h), op('h'), op('B'));
      ops.push(op('m', x + 4, y + h * 0.65), op('l', x + w - 6, y + h * 0.65), op('m', x + 4, y + h * 0.45), op('l', x + w - 4, y + h * 0.45),
        op('m', x + 4, y + h * 0.25), op('l', x + w - 4, y + h * 0.25), op('S'));
      break;
    }
    case 'image': {
      const img = await embedDataUrl(doc, o.src);
      const name = sink.image(img);
      ops.push(op('cm', w, 0, 0, h, x, y), op('Do', PDFName.of(name)));
      break;
    }
    case 'measure': {
      stroke();
      ops.push(op('J', 1), op('j', 1));
      const pts = o.points;
      if (o.kind === 'area') {
        const path = () => { pts.forEach((p, i) => ops.push(op(i ? 'l' : 'm', p[0], p[1]))); ops.push(op('h')); };
        if (o.fill) {
          // 塗りは薄く（線の濃さとは別）
          const [fr, fg, fb] = hexToRgb(o.fill);
          ops.push(op('q'), op('gs', PDFName.of(sink.gs(0.2 * opacity))), op('rg', fr, fg, fb));
          path();
          ops.push(op('f'), op('Q'));
        }
        path();
        ops.push(op('S'));
      } else {
        pts.forEach((p, i) => ops.push(op(i ? 'l' : 'm', p[0], p[1])));
        ops.push(op('S'));
        // 端点に目盛り（線に直角の短い線）
        const tick = Math.max(4, (o.width ?? 1) * 3);
        for (const [a, b] of [[pts[0], pts[1]], [pts[pts.length - 1], pts[pts.length - 2]]]) {
          const ang = Math.atan2(b[1] - a[1], b[0] - a[0]) + Math.PI / 2;
          ops.push(op('m', a[0] - Math.cos(ang) * tick, a[1] - Math.sin(ang) * tick), op('l', a[0] + Math.cos(ang) * tick, a[1] + Math.sin(ang) * tick), op('S'));
        }
      }
      // 測定値のラベル（白地に文字。ページの向きに合わせて正立）
      const L = measureLabel(o);
      const font = await jpFont(doc);
      const fs = MEASURE_LABEL_SIZE;
      const tw = font.widthOfTextAtSize(L.text, fs);
      const bw = tw + 6, bh = fs * 1.5;
      ops.push(op('q'), op('cm', ...rotationMatrix(L.angle, L.cx, L.cy)));
      ops.push(op('rg', 1, 1, 1), op('re', L.cx - bw / 2, L.cy - bh / 2, bw, bh), op('f'));
      const name = sink.font(font);
      const [r, g, b] = hexToRgb(o.color);
      ops.push(op('BT'), op('rg', r, g, b), op('Tf', PDFName.of(name), fs), op('Tm', 1, 0, 0, 1, L.cx - tw / 2, L.cy - fs * 0.35), op('Tj', font.encodeText(L.text)), op('ET'));
      ops.push(op('Q'));
      break;
    }
    case 'link':
      break;
  }
  ops.push(op('Q'));
}

const SUBTYPES = { rect: 'Square', ellipse: 'Circle', redact: 'Square', line: 'Line', arrow: 'Line', ink: 'Ink', highlight: 'Highlight', underline: 'Underline', strike: 'StrikeOut', text: 'FreeText', edit: 'FreeText', note: 'Text', image: 'Stamp', link: 'Link', measure: 'Line' };

function quadPoints(o) {
  const out = [];
  for (const [qx, qy, qw, qh] of o.quads) out.push(qx, qy + qh, qx + qw, qy + qh, qx, qy, qx + qw, qy);
  return out;
}

async function addAnnotation(doc, page, pageRefs, o) {
  const ctx = doc.context;
  const [x, y, w, h] = objBounds(o);
  const pad = (o.type === 'line' || o.type === 'arrow' || o.type === 'ink' || o.type === 'measure') ? (o.width ?? 1) * 4 + 4 : 1;
  const rect = [x - pad, y - pad, x + w + pad, y + h + pad];
  const store = { ...o };
  delete store.id;
  const dict = {
    Type: 'Annot',
    Subtype: SUBTYPES[o.type],
    Rect: rect,
    F: 4,
    P: page.ref,
    NM: PDFString.of(o.id),
    M: PDFString.fromDate(new Date()),
    [STUDIO_KEY]: PDFHexString.fromText(JSON.stringify(store))
  };
  if (o.contents || o.text) dict.Contents = PDFHexString.fromText(o.contents || o.text);
  if (o.color) dict.C = hexToRgb(o.color);
  if (o.type !== 'link') {
    const sink = new OpSink(doc);
    await drawObject(sink, o);
    const xo = ctx.formXObject(sink.ops, { BBox: rect, Matrix: [1, 0, 0, 1, 0, 0], Resources: sink.resources() });
    dict.AP = { N: ctx.register(xo) };
  }
  if (o.opacity != null && o.opacity < 1) dict.CA = o.opacity;
  switch (o.type) {
    case 'highlight': case 'underline': case 'strike':
      dict.QuadPoints = quadPoints(o);
      break;
    case 'line': case 'arrow':
      dict.L = [...o.points[0], ...o.points[1]];
      dict.BS = { W: o.width ?? 1 };
      if (o.type === 'arrow') dict.LE = [PDFName.of('None'), PDFName.of('OpenArrow')];
      break;
    case 'ink':
      dict.InkList = o.strokes.map((s) => s.flat());
      dict.BS = { W: o.width ?? 1 };
      break;
    case 'rect': case 'ellipse':
      dict.BS = { W: o.width ?? 1 };
      if (o.fill) dict.IC = hexToRgb(o.fill);
      break;
    case 'text': case 'edit': {
      const [r, g, b] = hexToRgb(o.fontColor || '#000000');
      dict.DA = PDFString.of(`/Helv ${o.fontSize || 12} Tf ${r} ${g} ${b} rg`);
      dict.BS = { W: 0 };
      break;
    }
    case 'note':
      dict.Name = 'Comment';
      dict.T = PDFHexString.fromText(o.author || 'PDF Studio');
      break;
    case 'measure': {
      const sc = o.scale || DEFAULT_SCALE;
      const num = (u, c) => ({ Type: 'NumberFormat', U: PDFHexString.fromText(u), C: c, D: 10 ** (sc.decimals ?? 1) });
      dict.Measure = {
        Type: 'Measure', Subtype: 'RL',
        R: PDFHexString.fromText(sc.label || '1:1'),
        X: [num(sc.unit, sc.factor)], D: [num(sc.unit, 1)], A: [num(`${sc.unit}²`, 1)]
      };
      dict.BS = { W: o.width ?? 1 };
      dict.Contents = PDFHexString.fromText(`${measureValue(o).label}: ${measureValue(o).text}`);
      if (o.kind === 'distance') {
        dict.Subtype = 'Line';
        dict.L = [...o.points[0], ...o.points[1]];
        dict.IT = 'LineDimension';
        dict.Cap = true;
      } else {
        dict.Subtype = o.kind === 'area' ? 'Polygon' : 'PolyLine';
        dict.Vertices = o.points.flat();
        dict.IT = o.kind === 'area' ? 'PolygonDimension' : 'PolyLineDimension';
        if (o.kind === 'area' && o.fill) dict.IC = hexToRgb(o.fill);
      }
      break;
    }
    case 'link':
      dict.Border = [0, 0, 0];
      if (o.url) dict.A = { S: 'URI', URI: PDFString.of(o.url) };
      else if (o.page != null && pageRefs[o.page]) dict.Dest = [pageRefs[o.page], PDFName.of('Fit')];
      break;
  }
  const ref = ctx.register(ctx.obj(dict));
  page.node.addAnnot(ref);
}

/**
 * 保存用バイト列を作る
 * @param {object} opt flatten: 注釈をページに焼き込む / security: 暗号化設定
 */
export async function buildOutput({ flatten = false, security = state.security, objects = state.objects } = {}) {
  const base = await saveLib();
  const doc = await PDFDocument.load(base, { updateMetadata: false });
  const pages = doc.getPages();
  const pageRefs = pages.map((p) => p.ref);
  for (let i = 0; i < pages.length; i++) {
    const list = objects[state.pageIds[i]] || [];
    for (const o of list) {
      if (flatten) {
        if (o.type === 'link') { await addAnnotation(doc, pages[i], pageRefs, o); continue; }
        if (o.type === 'redact') continue;
        const sink = new OpSink(doc);
        await drawObject(sink, o);
        const page = pages[i];
        const res = sink.resources();
        const map = {};
        for (const [k, ref] of Object.entries(res.Font || {})) map[k] = page.node.newFontDictionary(k, ref);
        for (const [k, ref] of Object.entries(res.XObject || {})) map[k] = page.node.newXObject(k, ref);
        for (const [k, d] of Object.entries(res.ExtGState || {})) map[k] = page.node.newExtGState(k, d);
        // 新しいリソース名に置き換える
        const ops = sink.ops.map((o2) => {
          const args = o2.args?.map((a) => (a instanceof PL.PDFName && map[a.asString().slice(1)] ? map[a.asString().slice(1)] : a));
          return args ? PL.PDFOperator.of(o2.name, args) : o2;
        });
        page.pushOperators(op('q'), ...ops, op('Q'));
      } else {
        await addAnnotation(doc, pages[i], pageRefs, o);
      }
    }
  }
  // 入力したフォームの外観を日本語フォントで作り直す（変更のあったフィールドだけ）
  const form = doc.getForm();
  const fields = form.getFields();
  if (fields.length) {
    if (fields.some((f) => f.needsAppearancesUpdate())) {
      try { form.updateFieldAppearances(await jpFont(doc)); } catch (e) { console.warn('form appearance', e); }
    }
    if (flatten) form.flatten();
  }
  doc.setProducer('PDF Studio for Windows');
  doc.setModificationDate(new Date());
  if (security && (security.user || security.owner)) {
    doc.encrypt({
      userPassword: security.user || '',
      ownerPassword: security.owner || security.user,
      permissions: security.permissions || { printing: 'highResolution', modifying: true, copying: true, annotating: true, fillingForms: true, contentAccessibility: true, documentAssembly: true }
    });
  }
  await doc.flush();
  collectGarbage(doc);
  return doc.save({ useObjectStreams: true, updateFieldAppearances: false });
}

// ---------------------------------------------------------------- ページ構造の操作ヘルパー

export function rotatePages(doc, indexes, delta) {
  for (const i of indexes) {
    const p = doc.getPage(i);
    p.setRotation(degrees((((p.getRotation().angle + delta) % 360) + 360) % 360));
  }
}

export function deletePages(doc, indexes) {
  const objects = { ...state.objects };
  for (const i of [...indexes].sort((a, b) => b - a)) {
    doc.removePage(i);
    const pid = state.pageIds.splice(i, 1)[0];
    delete objects[pid];
  }
  state.objects = objects;
}

/**
 * ページの並びを order（現在のインデックスの配列）にする。
 * ページツリーを 1 階層にして Kids を並べ替えるので、ページの複製も参照の付け替えも起きない。
 */
export function reorderPages(doc, order) {
  const pages = doc.getPages();
  const refs = pages.map((p) => p.ref);
  // 親から受け継いでいた属性をページ自身に持たせてから、ツリーを平らにする
  for (const p of pages) {
    for (const key of ['Resources', 'MediaBox', 'CropBox', 'Rotate']) {
      const k = PDFName.of(key);
      if (!p.node.has(k)) {
        const v = p.node.getInheritableAttribute(k);
        if (v) p.node.set(k, v);
      }
    }
  }
  const rootRef = doc.catalog.get(PDFName.of('Pages'));
  const root = doc.catalog.Pages();
  root.set(PDFName.of('Kids'), doc.context.obj(order.map((i) => refs[i])));
  root.set(PDFName.of('Count'), PDFNumber.of(order.length));
  for (const p of pages) p.node.set(PDFName.of('Parent'), rootRef);
  doc.pageCache.invalidate();
  state.pageIds = order.map((i) => state.pageIds[i]);
}

/** indexes のページを target（挿入位置, 移動前基準）へ移動。新しい先頭位置を返す */
export function movePages(doc, indexes, target) {
  const n = doc.getPageCount();
  const moving = [...new Set(indexes)].sort((a, b) => a - b);
  const rest = [...Array(n).keys()].filter((i) => !moving.includes(i));
  const t = target - moving.filter((i) => i < target).length;
  const order = [...rest.slice(0, t), ...moving, ...rest.slice(t)];
  reorderPages(doc, order);
  return t;
}

/** ページを浅く複製する（内容・リソースは共有し、注釈だけ複製） */
function clonePage(doc, src) {
  const ctx = doc.context;
  const leaf = PDFPageLeaf.fromMapWithContext(new Map(src.node.entries()), ctx);
  for (const key of ['Resources', 'MediaBox', 'CropBox', 'Rotate']) {
    const k = PDFName.of(key);
    if (!leaf.has(k)) {
      const v = src.node.getInheritableAttribute(k);
      if (v) leaf.set(k, v);
    }
  }
  leaf.delete(PDFName.of('Parent'));
  leaf.delete(PDFName.of('Annots'));
  leaf.delete(PDFName.of('StructParents'));
  const ref = ctx.register(leaf);
  // フォーム以外の注釈を複製（ポップアップとの関連も付け替える）
  const annots = src.node.Annots();
  if (annots) {
    const map = new Map();
    const copies = [];
    for (let i = 0; i < annots.size(); i++) {
      const aRef = annots.get(i);
      const a = annots.lookup(i);
      if (!(a instanceof PDFDict) || a.get(PDFName.of('Subtype')) === PDFName.of('Widget')) continue;
      const c = a.clone(ctx);
      const cRef = ctx.register(c);
      if (aRef instanceof PDFRef) map.set(aRef.tag, cRef);
      copies.push([c, cRef]);
    }
    for (const [c] of copies) {
      c.set(PDFName.of('P'), ref);
      for (const key of ['Popup', 'Parent', 'IRT']) {
        const v = c.get(PDFName.of(key));
        if (v instanceof PDFRef && map.has(v.tag)) c.set(PDFName.of(key), map.get(v.tag));
      }
    }
    if (copies.length) leaf.set(PDFName.of('Annots'), ctx.obj(copies.map(([, r]) => r)));
  }
  return PDFPage.of(leaf, ref, doc);
}

export function duplicatePages(doc, indexes) {
  const sorted = [...new Set(indexes)].sort((a, b) => a - b);
  const at = sorted[sorted.length - 1] + 1;
  const objects = { ...state.objects };
  sorted.forEach((srcIndex, k) => {
    const page = clonePage(doc, doc.getPage(srcIndex));
    doc.insertPage(at + k, page);
    const pid = newId('p');
    const srcPid = state.pageIds[srcIndex];
    state.pageIds.splice(at + k, 0, pid);
    objects[pid] = (objects[srcPid] || []).map((o) => ({ ...cloneObject(o), id: newId() }));
  });
  state.objects = objects;
}

export function insertBlank(doc, at, size) {
  doc.insertPage(at, size);
  const pid = newId('p');
  state.pageIds.splice(at, 0, pid);
  state.objects = { ...state.objects, [pid]: [] };
}

/** 別の PDF / 画像のバイト列からページを挿入。暗号化 PDF はパスワードを尋ねる */
export async function insertFromSources(doc, at, sources, askPassword) {
  let n = 0;
  const { sniffKind, embedImage } = await import('./sources.js');
  for (const s of sources) {
    const kind = sniffKind(s.name, s.bytes);
    if (kind === 'pdf') {
      const { lib: src } = await loadLib(new Uint8Array(s.bytes), askPassword, s.name);
      const pages = await doc.copyPages(src, src.getPageIndices());
      for (const p of pages) { doc.insertPage(at + n, p); n++; }
    } else if (kind === 'tiff') {
      const { addTiffPages } = await import('./tiff.js');
      n += await addTiffPages(doc, s.bytes, { insertAt: at + n });
    } else if (kind === 'png' || kind === 'jpeg' || kind === 'image') {
      const img = await embedImage(doc, kind, s.bytes);
      const page = doc.insertPage(at + n, [img.width * 0.75, img.height * 0.75]);
      page.drawImage(img, { x: 0, y: 0, width: img.width * 0.75, height: img.height * 0.75 });
      n++;
    } else {
      throw new Error(`${s.name}: ${t('対応していない形式')}`);
    }
  }
  const objects = { ...state.objects };
  for (let k = 0; k < n; k++) {
    const pid = newId('p');
    state.pageIds.splice(at + k, 0, pid);
    objects[pid] = [];
  }
  state.objects = objects;
  return n;
}

/** ページを画像に置き換える（墨消し・圧縮用）。注釈は keep が true のものだけ残す */
export async function replaceWithImage(doc, index, jpegBytes, keepAnnot = () => true) {
  const old = doc.getPage(index);
  const crop = old.getCropBox();
  const img = await doc.embedJpg(jpegBytes);
  const page = doc.insertPage(index, [crop.width, crop.height]);
  page.setMediaBox(crop.x, crop.y, crop.width, crop.height);
  page.drawImage(img, { x: crop.x, y: crop.y, width: crop.width, height: crop.height });
  page.setRotation(old.getRotation());
  const annots = old.node.Annots();
  if (annots) {
    const keep = [];
    for (let i = 0; i < annots.size(); i++) {
      const a = annots.lookup(i);
      if (a instanceof PDFDict && keepAnnot(a)) {
        a.set(PDFName.of('P'), page.ref);
        keep.push(annots.get(i));
      }
    }
    if (keep.length) page.node.set(PDFName.of('Annots'), doc.context.obj(keep));
  }
  doc.removePage(index + 1);
}

/** 表示上の向き（回転後）でページに描画するための変換行列と表示サイズ */
export function displayTransform(page) {
  const c = page.getCropBox();
  const W = c.width, H = c.height;
  const rot = ((page.getRotation().angle % 360) + 360) % 360;
  switch (rot) {
    case 90: return { m: [0, 1, -1, 0, c.x + W, c.y], w: H, h: W };
    case 180: return { m: [-1, 0, 0, -1, c.x + W, c.y + H], w: W, h: H };
    case 270: return { m: [0, -1, 1, 0, c.x, c.y + H], w: H, h: W };
    default: return { m: [1, 0, 0, 1, c.x, c.y], w: W, h: H };
  }
}

export function withDisplaySpace(page, draw) {
  const t = displayTransform(page);
  page.pushOperators(op('q'), op('cm', ...t.m));
  draw(t.w, t.h);
  page.pushOperators(op('Q'));
}

/**
 * 注釈（他のアプリで付けたものを含む）を、見た目（外観ストリーム）ごとページの内容に焼き込んで削除する。
 * リンクは残す。非表示の注釈・外観のない注釈は削除だけする。フォームは先に form.flatten() しておくこと
 */
export function flattenAnnotations(doc) {
  const num = (o) => (o?.asNumber ? o.asNumber() : 0);
  let n = 0;
  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    const keep = [];
    for (let k = 0; k < annots.size(); k++) {
      const ref = annots.get(k);
      const annot = doc.context.lookup(ref);
      if (!(annot instanceof PDFDict)) continue;
      const sub = annot.lookup(PDFName.of('Subtype'))?.asString?.();
      if (sub === '/Link') { keep.push(ref); continue; }
      const flags = num(annot.lookup(PDFName.of('F')));
      const rect = annot.lookup(PDFName.of('Rect'))?.asArray?.().map(num);
      const apDict = annot.lookup(PDFName.of('AP'));
      let entry = apDict instanceof PDFDict ? apDict.get(PDFName.of('N')) : null;
      let ap = entry ? doc.context.lookup(entry) : null;
      // 状態ごとの外観（チェックボックスなど）は今の状態のものを使う
      if (ap instanceof PDFDict) {
        const as = annot.lookup(PDFName.of('AS'));
        entry = as ? ap.get(as) : null;
        ap = entry ? doc.context.lookup(entry) : null;
      }
      const hidden = flags & (2 | 32); // Hidden / NoView
      if (sub === '/Popup' || hidden || !(ap instanceof PDFStream) || !rect) continue;
      const apRef = entry instanceof PDFRef ? entry : doc.context.register(ap);
      const bbox = ap.dict.lookup(PDFName.of('BBox'))?.asArray?.().map(num) || [0, 0, 1, 1];
      const m = ap.dict.lookup(PDFName.of('Matrix'))?.asArray?.().map(num) || [1, 0, 0, 1, 0, 0];
      // BBox を Matrix で変換した範囲を、注釈の Rect に合わせる（PDF 仕様 12.5.5）
      const pts = [[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[0], bbox[3]], [bbox[2], bbox[3]]].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
      const bx = Math.min(...pts.map((p) => p[0])), by = Math.min(...pts.map((p) => p[1]));
      const bw = Math.max(...pts.map((p) => p[0])) - bx || 1, bh = Math.max(...pts.map((p) => p[1])) - by || 1;
      const [rx1, ry1, rx2, ry2] = rect;
      const sx = (Math.abs(rx2 - rx1)) / bw, sy = (Math.abs(ry2 - ry1)) / bh;
      const name = page.node.newXObject('FlatAnnot', apRef);
      page.pushOperators(op('q'), op('cm', sx, 0, 0, sy, Math.min(rx1, rx2) - bx * sx, Math.min(ry1, ry2) - by * sy), op('Do', name), op('Q'));
      n++;
    }
    if (keep.length) page.node.set(PDFName.of('Annots'), doc.context.obj(keep));
    else page.node.delete(PDFName.of('Annots'));
  }
  return n;
}

/** 認識した文字を透明テキストとしてページに重ねる（OCR） */
export async function addInvisibleText(doc, index, lines) {
  const page = doc.getPage(index);
  const font = await jpFont(doc);
  const name = page.node.newFontDictionary('OCR', font.ref);
  const ops = [op('q'), op('BT'), op('Tr', 3)];
  for (const l of lines) {
    const text = l.text.trim();
    if (!text) continue;
    const [x, y, w, h] = l.rect;
    const size = Math.max(4, h * 0.85);
    const tw = font.widthOfTextAtSize(text, size) || 1;
    ops.push(op('Tf', name, size), op('Tm', w / tw, 0, 0, 1, x, y + h * 0.18), op('Tj', font.encodeText(text)));
  }
  ops.push(op('ET'), op('Q'));
  page.pushOperators(...ops);
}

/** 文書情報（タイトルなど）を更新する。ページ構造は変わらないので再読み込みしない */
export function setMetadata({ title, author, subject, keywords }) {
  const lib = state.lib;
  lib.setTitle(title);
  lib.setAuthor(author);
  lib.setSubject(subject);
  lib.setKeywords(keywords);
  state.formDirty = true; // 次の構造変更・保存時に反映
  setDirty(true);
}
