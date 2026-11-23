// メニューから呼ばれる文書操作
import {
  state, bus, PL, pdfjsLib, PDFJS_OPTS, hasDoc, pageCount, openBytes, newBlankDocument, buildOutput, changeStructure, setDirty, can, loadLib,
  rotatePages, deletePages, movePages, duplicatePages, insertBlank, insertFromSources, replaceWithImage,
  withDisplaySpace, addInvisibleText, jpFont, textFont, THAI, pageText, hexToRgb, setMetadata, objBounds,
  UNITS, scaleFactor, setMeasureScale, measureValue, normalizePageSize, PAPER_SIZES
} from './doc.js';
import { scrollToPage, currentPage, select, setTool, currentScale, startCalibration } from './viewer.js';
import { ask, alertBox, confirmBox, toast, progress, parseRange, compactRange, canvasToBytes, baseName, formatBytes, el } from './util.js';
import { selectedPages } from './panels.js';
import { isTiff, addTiffPages, lastStats as tiffStats } from './tiff.js';
import { scanInfo, scanAvailable, renderScan, drawScan } from './scanpages.js';
import { t } from './i18n.js';
import { sniffKind, embedImage } from './sources.js';
import { darkMask, analyzeFull as analyzeOverlayFull } from './overlay.js';
export { sniffKind } from './sources.js';

const { PDFDocument, rgb, degrees } = PL;
const PDF_FILTER = [{ name: 'PDF / TIFF', extensions: ['pdf', 'tif', 'tiff'] }, { name: 'PDF', extensions: ['pdf'] }, { name: 'TIFF 画像', extensions: ['tif', 'tiff'] }];
const SOURCE_EXT = ['pdf', 'png', 'jpg', 'jpeg', 'tif', 'tiff', 'gif', 'bmp', 'webp'];

export async function askPassword(message) {
  const r = await ask({ title: 'パスワード', message, fields: [{ key: 'pw', label: 'パスワード', type: 'password' }] });
  return r ? r.pw : null;
}

function requireDoc() {
  if (!hasDoc()) { toast('PDF を開いてください'); return false; }
  return true;
}

/** 作成者による制限を確認する */
function allowed(kind) {
  if (can(kind)) return true;
  const what = { modify: '内容の変更', assemble: 'ページの追加・削除・並べ替え', print: '印刷', copy: '内容のコピー・書き出し', annotate: '注釈の追加' }[kind] || 'この操作';
  alertBox('この操作はできません', `この文書は作成者により「${what}」が禁止されています。`);
  return false;
}

// ---------------------------------------------------------------- 開く・保存

export async function openDialog() {
  const files = await window.api.openDialog({ title: 'PDF を開く', filters: PDF_FILTER, multiple: true });
  for (const [k, f] of files.entries()) {
    if (!hasDoc() && k === 0) await openHere(f.bytes, f.path, f.name);
    else await window.api.openInNewWindow(f.bytes, f.name, f.path);
  }
}

export async function openHere(bytes, path, name) {
  try {
    const t0 = performance.now();
    if (isTiff(name)) {
      // 元のファイルの場所が分かるときだけ「変換しただけ」とする（閉じるときに確かめない）。
      // 場所が分からない（ディスク上にないものをドロップした）ときは、閉じると取り戻せないので確かめる
      await openTiff(bytes, name, { converted: !!path });
      if (path) window.api.docSource(path); // TIFF は PDF として保存するので state.path は空のまま。元のファイルだけ知らせる
      logOpenTime('tiff', bytes, t0);
      return;
    }
    await openBytes(bytes, { path, name, askPassword });
    if (path) window.api.docSource(path);
    logOpenTime('pdf', bytes, t0);
    if (state.security?.restricted) {
      toast('この文書には作成者による編集の制限があります。許可された操作だけ行えます。', 5000);
    } else if (state.security?.inherited && state.security.user) {
      toast('パスワード保護を引き継いで保存します（「文書 > パスワード保護を解除」で解除）', 4000);
    }
  } catch (e) {
    if (e.message !== 'CANCELLED') await alertBox('PDF を開けませんでした', e.message);
  }
}

/** 開くまでの時間を記録する（形式・大きさ・ページ数・時間だけ。ファイル名は書かない）。最初のページが描かれた時間も測る */
function logOpenTime(kind, bytes, t0) {
  const opened = Math.round(performance.now() - t0);
  const mb = ((bytes?.length || bytes?.byteLength || 0) / 1048576).toFixed(1);
  const pages = pageCount();
  let done = false;
  const finish = (how) => {
    if (done) return;
    done = true;
    bus.removeEventListener('render-idle', onIdle);
    window.api.logInfo(`open timing: ${kind} ${mb}MB ${pages}p opened ${opened}ms, first view ${Math.round(performance.now() - t0)}ms (${how}), since start ${Math.round(performance.now())}ms`);
  };
  const onIdle = () => finish('idle');
  bus.addEventListener('render-idle', onIdle);
  setTimeout(() => finish('timeout'), 20000);
}

/** TIFF は PDF に変換して開く（保存するときは PDF として保存先を尋ねる） */
async function openTiff(bytes, name, { converted = true } = {}) {
  const doc = await PDFDocument.create();
  let pr = null;
  const t0 = Date.now();
  // 実機での速さを確かめられるよう、形式と時間だけを記録する（ファイル名は書かない）
  const logTiff = (msg) => window.api.logInfo?.(`tiff ${msg}`);
  try {
    await addTiffPages(doc, bytes, {
      ...(window.__tiffPassthru != null ? { passthruG4: window.__tiffPassthru } : {}), // 計測用
      onStart: (info) => logTiff(`start: ${JSON.stringify(info)}`),
      onPage: (k, n) => {
        // 時間がかかるときだけ進み具合を出す
        if (!pr && n > 1 && Date.now() - t0 > 400) pr = progress('TIFF を読み込んでいます', n);
        pr?.update(k);
        if (pr?.cancelled) throw new Error('CANCELLED');
      }
    });
  } catch (e) {
    logTiff(`${e.message === 'CANCELLED' ? 'cancelled' : 'failed'} after ${Date.now() - t0}ms: ${e.message === 'CANCELLED' ? '' : String(e.message).slice(0, 120)}`);
    throw e;
  } finally {
    pr?.close();
  }
  doc.setTitle(baseName(name));
  let t = performance.now();
  const pdf = await doc.save();
  tiffStats.stages.save = performance.now() - t;
  t = performance.now();
  await openBytes(pdf, { path: null, name: `${baseName(name)}.pdf`, askPassword });
  tiffStats.stages.openPdf = performance.now() - t;
  const st = Object.entries(tiffStats.stages).map(([k, v]) => `${k}=${Math.round(v)}`).join(' ');
  logTiff(`open: ${Date.now() - t0}ms ${JSON.stringify(tiffStats.info)} ${st}`);
  setDirty(true, { converted }); // 変換しただけ（編集するまで異常終了時の写しは作らず、閉じるときも確かめない）
  toast(`TIFF（${pageCount()} ページ）を PDF として開きました。保存すると PDF になります。`, 4000);
}

/** 新しい文書を開く：空のウィンドウならここで、文書があれば別ウィンドウで */
async function openResult(bytes, name) {
  if (!hasDoc()) { await openHere(bytes, null, name); setDirty(true); }
  else await window.api.openInNewWindow(bytes, name, null);
}

export async function save() {
  if (!requireDoc()) return false;
  if (!state.path) return saveAs();
  return writeTo(state.path);
}

export async function saveAs() {
  if (!requireDoc()) return false;
  const p = await window.api.saveDialog({ title: '名前を付けて保存', defaultPath: state.path || state.name, filters: PDF_FILTER });
  if (!p) return false;
  return writeTo(p);
}

async function writeTo(path) {
  try {
    const bytes = await buildOutput();
    await window.api.writeFile(path, bytes);
    state.path = path;
    state.name = path.split(/[\\/]/).pop();
    setDirty(false);
    window.api.docSource(path);
    toast('保存しました');
    return true;
  } catch (e) {
    console.error(e);
    await alertBox('保存できませんでした', e.message);
    return false;
  }
}

export async function saveAndClose() {
  if (await save()) window.api.closeWindow();
  else window.api.saveCloseFailed();
}

export async function newBlank() {
  if (hasDoc()) {
    const lib = await PDFDocument.create();
    lib.addPage([595.28, 841.89]);
    await window.api.openInNewWindow(await lib.save(), '名称未設定.pdf', null);
  } else {
    await newBlankDocument();
  }
}

// ---------------------------------------------------------------- 作成・結合

// ファイルから作成で扱う形式。拡張子ではなく中身（先頭のバイト）で見分ける（拡張子と中身が違うファイルがあるため）
export const CREATE_EXT = ['pdf', 'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'tif', 'tiff', 'docx', 'txt', 'html', 'htm', 'md', 'csv'];

/** ファイルを 1 つの PDF にまとめる。読めなかったファイルは skipped に { name, reason, cancelled } で入れる */
export async function sourcesToPdf(files, skipped = []) {
  const out = await PDFDocument.create();
  for (const f of files) {
    const kind = sniffKind(f.name, f.bytes);
    try {
      if (!kind) { skipped.push({ name: f.name, reason: t('対応していない形式') }); continue; }
      let src = null;
      if (kind === 'pdf') {
        src = (await loadLib(new Uint8Array(f.bytes), askPassword, f.name)).lib;
      } else if (kind === 'png' || kind === 'jpeg' || kind === 'image') {
        const img = await embedImage(out, kind, f.bytes);
        const w = img.width * 0.75, h = img.height * 0.75;
        out.addPage([w, h]).drawImage(img, { x: 0, y: 0, width: w, height: h });
        continue;
      } else if (kind === 'tiff') {
        await addTiffPages(out, f.bytes);
        continue;
      } else {
        src = await PDFDocument.load(await window.api.convertToPdf(f.path || { bytes: f.bytes, name: f.name }));
      }
      // 壊れた PDF は読み込めても、ページを写すときに失敗することがある
      const pages = await out.copyPages(src, src.getPageIndices());
      pages.forEach((p) => out.addPage(p));
    } catch (e) {
      if (e?.message === 'CANCELLED') {
        skipped.push({ name: f.name, reason: t('パスワードが入力されなかったため処理しませんでした'), cancelled: true });
        continue;
      }
      skipped.push({ name: f.name, reason: `${t('読み込めませんでした')}: ${e?.message || e}` });
      window.api.logError('handled', { message: `sources: ${e?.message}`, stack: `sources: ${e?.stack || e}` });
    }
  }
  return out;
}

/** 読めなかったファイルを知らせる */
async function reportSkipped(skipped) {
  if (!skipped.length) return;
  const lines = skipped.slice(0, 10).map((x) => `- ${x.name} — ${x.reason}`);
  if (skipped.length > 10) lines.push(`… +${skipped.length - 10}`);
  await alertBox(t('次のファイルは PDF にできませんでした'), lines.join('\n') + '\n\n' + t('対応している形式: PDF・画像（PNG / JPEG / GIF / BMP / WebP / TIFF）・Word（.docx）・テキスト（.txt / .md / .csv / .html）'));
}

// ---------------------------------------------------------------- ドラッグ＆ドロップ

// ドロップで PDF にする形式。テキストは拡張子も確かめる（文字だけの .json や .js などまで PDF にしないように）
const DROP_TEXT_EXT = /\.(txt|md|csv|html?)$/i;
const isDropPdfOrTiff = (name) => /\.(pdf|tiff?)$/i.test(name);

/** ドロップされたファイルのうち、PDF にして開くものか（先頭のバイトだけで決める） */
export function droppedKind(name, head) {
  if (isDropPdfOrTiff(name)) return 'open';
  const kind = sniffKind(name, head);
  if (kind === 'text') return DROP_TEXT_EXT.test(name) ? 'text' : null;
  return kind;
}

/** ドロップされたファイルを開く形にそろえる。PDF・TIFF はそのまま、画像・Word・テキストは 1 ファイルずつ PDF にする */
export async function prepareDropped(files, skipped = []) {
  const items = [];
  for (const f of files) {
    const kind = droppedKind(f.name, f.bytes || new Uint8Array(0));
    // TIFF だけ元の場所を残す（PDF に場所を付けると「保存」で元のファイルを上書きするようになるため付けない）
    if (kind === 'open') { items.push({ bytes: f.bytes, name: f.name, converted: false, path: isTiff(f.name) && f.path ? f.path : null }); continue; }
    if (!kind) { skipped.push({ name: f.name, reason: t('対応していない形式') }); continue; }
    // 場所は使わずに中身から変換する（ドロップでは場所が分からないことがある）
    const doc = await sourcesToPdf([{ name: f.name, bytes: f.bytes }], skipped);
    if (doc.getPageCount()) items.push({ bytes: await doc.save(), name: `${baseName(f.name)}.pdf`, converted: true });
  }
  return items;
}

let dropQueue = Promise.resolve();
/** ドロップされたファイルを開く。files は { name, bytes } の並び（対応していない形式は先頭だけでよい）。
 *  前のドロップを処理している途中なら、終わってから続けて処理する（捨てない） */
export function openDropped(files) {
  if (!files.length) return dropQueue;
  // 失敗しても列は必ず元に戻す（次のドロップが止まらないように）
  dropQueue = dropQueue.then(() => openDroppedNow(files))
    .catch((e) => alertBox('PDF を開けませんでした', e?.message || String(e)))
    .catch(() => {});
  return dropQueue;
}

async function openDroppedNow(files) {
  const skipped = [];
  const items = await prepareDropped(files, skipped);
  // 結果を新しいタブで開くと、このタブのお知らせは見えなくなるので、先に知らせる
  await reportSkipped(skipped);
  for (const it of items) {
    if (it.converted) await openResult(it.bytes, it.name);
    else if (!hasDoc()) await openHere(it.bytes, it.path, it.name);
    else await window.api.openInNewWindow(it.bytes, it.name, it.path);
  }
}

export async function createFromFiles() {
  const files = await window.api.openDialog({
    title: 'PDF にするファイル（複数可・選択順に結合）', multiple: true,
    filters: [{ name: '対応ファイル', extensions: CREATE_EXT }]
  });
  if (!files.length) return;
  const skipped = [];
  try {
    const doc = await sourcesToPdf(files, skipped);
    // 結果を新しいタブで開くと、このタブのお知らせは見えなくなるので、先に知らせる
    await reportSkipped(skipped);
    if (!doc.getPageCount()) {
      if (!skipped.length) await alertBox('PDF を作成できませんでした');
      return;
    }
    await openResult(await doc.save(), files.length === 1 ? `${baseName(files[0].name)}.pdf` : '新規PDF.pdf');
  } catch (e) {
    await alertBox('PDF を作成できませんでした', e.message);
  }
}

export async function mergeFiles() {
  const files = await window.api.openDialog({ title: '結合するファイル（名前順に結合）', multiple: true, filters: [{ name: 'PDF / 画像', extensions: SOURCE_EXT }] });
  if (!files.length) return;
  files.sort((a, b) => a.name.localeCompare(b.name, 'ja', { numeric: true }));
  const skipped = [];
  try {
    const doc = await sourcesToPdf(files, skipped);
    await reportSkipped(skipped);
    if (!doc.getPageCount()) {
      if (!skipped.length) await alertBox('結合できるページがありませんでした');
      return;
    }
    await openResult(await doc.save(), '結合.pdf');
  } catch (e) {
    await alertBox('結合できませんでした', e.message);
  }
}

// ---------------------------------------------------------------- ページ操作

const targets = () => {
  const s = selectedPages();
  return s.length ? s : [currentPage()];
};

export async function rotate(delta) {
  if (!requireDoc() || !allowed('assemble')) return;
  const idx = targets();
  await changeStructure((lib) => rotatePages(lib, idx, delta));
}

export async function deleteSelectedPages() {
  if (!requireDoc() || !allowed('assemble')) return;
  const idx = targets();
  if (idx.length >= pageCount()) return alertBox('すべてのページは削除できません');
  if (!(await confirmBox(`${idx.length} ページを削除しますか？`, `ページ: ${compactRange(idx)}`, '削除'))) return;
  select(null);
  await changeStructure((lib) => deletePages(lib, idx));
}

export async function duplicate() {
  if (!requireDoc() || !allowed('assemble')) return;
  const idx = targets();
  await changeStructure((lib) => duplicatePages(lib, idx));
}

export async function movePagesTo(idx, target) {
  if (!allowed('assemble')) return null;
  let at = 0;
  await changeStructure((lib) => { at = movePages(lib, idx, target); });
  return at;
}

export async function insertBlankPage() {
  if (!requireDoc() || !allowed('assemble')) return;
  const after = Math.max(...targets());
  const { width, height } = state.lib.getPage(after).getSize();
  await changeStructure((lib) => insertBlank(lib, after + 1, [width, height]));
  scrollToPage(after + 1);
}

export async function insertFile(at = null, files = null) {
  if (!requireDoc() || !allowed('assemble')) return;
  files = files || await window.api.openDialog({ title: '挿入する PDF / 画像', multiple: true, filters: [{ name: 'PDF / 画像', extensions: SOURCE_EXT }] });
  if (!files.length) return;
  const usable = files.filter((f) => /\.(pdf|png|jpe?g|tiff?|gif|bmp|webp)$/i.test(f.name));
  if (!usable.length) return alertBox('挿入できるファイルがありません', 'PDF・PNG・JPEG を指定してください。');
  const pos = at ?? Math.max(...targets()) + 1;
  let n = 0;
  try {
    await changeStructure(async (lib) => { n = await insertFromSources(lib, pos, usable, askPassword); });
    toast(`${n} ページを挿入しました`);
  } catch (e) {
    if (e.message !== 'CANCELLED') await alertBox('挿入できませんでした', e.message);
  }
}

export async function extractPages() {
  if (!requireDoc() || !allowed('assemble')) return;
  const r = await ask({
    title: 'ページを抽出', message: '抽出したページは新しいウィンドウで開きます。',
    fields: [{ key: 'range', label: 'ページ範囲', value: compactRange(targets()), placeholder: '例: 1-3, 5' }, { key: 'remove', label: '抽出したページを元の文書から削除する', type: 'checkbox' }]
  });
  if (!r) return;
  const idx = parseRange(r.range, pageCount());
  if (!idx?.length) return alertBox('ページ範囲が正しくありません');
  const full = await PDFDocument.load(await buildOutput({ security: null }));
  const out = await PDFDocument.create();
  (await out.copyPages(full, idx)).forEach((p) => out.addPage(p));
  await window.api.openInNewWindow(await out.save(), `${baseName(state.name)}_抽出.pdf`, null);
  if (r.remove && idx.length < pageCount()) await changeStructure((lib) => deletePages(lib, idx));
}

export async function split() {
  if (!requireDoc() || !allowed('assemble')) return;
  const total = pageCount();
  const r = await ask({
    title: '文書を分割', message: `全 ${total} ページ`,
    fields: [
      { key: 'mode', label: '分割方法', type: 'select', options: ['指定ページ数ごと', '範囲を指定', '1 ページずつ'], value: 0 },
      { key: 'n', label: 'ページ数', type: 'number', value: 2, min: 1 },
      { key: 'ranges', label: '範囲', placeholder: '例: 1-3, 4-8, 9-' },
      { key: 'note', type: 'note', label: '「範囲を指定」ではカンマ区切りの各範囲が 1 ファイルになります。' }
    ]
  });
  if (!r) return;
  let groups = [];
  if (+r.mode === 0) { const k = Math.max(1, r.n | 0); for (let s = 0; s < total; s += k) groups.push([...Array(Math.min(k, total - s)).keys()].map((x) => x + s)); }
  else if (+r.mode === 1) {
    for (const part of String(r.ranges).split(/[,、]/).filter((x) => x.trim())) {
      const g = parseRange(part, total);
      if (!g?.length) return alertBox(`範囲「${part}」が正しくありません`);
      groups.push(g);
    }
  } else groups = [...Array(total).keys()].map((i) => [i]);
  if (!groups.length) return;
  const folder = await window.api.chooseFolder('分割したファイルの保存先');
  if (!folder) return;
  const full = await PDFDocument.load(await buildOutput({ security: null }));
  const pr = progress('分割しています…', groups.length);
  let first = null;
  for (const [n, g] of groups.entries()) {
    if (pr.cancelled) break;
    const out = await PDFDocument.create();
    (await out.copyPages(full, g)).forEach((p) => out.addPage(p));
    const name = `${baseName(state.name)}_part${String(n + 1).padStart(2, '0')}.pdf`;
    first ||= name;
    await window.api.writeFiles(folder, [{ name, data: await out.save() }]);
    pr.update(n + 1);
  }
  pr.close();
  toast(`${groups.length} 個のファイルに分割しました`);
  if (first) window.api.showInFolder(`${folder}/${first}`);
}

export async function cropTo({ page, rect }) {
  if (!allowed('modify')) return;
  const r = await ask({ title: 'トリミング', message: '選択した範囲で表示領域（CropBox）を切り詰めます。', fields: [{ key: 'all', label: 'すべてのページに適用する', type: 'checkbox' }] });
  if (!r) return;
  await changeStructure((lib) => {
    const list = r.all ? lib.getPages() : [lib.getPage(page)];
    for (const p of list) {
      const m = p.getMediaBox();
      const x = Math.max(rect[0], m.x), y = Math.max(rect[1], m.y);
      const x2 = Math.min(rect[0] + rect[2], m.x + m.width), y2 = Math.min(rect[1] + rect[3], m.y + m.height);
      if (x2 > x && y2 > y) p.setCropBox(x, y, x2 - x, y2 - y);
    }
  });
  setTool('select');
}

// ---------------------------------------------------------------- フォーム作成

export async function createFormField({ page, rect, at, kind }) {
  if (!allowed('modify')) return;
  const form = state.lib.getForm();
  const count = form.getFields().length + 1;
  const fields = [{ key: 'name', label: 'フィールド名', value: `field${count}` }];
  if (kind === 'formChoice') fields.push({ key: 'options', label: '選択肢（カンマ区切り）', value: 'はい,いいえ' });
  if (kind === 'formText') fields.push({ key: 'multi', label: '複数行', type: 'checkbox', value: !!rect && rect[3] > 40 });
  const r = await ask({ title: { formText: 'テキスト入力欄', formCheck: 'チェックボックス', formChoice: 'ドロップダウン' }[kind], fields });
  if (!r) return;
  const name = String(r.name).trim() || `field${count}`;
  if (form.getFieldMaybe(name)) return alertBox('同じ名前のフィールドがあります');
  const box = rect || (kind === 'formCheck' ? [at[0], at[1] - 14, 14, 14] : [at[0], at[1] - 22, kind === 'formChoice' ? 160 : 180, 22]);
  try {
    await changeStructure(async (lib) => {
      const f = lib.getForm();
      const p = lib.getPage(page);
      const opts = { x: box[0], y: box[1], width: box[2], height: box[3], borderColor: rgb(0.5, 0.5, 0.5), borderWidth: 1, backgroundColor: rgb(0.9, 0.94, 1) };
      if (kind === 'formText') {
        const tf = f.createTextField(name);
        if (r.multi) tf.enableMultiline();
        tf.addToPage(p, { ...opts, font: await jpFont(lib) });
      } else if (kind === 'formCheck') {
        f.createCheckBox(name).addToPage(p, opts);
      } else {
        const dd = f.createDropdown(name);
        const options = String(r.options).split(/[,、]/).map((s) => s.trim()).filter(Boolean);
        dd.addOptions(options);
        if (options[0]) dd.select(options[0]);
        dd.addToPage(p, { ...opts, font: await jpFont(lib) });
      }
    });
  } catch (e) {
    await alertBox('フィールドを作成できませんでした', e.message);
  }
}

// ---------------------------------------------------------------- 描画ヘルパー

/** 保存結果（注釈込み）を pdf.js で開いて処理する */
async function withOutputPdf(fn, flatten = true) {
  const bytes = await buildOutput({ flatten, security: null });
  const pdf = await pdfjsLib.getDocument({ data: bytes, ...PDFJS_OPTS }).promise;
  try { return await fn(pdf); } finally { pdf.destroy(); }
}

export async function renderToCanvas(pdf, index, dpi, { rotate = true, annotations = true } = {}) {
  const page = await pdf.getPage(index + 1);
  const vp = page.getViewport({ scale: dpi / 72, rotation: rotate ? page.rotate : 0 });
  const c = document.createElement('canvas');
  c.width = Math.ceil(vp.width);
  c.height = Math.ceil(vp.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  // 開いている文書のスキャン画像だけのページは、ワーカーで描く（OCR などで速い）
  const scan = pdf === state.pdf && scanAvailable() ? scanInfo(index) : null;
  if (scan) {
    const rot = rotate ? scan.rotate : 0;
    const swap = rot === 90 || rot === 270;
    const bmp = await renderScan(scan, swap ? c.height : c.width, swap ? c.width : c.height).catch(() => null);
    if (bmp) { drawScan(ctx, bmp, rot, c.width, c.height, scan.interpolate); bmp.close(); return { canvas: c, vp }; }
  }
  await page.render({ canvasContext: ctx, viewport: vp, annotationMode: annotations ? pdfjsLib.AnnotationMode.ENABLE : pdfjsLib.AnnotationMode.DISABLE }).promise;
  return { canvas: c, vp };
}

// ---------------------------------------------------------------- 書き出し

export async function exportImages() {
  if (!requireDoc() || !allowed('copy')) return;
  const r = await ask({ title: '画像として書き出し', fields: [
    { key: 'fmt', label: '形式', type: 'select', options: ['PNG', 'JPEG'], value: 0 },
    { key: 'dpi', label: '解像度 (dpi)', type: 'number', value: 150, min: 36, max: 600 },
    { key: 'range', label: 'ページ範囲', placeholder: '空欄ですべて' }] });
  if (!r) return;
  const idx = parseRange(r.range, pageCount());
  if (!idx) return alertBox('ページ範囲が正しくありません');
  const folder = await window.api.chooseFolder('画像の保存先フォルダ');
  if (!folder) return;
  const jpeg = +r.fmt === 1;
  const dpi = Math.min(600, Math.max(36, r.dpi || 150));
  const pr = progress('画像を書き出しています…', idx.length);
  let n = 0;
  await withOutputPdf(async (pdf) => {
    for (const [k, i] of idx.entries()) {
      if (pr.cancelled) break;
      const { canvas } = await renderToCanvas(pdf, i, dpi);
      const data = await canvasToBytes(canvas, jpeg ? 'image/jpeg' : 'image/png');
      canvas.width = 0;
      // 1 枚ずつ書き出してメモリを溜めない
      await window.api.writeFiles(folder, [{ name: `${baseName(state.name)}_${String(i + 1).padStart(3, '0')}.${jpeg ? 'jpg' : 'png'}`, data }]);
      n++;
      pr.update(k + 1, `ページ ${i + 1}`);
    }
  });
  pr.close();
  toast(`${n} 枚の画像を書き出しました`);
}

async function allText() {
  return withOutputPdf(textLines);
}

/** pdf.js の文書から、ページごとの行の配列を取り出す */
export async function textLines(pdf) {
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const tc = await (await pdf.getPage(i)).getTextContent();
    let line = '';
    const lines = [];
    for (const it of tc.items) {
      line += it.str;
      if (it.hasEOL) { lines.push(line); line = ''; }
    }
    if (line) lines.push(line);
    pages.push(lines);
  }
  return pages;
}

export async function exportText() {
  if (!requireDoc() || !allowed('copy')) return;
  const p = await window.api.saveDialog({ title: 'テキストとして書き出し', defaultPath: `${baseName(state.name)}.txt`, filters: [{ name: 'テキスト', extensions: ['txt'] }] });
  if (!p) return;
  const pages = await allText();
  const text = pages.map((l) => l.join('\r\n')).join('\r\n\f\r\n');
  await window.api.writeFile(p, new TextEncoder().encode('﻿' + text));
  toast('テキストを書き出しました');
}

export async function exportDocx() {
  if (!requireDoc() || !allowed('copy')) return;
  const p = await window.api.saveDialog({ title: 'Word 文書として書き出し', defaultPath: `${baseName(state.name)}.docx`, filters: [{ name: 'Word 文書', extensions: ['docx'] }] });
  if (!p) return;
  await window.api.exportDocx(p, await allText());
  toast('Word 文書を書き出しました');
  window.api.showInFolder(p);
}

export async function print() {
  if (!requireDoc() || !allowed('print')) return;
  const pr = progress('印刷の準備をしています…', pageCount());
  const job = await window.api.printBegin();
  let landscape = false;
  let n = 0;
  try {
    await withOutputPdf(async (pdf) => {
      for (let i = 0; i < pdf.numPages; i++) {
        if (pr.cancelled) break;
        const { canvas, vp } = await renderToCanvas(pdf, i, 200);
        if (i === 0) landscape = vp.width > vp.height;
        // ページ画像は一時ファイルに書き、メモリに溜めない
        await window.api.printPage(job, i, await canvasToBytes(canvas, 'image/jpeg', 0.92));
        canvas.width = 0;
        n++;
        pr.update(i + 1);
      }
    });
  } finally {
    pr.close();
  }
  if (n && !pr.cancelled) await window.api.printRun(job, landscape);
  else await window.api.printCancel(job);
}

export async function saveOptimized() {
  if (!requireDoc()) return;
  const r = await ask({ title: 'ファイルサイズを縮小して保存', fields: [
    { key: 'mode', label: '方法', type: 'select', options: ['標準（不要なデータを除いて保存）', '強力（ページを画像化して圧縮）'], value: 0 },
    { key: 'dpi', label: '解像度 (dpi)', type: 'number', value: 120, min: 50, max: 300 },
    { key: 'quality', label: '画質 (1-100)', type: 'number', value: 70, min: 10, max: 100 },
    { key: 'note', type: 'note', label: '「強力」は文字が画像になるため、検索・コピーができなくなります（必要なら後で OCR を実行してください）。' }] });
  if (!r) return;
  if (+r.mode === 1 && !allowed('modify')) return;
  const p = await window.api.saveDialog({ title: '保存先', defaultPath: `${baseName(state.name)}_圧縮.pdf`, filters: PDF_FILTER });
  if (!p) return;
  const original = state.path ? await window.api.fileSize(state.path) : null;
  let bytes;
  if (+r.mode === 0) {
    bytes = await buildOutput();
  } else {
    const out = await PDFDocument.create();
    const pr = progress('圧縮しています…', pageCount());
    const dpi = Math.min(300, Math.max(50, r.dpi || 120));
    const quality = Math.min(100, Math.max(10, r.quality || 70)) / 100;
    await withOutputPdf(async (pdf) => {
      for (let i = 0; i < pdf.numPages; i++) {
        if (pr.cancelled) break;
        const page = await pdf.getPage(i + 1);
        const { canvas } = await renderToCanvas(pdf, i, dpi);
        const vp1 = page.getViewport({ scale: 1, rotation: page.rotate });
        const img = await out.embedJpg(await canvasToBytes(canvas, 'image/jpeg', quality));
        canvas.width = 0;
        out.addPage([vp1.width, vp1.height]).drawImage(img, { x: 0, y: 0, width: vp1.width, height: vp1.height });
        pr.update(i + 1);
      }
    });
    pr.close();
    if (pr.cancelled) return;
    const sec = state.security;
    if (sec?.user || sec?.owner) out.encrypt({ userPassword: sec.user || '', ownerPassword: sec.owner || sec.user, permissions: sec.permissions || undefined });
    bytes = await out.save({ useObjectStreams: true });
  }
  await window.api.writeFile(p, bytes);
  await alertBox('圧縮して保存しました', `${original != null ? `${formatBytes(original)} → ` : ''}${formatBytes(bytes.length)}\n${p}`);
}

// ---------------------------------------------------------------- OCR（ブラウザ内の Web Worker で実行）

const CJK = '[\\u3000-\\u30ff\\u3400-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef]';
export const cleanOcr = (s) => s.replace(new RegExp(`(?<=${CJK})\\s+(?=${CJK})`, 'g'), '').replace(/\s+$/, '');

let ocrWorker = null;
let ocrKey = '';
export async function getOcrWorker(langs) {
  const key = langs.join('+');
  if (ocrWorker && ocrKey === key) return ocrWorker;
  if (ocrWorker) { await ocrWorker.terminate().catch(() => {}); ocrWorker = null; }
  const Tesseract = (await import('./vendor/tesseract/tesseract.esm.min.js')).default;
  const base = new URL('./vendor/tesseract/', import.meta.url).href;
  ocrWorker = await Tesseract.createWorker(langs, 1, {
    workerPath: `${base}worker.min.js`,
    corePath: base,
    langPath: new URL('../assets/tessdata', import.meta.url).href,
    workerBlobURL: false,
    gzip: true,
    cacheMethod: 'none'
  });
  ocrKey = key;
  return ocrWorker;
}

/** しばらく使わなければ OCR エンジンを終了してメモリを返す */
let ocrIdleTimer = 0;
export function releaseOcrLater() {
  clearTimeout(ocrIdleTimer);
  ocrIdleTimer = setTimeout(() => { ocrWorker?.terminate().catch(() => {}); ocrWorker = null; }, 60_000);
}

export async function ocr() {
  if (!requireDoc() || !allowed('modify')) return;
  const r = await ask({ title: 'テキスト認識（OCR）', message: 'スキャンした PDF の文字を認識して、検索・コピーできるようにします。処理はこの PC 内で行われます。', fields: [
    { key: 'lang', label: '言語', type: 'select', options: ['日本語 + 英語', '英語のみ', '日本語のみ'], value: 0 },
    { key: 'skip', label: 'すでに文字のあるページはスキップする', type: 'checkbox', value: true },
    { key: 'range', label: 'ページ範囲', placeholder: '空欄ですべて' }] });
  if (!r) return;
  const idx = parseRange(r.range, pageCount());
  if (!idx) return alertBox('ページ範囲が正しくありません');
  const targetsList = [];
  for (const i of idx) if (!r.skip || !(await pageText(i)).text.trim()) targetsList.push(i);
  if (!targetsList.length) return alertBox('OCR が必要なページはありません', 'すべてのページにすでに文字情報があります。');
  const langs = [['jpn', 'eng'], ['eng'], ['jpn']][+r.lang];
  const pr = progress('文字を認識しています…', targetsList.length);
  const results = [];
  try {
    pr.update(0, 'OCR エンジンを準備しています');
    const worker = await getOcrWorker(langs);
    for (const [k, i] of targetsList.entries()) {
      if (pr.cancelled) break;
      pr.update(k, `ページ ${i + 1} を認識中`);
      const { canvas, vp } = await renderToCanvas(state.pdf, i, 300, { rotate: false, annotations: false });
      const { data } = await worker.recognize(canvas);
      canvas.width = 0;
      const mapped = (data.lines || []).filter((l) => l.confidence > 30 && l.text.trim()).map((l) => {
        const [ax, ay] = vp.convertToPdfPoint(l.bbox.x0, l.bbox.y1);
        const [bx, by] = vp.convertToPdfPoint(l.bbox.x1, l.bbox.y0);
        return { text: cleanOcr(l.text), rect: [Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay)] };
      });
      results.push([i, mapped]);
      pr.update(k + 1, `ページ ${i + 1}`);
    }
  } catch (e) {
    pr.close();
    return alertBox('OCR に失敗しました', e.message);
  } finally {
    releaseOcrLater();
  }
  pr.close();
  const found = results.reduce((s, [, l]) => s + l.length, 0);
  if (!found) return alertBox('文字が見つかりませんでした');
  await changeStructure(async (lib) => { for (const [i, lines] of results) await addInvisibleText(lib, i, lines); });
  await alertBox('OCR が完了しました', `${results.length} ページで ${found} 行のテキストを認識しました。検索やコピーができます。`);
}

// ---------------------------------------------------------------- 透かし・ヘッダー・ベイツ

export async function watermark() {
  if (!requireDoc() || !allowed('modify')) return;
  const r = await ask({ title: '透かしを追加', fields: [
    { key: 'text', label: '文字', value: t('社外秘') },
    { key: 'size', label: 'サイズ (pt)', type: 'number', value: 72, min: 4, max: 400 },
    { key: 'color', label: '色', type: 'color', value: '#e03131' },
    { key: 'opacity', label: '不透明度 (%)', type: 'number', value: 25, min: 1, max: 100 },
    { key: 'angle', label: '角度 (°)', type: 'number', value: 45 },
    { key: 'range', label: 'ページ範囲', placeholder: '空欄ですべて' }] });
  if (!r || !String(r.text).trim()) return;
  const idx = parseRange(r.range, pageCount());
  if (!idx) return alertBox('ページ範囲が正しくありません');
  await changeStructure((lib) => drawWatermark(lib, idx, r));
}

/** 透かしの文字をページ中央に描く。o: { text, size, color, opacity(%), angle } */
export async function drawWatermark(lib, idx, o) {
  const size = Math.min(400, Math.max(4, o.size || 72));
  const opacity = Math.min(100, Math.max(1, o.opacity || 25)) / 100;
  const font = await textFont(lib, o.text, true);
  const [cr, cg, cb] = hexToRgb(o.color || '#e03131');
  const tw = font.widthOfTextAtSize(o.text, size);
  const th = size * 0.7;
  const a = ((o.angle || 0) * Math.PI) / 180;
  for (const i of idx) {
    const page = lib.getPage(i);
    withDisplaySpace(page, (w, h) => {
      // 文字の中心がページ中央に来るよう、回転を考慮して原点を求める
      const x = w / 2 - (Math.cos(a) * tw / 2 - Math.sin(a) * th / 2);
      const y = h / 2 - (Math.sin(a) * tw / 2 + Math.cos(a) * th / 2);
      page.drawText(o.text, { x, y, size, font, color: rgb(cr, cg, cb), opacity, rotate: degrees(o.angle || 0) });
    });
  }
}

const expand = (s, n, total, start) => s.replaceAll('{page}', String(n + start)).replaceAll('{total}', String(total + start - 1)).replaceAll('{date}', new Date().toLocaleDateString('ja-JP'));

export async function drawHeaderFooter(lib, idx, o) {
  const jp = await jpFont(lib);
  const [cr, cg, cb] = hexToRgb(o.color || '#000000');
  const size = Math.min(72, Math.max(4, o.size || 10));
  const margin = Math.max(0, o.margin ?? 28);
  const total = idx.length;
  // 全ページ分の文字を先に作る（ベイツ番号のように関数で作る欄も含めて）。
  // タイ文字を含む欄があるときだけタイ語フォントを用意し、欄ごとに使い分ける
  const slots = [o.hl, o.hc, o.hr, o.fl, o.fc, o.fr];
  const texts = idx.map((_, n) => slots.map((t) => (!t ? '' : typeof t === 'function' ? t(n) : expand(t, n, total, o.start || 1))));
  const th = texts.some((row) => row.some((x) => THAI.test(x))) ? await textFont(lib, 'ก') : null;
  for (const [n, i] of idx.entries()) {
    const page = lib.getPage(i);
    withDisplaySpace(page, (w, h) => {
      const pos = [[0, h - margin], [1, h - margin], [2, h - margin], [0, margin - size * 0.3], [1, margin - size * 0.3], [2, margin - size * 0.3]];
      for (const [k, [align, y]] of pos.entries()) {
        const text = texts[n][k];
        if (!text) continue;
        const font = th && THAI.test(text) ? th : jp;
        const tw = font.widthOfTextAtSize(text, size);
        const x = align === 0 ? margin : align === 1 ? (w - tw) / 2 : w - margin - tw;
        page.drawText(text, { x, y, size, font, color: rgb(cr, cg, cb) });
      }
    });
  }
}

export async function headerFooter() {
  if (!requireDoc() || !allowed('modify')) return;
  const r = await ask({ title: 'ヘッダーとフッター / ページ番号', width: 480, fields: [
    { key: 'hl', label: 'ヘッダー 左' }, { key: 'hc', label: 'ヘッダー 中央' }, { key: 'hr', label: 'ヘッダー 右' },
    { key: 'fl', label: 'フッター 左' }, { key: 'fc', label: 'フッター 中央', value: '{page} / {total}' }, { key: 'fr', label: 'フッター 右' },
    { key: 'size', label: '文字サイズ', type: 'number', value: 10 },
    { key: 'margin', label: '余白 (pt)', type: 'number', value: 28 },
    { key: 'start', label: '開始番号', type: 'number', value: 1 },
    { key: 'color', label: '色', type: 'color', value: '#000000' },
    { key: 'range', label: 'ページ範囲', placeholder: '空欄ですべて' },
    { key: 'n', type: 'note', label: '{page} = ページ番号、{total} = 総ページ数、{date} = 今日の日付' }] });
  if (!r) return;
  const idx = parseRange(r.range, pageCount());
  if (!idx) return alertBox('ページ範囲が正しくありません');
  await changeStructure((lib) => drawHeaderFooter(lib, idx, r));
}

export async function bates() {
  if (!requireDoc() || !allowed('modify')) return;
  const r = await ask({ title: 'ベイツ番号を付与', fields: [
    { key: 'prefix', label: '接頭辞', value: 'ABC' },
    { key: 'start', label: '開始番号', type: 'number', value: 1 },
    { key: 'digits', label: '桁数', type: 'number', value: 6, min: 1, max: 12 },
    { key: 'pos', label: '位置', type: 'select', options: ['右下', '中央下', '左下', '右上'], value: 0 },
    { key: 'range', label: 'ページ範囲', placeholder: '空欄ですべて' }] });
  if (!r) return;
  const idx = parseRange(r.range, pageCount());
  if (!idx) return alertBox('ページ範囲が正しくありません');
  const digits = Math.min(12, Math.max(1, r.digits | 0));
  const label = (n) => r.prefix + String((r.start | 0) + n).padStart(digits, '0');
  const key = ['fr', 'fc', 'fl', 'hr'][+r.pos];
  await changeStructure((lib) => drawHeaderFooter(lib, idx, { [key]: label, size: 10, margin: 28 }));
}

// ---------------------------------------------------------------- 墨消し・フラット化

const overlaps = (r, rects) => rects.some((m) => r[0] < m[0] + m[2] && r[0] + r[2] > m[0] && r[1] < m[1] + m[3] && r[1] + r[3] > m[1]);
const annotRect = (annot) => {
  const r = annot.lookup(PL.PDFName.of('Rect'))?.asArray?.().map((n) => n.asNumber?.() ?? 0);
  return r ? [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.abs(r[2] - r[0]), Math.abs(r[3] - r[1])] : null;
};

export async function applyRedactions() {
  if (!requireDoc() || !allowed('modify')) return;
  const marks = [];
  state.pageIds.forEach((pid, i) => (state.objects[pid] || []).forEach((o) => o.type === 'redact' && marks.push([i, o])));
  if (!marks.length) return alertBox('墨消しマークがありません', 'ツールバーの「墨消し」で範囲を指定するか、検索パネルの「すべてに墨消しマーク」を使ってください。');
  if (!(await confirmBox(`${marks.length} 箇所の墨消しを適用しますか？`, '対象ページは画像化され、マーク部分の文字・画像情報は完全に削除されます（元に戻すことは可能）。必要に応じて後で OCR を実行してください。', '墨消しを適用'))) return;
  select(null);
  const pages = [...new Set(marks.map(([i]) => i))];
  const pr = progress('墨消しを適用しています…', pages.length);
  const images = {};
  for (const [k, i] of pages.entries()) {
    const { canvas, vp } = await renderToCanvas(state.pdf, i, 200, { rotate: false, annotations: false });
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    for (const [, o] of marks.filter(([p]) => p === i)) {
      const [x1, y1, x2, y2] = vp.convertToViewportRectangle([o.rect[0], o.rect[1], o.rect[0] + o.rect[2], o.rect[1] + o.rect[3]]);
      ctx.fillRect(Math.floor(Math.min(x1, x2)), Math.floor(Math.min(y1, y2)), Math.ceil(Math.abs(x2 - x1)) + 1, Math.ceil(Math.abs(y2 - y1)) + 1);
    }
    images[i] = await canvasToBytes(canvas, 'image/jpeg', 0.9);
    canvas.width = 0;
    pr.update(k + 1);
  }
  pr.close();
  await changeStructure(async (lib) => {
    const form = lib.getForm();
    for (const i of pages) {
      const rects = marks.filter(([p]) => p === i).map(([, o]) => o.rect);
      // 墨消し範囲にかかるフォーム欄は、入力値ごとフィールドを削除する
      const page = lib.getPage(i);
      const onPage = new Set((page.node.Annots()?.asArray() || []).map((ref) => lib.context.lookup(ref)));
      for (const field of form.getFields()) {
        const hit = field.acroField.getWidgets().some((w) => {
          if (!onPage.has(w.dict)) return false;
          const r = w.getRectangle();
          return overlaps([r.x, r.y, r.width, r.height], rects);
        });
        if (hit) form.removeField(field);
      }
      await replaceWithImage(lib, i, images[i], (annot) => {
        const r = annotRect(annot);
        return !r || !overlaps(r, rects);
      });
      const pid = state.pageIds[i];
      state.objects[pid] = (state.objects[pid] || []).filter((o) => o.type !== 'redact' && !overlaps(objBounds(o), rects));
    }
  });
  toast('墨消しを適用しました');
}

export async function flatten() {
  if (!requireDoc() || !allowed('modify')) return;
  if (!(await confirmBox('注釈とフォームをページに焼き込みますか？', '注釈・フォームは編集できなくなり、どのビューアでも同じ見た目で表示されます。'))) return;
  select(null);
  await changeStructure(async () => {
    const bytes = await buildOutput({ flatten: true, security: null });
    state.lib = await PDFDocument.load(bytes, { updateMetadata: false });
    for (const pid of state.pageIds) state.objects[pid] = [];
  });
}

// ---------------------------------------------------------------- 保護・プロパティ

export async function protect() {
  if (!requireDoc()) return;
  if (state.security?.restricted) return alertBox('保護の設定を変更できません', 'この文書は作成者により制限が設定されているため、パスワードや権限を変更できません。');
  const r = await ask({ title: 'パスワードで保護（AES 暗号化）', width: 480, fields: [
    { key: 'user', label: '開くパスワード', type: 'password' },
    { key: 'user2', label: '確認入力', type: 'password' },
    { key: 'owner', label: '権限パスワード', type: 'password' },
    { key: 'print', label: '印刷を許可', type: 'checkbox', value: true },
    { key: 'copy', label: 'テキスト・画像のコピーを許可', type: 'checkbox', value: true },
    { key: 'edit', label: '編集・注釈・フォーム入力を許可', type: 'checkbox', value: true },
    { key: 'n', type: 'note', label: '開くパスワードは空欄にもできます（権限の制限のみ）。権限パスワードを空欄にすると開くパスワードと同じになります。保存時に適用されます。' }] });
  if (!r) return;
  if (r.user !== r.user2) return alertBox('開くパスワードが一致しません');
  const owner = r.owner || r.user;
  if (!owner) return alertBox('パスワードを入力してください');
  const restricted = !(r.print && r.copy && r.edit);
  if (restricted && owner === r.user) {
    if (!(await confirmBox('権限パスワードが開くパスワードと同じです', '開くパスワードを知っている人は制限を解除できます。このまま設定しますか？'))) return;
  }
  state.security = {
    user: r.user, owner,
    permissions: { printing: r.print ? 'highResolution' : undefined, copying: r.copy, modifying: r.edit, annotating: r.edit, fillingForms: r.edit, documentAssembly: r.edit, contentAccessibility: true }
  };
  setDirty(true);
  toast('保存するとパスワード保護が適用されます');
}

export async function unprotect() {
  if (!requireDoc()) return;
  if (!state.security) return toast('この文書は保護されていません');
  if (state.security.restricted) return alertBox('保護を解除できません', 'この文書は作成者により制限が設定されているため、保護を解除できません。');
  if (!(await confirmBox('パスワード保護を解除しますか？', '保存すると暗号化なしの PDF になります。'))) return;
  state.security = null;
  setDirty(true);
}

export async function properties() {
  if (!requireDoc()) return;
  const lib = state.lib;
  const first = lib.getPage(0).getSize();
  const mm = (pt) => Math.round((pt * 25.4) / 72);
  const kw = lib.getKeywords() || '';
  const r = await ask({ title: '文書のプロパティ', width: 500, fields: [
    { key: 'title', label: 'タイトル', value: lib.getTitle() || '' },
    { key: 'author', label: '作成者', value: lib.getAuthor() || '' },
    { key: 'subject', label: 'サブタイトル', value: lib.getSubject() || '' },
    { key: 'keywords', label: 'キーワード', value: kw },
    { key: 'n', type: 'note', label: `ファイル: ${state.path || '未保存'}\nページ数: ${pageCount()}　ページサイズ: ${mm(first.width)} × ${mm(first.height)} mm\n作成アプリ: ${lib.getCreator() || '-'}　PDF 変換: ${lib.getProducer() || '-'}\n暗号化: ${state.security?.user || state.security?.owner ? 'あり' : 'なし'}　編集の制限: ${state.perms ? 'あり' : 'なし'}　フォームフィールド: ${lib.getForm().getFields().length} 個` }] });
  if (!r) return;
  if (!can('modify')) return alertBox('変更できません', 'この文書は作成者により内容の変更が禁止されています。');
  setMetadata({
    title: r.title, author: r.author, subject: r.subject,
    keywords: String(r.keywords).split(/[,、]/).map((s) => s.trim()).filter(Boolean)
  });
}

// ---------------------------------------------------------------- 比較

function diffLines(a, b) {
  const n = a.length, m = b.length;
  // 行数が多すぎるページは比較表が大きくなりすぎるため、単純な差分にする
  if (n * m > 4_000_000) {
    const sa = new Set(a), sb = new Set(b);
    return [...a.filter((x) => !sb.has(x)).map((x) => ['-', x]), ...b.filter((x) => !sa.has(x)).map((x) => ['+', x])];
  }
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push(['-', a[i++]]); else out.push(['+', b[j++]]);
  }
  while (i < n) out.push(['-', a[i++]]);
  while (j < m) out.push(['+', b[j++]]);
  return out;
}

// ---------------------------------------------------------------- 測定

const RATIOS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
const UNIT_NAMES = { mm: 'ミリメートル (mm)', cm: 'センチメートル (cm)', m: 'メートル (m)', in: 'インチ (in)', ft: 'フィート (ft)', pt: 'ポイント (pt)' };
const hasMeasures = () => Object.values(state.objects).some((l) => l?.some((o) => o.type === 'measure'));

/** 測定の縮尺 */
export async function measureScale() {
  if (!requireDoc()) return;
  const cur = currentScale();
  const ratio = cur.ratio ?? (cur.label?.startsWith('1:') ? Number(cur.label.slice(2)) : null);
  const preset = RATIOS.includes(ratio) ? String(ratio) : 'custom';
  const r = await ask({ title: '測定の縮尺', message: `現在の縮尺: ${cur.label}（${UNIT_NAMES[cur.unit] || cur.unit}）\n図面の縮尺を選ぶと、紙の上の長さを実際の長さに換算して表示します。`, fields: [
    { key: 'preset', label: '縮尺', type: 'select', value: preset, options: [...RATIOS.map((n) => ({ value: String(n), label: `1 : ${n}` })), { value: 'custom', label: 'その他（下の欄に入力）' }] },
    { key: 'custom', label: 'その他の縮尺 1 :', type: 'number', value: ratio || 1, min: 0.0001 },
    { key: 'unit', label: '単位', type: 'select', value: cur.unit, options: Object.entries(UNIT_NAMES).map(([value, label]) => ({ value, label })) },
    { key: 'decimals', label: '小数点以下の桁数', type: 'number', value: cur.decimals ?? 1, min: 0, max: 4 },
    { key: 'all', label: 'この文書の既存の測定にも適用する', type: 'checkbox', value: true },
    { type: 'note', label: '図面の寸法から縮尺を合わせるときは「文書 > 縮尺を合わせる（キャリブレーション）」を使います。' }] });
  if (!r) return;
  const n = r.preset === 'custom' ? Number(r.custom) : Number(r.preset);
  if (!(n > 0)) return alertBox('縮尺が正しくありません');
  const unit = UNITS[r.unit] ? r.unit : 'mm';
  const decimals = Math.min(4, Math.max(0, Math.round(r.decimals || 0)));
  const changed = setMeasureScale({ factor: scaleFactor(n, unit), unit, label: `1:${n}`, ratio: n, decimals }, r.all);
  toast(changed ? `縮尺を 1:${n} にし、${changed} 件の測定を更新しました` : `縮尺を 1:${n} にしました`);
}

/** キャリブレーション：長さの分かっている線から縮尺を決める */
export async function calibrate() {
  if (!requireDoc() || !allowed('annotate')) return;
  if (!startCalibration()) return;
}

/** 基準線を引き終えたとき */
export async function finishCalibration({ points }) {
  const cur = currentScale();
  const paperMm = measureValue({ type: 'measure', kind: 'distance', points, scale: { factor: scaleFactor(1, 'mm'), unit: 'mm', decimals: 2 } }).value;
  const r = await ask({ title: '縮尺を合わせる', message: `引いた線の紙の上の長さ: ${paperMm.toFixed(2)} mm\nこの線の実際の長さを入力してください。`, fields: [
    { key: 'len', label: '実際の長さ', type: 'number', value: '', min: 0 },
    { key: 'unit', label: '単位', type: 'select', value: cur.unit, options: Object.entries(UNIT_NAMES).map(([value, label]) => ({ value, label })) },
    { key: 'decimals', label: '小数点以下の桁数', type: 'number', value: cur.decimals ?? 1, min: 0, max: 4 },
    { key: 'all', label: 'この文書の既存の測定にも適用する', type: 'checkbox', value: true }] });
  if (!r) return;
  const len = Number(r.len);
  if (!(len > 0) || !(paperMm > 0)) return alertBox('長さが正しくありません');
  const unit = UNITS[r.unit] ? r.unit : 'mm';
  // 紙の上の 1 mm が実際の何 mm か
  const ratio = (len / UNITS[unit]) / paperMm;
  const nice = ratio >= 10 ? Math.round(ratio) : Math.round(ratio * 100) / 100;
  const decimals = Math.min(4, Math.max(0, Math.round(r.decimals || 0)));
  const changed = setMeasureScale({ factor: scaleFactor(ratio, unit), unit, label: `1:${nice}`, ratio, decimals }, r.all);
  toast(`縮尺を 1:${nice} に合わせました${changed ? `（${changed} 件の測定を更新）` : ''}`, 3500);
}

// ---------------------------------------------------------------- ページの大きさをそろえる

export async function normalizeSizeDialog() {
  if (!requireDoc() || !allowed('modify')) return;
  const names = Object.keys(PAPER_SIZES);
  const r = await ask({ title: 'ページの大きさをそろえる', message: '縦横の向きはページごとに元のまま、縦横比を保って中央に収めます。注釈やリンクも一緒に動かします。', fields: [
    { key: 'size', label: '用紙', type: 'select', options: names, value: 1 },
    { key: 'range', label: 'ページ範囲', placeholder: '空欄ですべて' },
    { key: 'shrink', label: '大きいページだけ縮める（小さいページは拡大しない）', type: 'checkbox', value: false }] });
  if (!r) return;
  const idx = parseRange(r.range, pageCount());
  if (!idx.length) return toast('ページ範囲が正しくありません');
  try {
    const res = await normalizePageSize(idx, PAPER_SIZES[names[r.size]], { shrinkOnly: !!r.shrink });
    if (res.skipped) await alertBox('一部のページは変えていません', t('{n} ページは大判の図面の単位（UserUnit）で作られているため、大きさを変えていません。').replace('{n}', res.skipped));
    if (!res.changed) return toast('大きさを変えるページはありませんでした');
    toast(t('{n} ページの大きさを {s} にそろえました').replace('{n}', res.changed).replace('{s}', names[r.size]), 4000);
    const notes = [];
    // 測った長さは実寸のまま直したが、これから測るときの縮尺は大きさを変える前のもの
    if (state.measureScale || Object.values(state.objects).flat().some((o) => o.type === 'measure')) notes.push(t('これまでの測定の注釈は実寸のまま直しました。これから測るときは、大きさを変えたページで縮尺を合わせ直してください（「文書 > 縮尺を合わせる」）。'));
    if (res.scanSlow) notes.push(t('{n} ページはスキャン画像と用紙の縦横比が違うため、保存すると表示が遅くなります（速い表示の対象から外れます）。').replace('{n}', res.scanSlow));
    if (notes.length) await alertBox('ページの大きさをそろえました', notes.join('\n\n'));
  } catch (e) {
    await alertBox('ページの大きさを変えられませんでした', e.message);
  }
}

// ---------------------------------------------------------------- 図面の重ね合わせ比較

/** 比較相手のファイルを pdf.js で開く（TIFF は PDF に変換してから。パスワードは聞く）。
 *  戻り値：{ pdf, data（PDF の中身）, password } または null（パスワードを聞いてやめた）。
 *  onAsk：パスワードを聞く前後に呼ぶ（進み具合の窓を閉じて、聞いたあとに開き直すため） */
async function openOtherForCompare(file, onAsk = null) {
  let data = new Uint8Array(file.bytes);
  if (isTiff(file.name) || sniffKind(file.name, data) === 'tiff') {
    const doc = await PDFDocument.create();
    await addTiffPages(doc, data);
    data = await doc.save();
  }
  try {
    return { pdf: await pdfjsLib.getDocument({ data: data.slice(), ...PDFJS_OPTS }).promise, data, password: null };
  } catch (e) {
    if (e?.name !== 'PasswordException') throw e;
    onAsk?.(true);
    const pw = await askPassword(`${file.name} はパスワードで保護されています。`);
    onAsk?.(false);
    if (pw == null) return null;
    return { pdf: await pdfjsLib.getDocument({ data: data.slice(), password: pw, ...PDFJS_OPTS }).promise, data, password: pw };
  }
}

/** pdf.js のページを、1pt あたり s 画素で描いた画像にする（白い背景）。annotations=false なら注釈を描かない */
async function renderForCompare(page, s, annotations = true) {
  const vp = page.getViewport({ scale: s });
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(vp.width));
  c.height = Math.max(1, Math.round(vp.height));
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp, annotationMode: annotations ? pdfjsLib.AnnotationMode.ENABLE : pdfjsLib.AnnotationMode.DISABLE }).promise;
  const img = ctx.getImageData(0, 0, c.width, c.height);
  c.width = 0;
  return img;
}

// 位置合わせ・色分け・画像の圧縮の重い計算は、ワーカー（overlay-worker.js）で行う（計算の間も画面と「中止」が動くように）。
// ワーカーが使えないときは画面のスレッドで行う。中止したらワーカーを止め、次に使うときに作り直す
let overlayWorker = null, overlayWorkerBroken = false, overlayJobId = 0, overlayWorkerJobs = 0;
const overlayWaiting = new Map();
function getOverlayWorker() {
  if (overlayWorker || overlayWorkerBroken) return overlayWorker;
  try {
    const w = new Worker(new URL('./overlay-worker.js', import.meta.url), { type: 'module' });
    w.onmessage = (e) => {
      const { id, r, error } = e.data;
      const p = overlayWaiting.get(id);
      overlayWaiting.delete(id);
      if (!p) return;
      if (error) p.reject(new Error(error)); else { overlayWorkerJobs++; p.resolve(r); }
    };
    // 読み込めなかった・落ちた・返事を受け取れなかった：待っているものは画面のスレッドでやり直す
    const broken = (e) => {
      overlayWorkerBroken = true;
      if (overlayWorker === w) overlayWorker = null;
      for (const p of overlayWaiting.values()) p.fallback();
      overlayWaiting.clear();
      e?.preventDefault?.();
    };
    w.onerror = broken;
    w.onmessageerror = broken;
    overlayWorker = w;
  } catch {
    overlayWorkerBroken = true;
    overlayWorker = null;
  }
  return overlayWorker;
}
/** 中止：計算中のワーカーを止める（待っているものは中止で終える）。次に使うときに作り直す */
function abortOverlayWorker() {
  if (!overlayWaiting.size || !overlayWorker) return;
  overlayWorker.terminate();
  overlayWorker = null;
  for (const p of overlayWaiting.values()) p.reject(new Error('CANCELLED'));
  overlayWaiting.clear();
}
/** ワーカーで計算できたか（自動テスト用） */
export const overlayWorkerOk = () => overlayWorkerJobs > 0;
function runAnalyze(job) {
  const inline = () => analyzeOverlayFull(job);
  const w = window.__overlayInline ? null : getOverlayWorker();
  if (!w) return inline();
  return new Promise((resolve, reject) => {
    const id = ++overlayJobId;
    overlayWaiting.set(id, { resolve, reject, fallback: () => inline().then(resolve, reject) });
    // 配列は写して送る（ワーカーが読み込めなかったときに、画面のスレッドでやり直せるように）
    w.postMessage({ id, job });
  });
}

/** 画面を描き直す機会を作る（進み具合の文言・バーを出すため） */
const nextFrame = () => new Promise((r) => { let done = false; const go = () => { if (!done) { done = true; setTimeout(r, 0); } }; requestAnimationFrame(go); setTimeout(go, 20); });

/**
 * 古い版（今の文書）と新しい版の 1 ページを比べ、ずれと変わった量を返す。
 * image=true なら色分けした画像も作る（rgbz：RGB の画素を Flate で圧縮したもの。imgW × imgH）。
 * renderA(s, annotations)：古い版のページを描く関数（今の文書のスキャン画像のページは、速い描き方で描けるように）。
 * annotations=false：注釈を描かずに比べる（線のまま重ねるときは注釈を写さないので、数も合わせる）。
 * onStage(割合 0〜1, 段階)：進み具合
 */
export async function overlayPages(pageA, pageB, { maxPixels = 12e6, dpi = 200, renderA = null, image = true, annotations = true, onStage = null } = {}) {
  const va = pageA.getViewport({ scale: 1 }), vb = pageB.getViewport({ scale: 1 });
  // 同じ実寸の縮尺で描く（画素の大きさではそろえない）。大きい方のページが上限に収まるように
  const s = Math.min(dpi / 72, Math.sqrt(maxPixels / Math.max(va.width * va.height, vb.width * vb.height)));
  await onStage?.(0, '古い版を描いています');
  // 線だけを取り出したら、画素はすぐ手放す（大きな図面でメモリを使いすぎないように）
  let img = renderA ? await renderA(s, annotations) : await renderForCompare(pageA, s, annotations);
  const w = img.width, h = img.height;
  const a = darkMask(img);
  await onStage?.(0.3, '新しい版を描いています');
  img = await renderForCompare(pageB, s, annotations);
  const bw = img.width, bh = img.height;
  const b = darkMask(img);
  img = null;
  pageB.cleanup();
  await onStage?.(0.55, image ? '位置を合わせ、違いを調べ、色分けした画像を作っています' : '位置を合わせ、違いを調べています');
  const r = await runAnalyze({ a, w, h, b, bw, bh, image });
  const { dx, dy } = r;
  const sizeDiffers = Math.abs(va.width - vb.width) > Math.max(2, va.width * 0.01) || Math.abs(va.height - vb.height) > Math.max(2, va.height * 0.01);
  // ずれは mm で（1pt = 25.4/72 mm）
  const mm = (px) => Math.round((px / s) * (25.4 / 72) * 10) / 10;
  return { rgbz: r.rgbz || null, imgW: w, imgH: h, widthPt: va.width, heightPt: va.height, removed: r.removed, added: r.added, total: r.total, shiftMm: [mm(dx), mm(dy)], shiftPx: [dx, dy], shiftPt: [(dx + (r.fx || 0)) / s, (dy + (r.fy || 0)) / s], sizeDiffers };
}

/** スキャン画像のページか（画像があり、線を描く命令がほとんどない）。OCR の見えない文字はあってもよい。注釈は数えない */
async function isScanPage(page) {
  const O = pdfjsLib.OPS;
  const imageOps = new Set([O.paintImageXObject, O.paintInlineImageXObject, O.paintImageMaskXObject, O.paintImageXObjectRepeat, O.paintImageMaskXObjectRepeat, O.paintImageMaskXObjectGroup, O.paintInlineImageXObjectGroup, O.paintSolidColorImageMask].filter((x) => x != null));
  const { fnArray } = await page.getOperatorList({ annotationMode: pdfjsLib.AnnotationMode.DISABLE });
  let images = 0, paths = 0;
  for (const fn of fnArray) { if (imageOps.has(fn)) images++; else if (fn === O.constructPath) paths++; }
  return images > 0 && paths <= 8;
}

/** リンク・ポップアップ以外の注釈（スタンプ・雲マーク・付箋・フォームの欄など）があるか。あるページは画像で重ねる（注釈も比べるため） */
async function hasMarkup(page) {
  const list = await page.getAnnotations();
  return list.some((a) => !['Link', 'Popup'].includes(a.subtype));
}

// 線のまま重ねるときの色（共通の線は赤と青を掛け合わせた黒になる）
const VEC_RED = [0.86, 0.12, 0.12], VEC_BLUE = [0.08, 0.35, 0.92];
const n4 = (v) => (Math.abs(v) < 1e-9 ? '0' : (+v.toFixed(4)).toString());

/** pdf-lib のページの中身（Contents。いくつかに分かれていてもつなぐ）を展開したバイト列にする。中身がなければ空 */
function pageContentBytes(page) {
  const { PDFArray, PDFRawStream, decodePDFRawStream } = PL;
  const c = page.node.Contents();
  const list = !c ? [] : c instanceof PDFArray ? c.asArray().map((x) => page.doc.context.lookup(x)) : [c];
  const parts = list.filter(Boolean).map((s) => (s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : (s.getUnencodedContents?.() || s.getContents())));
  const total = parts.reduce((n, p) => n + p.length + 1, 0);
  const out = new Uint8Array(total);
  let k = 0;
  for (const p of parts) { out.set(p, k); k += p.length; out[k++] = 0x0a; } // 分かれ目は改行（命令の途中で切れないように）
  return out;
}

/**
 * ページの中身を部品（Form XObject）にする。写すのは中身と素材（Resources）だけ（注釈・リンク先のページなどは写さない）。
 * 部品の座標はページの座標のまま。copier：文書ごとに 1 つ（同じフォント・画像を何度も写さない）
 */
function pagePart(out, copier, page, bytes) {
  const { PDFName } = PL;
  const res = page.node.Resources() || page.node.getInheritableAttribute?.(PDFName.of('Resources'));
  const resDict = res ? page.doc.context.lookup(res) : null;
  const c = page.getCropBox();
  const dict = { Type: 'XObject', Subtype: 'Form', BBox: [c.x, c.y, c.x + c.width, c.y + c.height] };
  const stream = out.context.flateStream(bytes, dict);
  if (resDict) stream.dict.set(PDFName.of('Resources'), copier.copy(resDict));
  return out.context.register(stream);
}

/**
 * 線のまま重ねたページを作る（拡大しても鮮明）。古い版を赤、新しい版を青に染めた部品を、掛け合わせて重ねる：
 * 古い版だけ＝赤、新しい版だけ＝青、共通＝黒、何もない所＝白。
 * 染め方：色で塗った上に白を、「白地に置いたページの明るさ」をマスク（ソフトマスク）にして塗る。線の所は色、何もない所は白になる。
 * ページの中身が自分で合成の仕方を決めていても、マスクの中に閉じているので色が崩れない。
 * partA / partB：pagePart の部品、vpA / vpB：pdf.js の 1 倍の表示範囲（回転・切り抜きを含む）、shiftPt：新しい版を動かす量（下向きが正）
 */
function vectorOverlayPage(out, partA, vpA, partB, vpB, shiftPt) {
  const { PDFName } = PL;
  const ctx = out.context;
  const W = vpA.width, H = vpA.height;
  const box = `0 0 ${n4(W)} ${n4(H)} re f`;
  const rgbGroup = (extra = {}) => ({ Type: 'Group', S: 'Transparency', CS: 'DeviceRGB', ...extra });
  // マスクの中で、ページの上に 0.4 の灰色を「焼き込み（ColorBurn）」で重ねる：値 v が (v − 0.6) ÷ 0.4 になり（0 未満は 0）、
  // 0.6 より暗い色（線として数える色。緑や水色の線も）ははっきり色が出て、明るい所は白のまま。
  // 線かどうかの判定（darkMask：明るさ 160/255 未満）と見た目をそろえる。（マスクの変換関数 /TR は pdf.js で正しく効かないため使わない）
  const burn = ctx.register(ctx.obj({ Type: 'ExtGState', BM: 'ColorBurn' }));
  // pdf.js の変換（下向きの y）を、PDF の座標（上向きの y）に直す
  const mat = (vp, sx = 0, sy = 0) => { const [a, b, c, d, e, f] = vp.transform; return [a, -b, c, -d, e + sx, H - f - sy]; };
  const tinted = (part, m, color) => {
    // マスク：白地にページを置いた明るさ（線＝暗い＝色が出る、何もない所＝明るい＝白が出る）
    const mask = ctx.register(ctx.stream(`q 1 1 1 rg ${box} Q q ${m.map(n4).join(' ')} cm /P Do Q q /B gs 0.4 0.4 0.4 rg ${box} Q`, {
      Type: 'XObject', Subtype: 'Form', BBox: [0, 0, W, H], Group: rgbGroup(), Resources: { XObject: { P: part }, ExtGState: { B: burn } }
    }));
    const sm = ctx.register(ctx.obj({ Type: 'ExtGState', SMask: { Type: 'Mask', S: 'Luminosity', G: mask } }));
    return ctx.register(ctx.stream(`q ${color.map(n4).join(' ')} rg ${box} Q q /M gs 1 1 1 rg ${box} Q`, {
      Type: 'XObject', Subtype: 'Form', BBox: [0, 0, W, H], Group: rgbGroup({ I: true }), Resources: { ExtGState: { M: sm } }
    }));
  };
  const ga = tinted(partA, mat(vpA), VEC_RED);
  const gb = tinted(partB, mat(vpB, shiftPt[0], shiftPt[1]), VEC_BLUE);
  const mul = ctx.register(ctx.obj({ Type: 'ExtGState', BM: 'Multiply' }));
  const page = out.addPage([W, H]);
  // 掛け合わせる色の空間を RGB に決めておく（ソフトの設定で色が変わらないように）
  page.node.set(PDFName.of('Group'), ctx.obj(rgbGroup()));
  page.node.setXObject(PDFName.of('StudioGA'), ga);
  page.node.setXObject(PDFName.of('StudioGB'), gb);
  page.node.setExtGState(PDFName.of('StudioMul'), mul);
  page.pushOperators(
    PL.pushGraphicsState(), PL.drawObject('StudioGA'), PL.popGraphicsState(),
    PL.pushGraphicsState(), PL.setGraphicsState('StudioMul'), PL.drawObject('StudioGB'), PL.popGraphicsState()
  );
  return page;
}

/** 色分けした画像（圧縮済みの RGB）を、ページいっぱいに置いたページを作る */
function rasterOverlayPage(out, r) {
  const { PDFName } = PL;
  const ctx = out.context;
  const img = ctx.register(ctx.stream(r.rgbz, { Type: 'XObject', Subtype: 'Image', Width: r.imgW, Height: r.imgH, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'FlateDecode' }));
  const page = out.addPage([r.widthPt, r.heightPt]);
  page.node.setXObject(PDFName.of('StudioImg'), img);
  page.pushOperators(PL.pushGraphicsState(), PL.concatTransformationMatrix(r.widthPt, 0, 0, r.heightPt, 0, 0), PL.drawObject('StudioImg'), PL.popGraphicsState());
  return page;
}

/** 文書に画層（オプションコンテンツ）があるか。あると、隠した画層まで写ってしまうので画像で重ねる */
const hasLayers = (lib) => !!lib.catalog.get(PL.PDFName.of('OCProperties'));

/** 今の文書（古い版）と、選んだファイル（新しい版）のページを重ねて、違いを色分けした PDF を新しいタブに作る */
export async function compareOverlay({ files = null } = {}) {
  // ページの画像を新しい PDF に書き出すので、画像の書き出しと同じく「コピー」が許されている文書だけ
  if (!requireDoc() || !allowed('copy')) return;
  files = files || await window.api.openDialog({ title: '重ねて比較する（新しい版の）ファイル', filters: [{ name: 'PDF / TIFF', extensions: ['pdf', 'tif', 'tiff'] }] });
  if (!files.length) return;
  // 進み具合の窓は、相手のファイルを開く（TIFF の変換を含む）ところから、結果を書き出し終わるまで出す
  const title = '重ねて比較しています';
  let pr = progress(title, 1);
  pr.status(0, t('比較するファイルを開いています'));
  await nextFrame();
  let opened, cancelledBeforeAsk = false;
  try {
    opened = await openOtherForCompare(files[0], (asking) => {
      // パスワードを聞く間は進み具合の窓を閉じ、聞いたあとに開き直す（その前に押した「中止」は覚えておく）
      if (asking) { cancelledBeforeAsk = pr.cancelled; pr.close(); } else { pr = progress(title, 1); pr.status(0, t('比較するファイルを開いています')); }
    });
  } catch (e) {
    pr.close();
    return alertBox('比較するファイルを開けませんでした', e.message);
  }
  // 開いている間に「中止」を押したら、ここでやめる
  const cancelledEarly = pr.cancelled || cancelledBeforeAsk;
  pr.close();
  if (!opened) return;
  if (cancelledEarly) { opened.pdf.destroy(); return; }
  const other = opened.pdf;
  const n = Math.min(state.pdf.numPages, other.numPages);
  pr = progress(title, n);
  // 計算中に「中止」を押したら、ワーカーの計算も止める
  const watch = setInterval(() => { if (pr.cancelled) abortOverlayWorker(); }, 200);
  const notes = [];
  let changedPages = 0, vectorPages = 0;
  let bytes;
  try {
    const out = await PDFDocument.create();
    // 凡例の文字：表示言語の文字が入ったフォント（タイ語ならタイ語のフォント）
    const font = await textFont(out, t('赤：古い版だけにある線'));
    // 線のまま重ねるための、両方の版の pdf-lib の文書（読めなければ画像で重ねる）
    let libA = state.lib && state.libFor === state.pdf ? state.lib : null;
    let libB = null;
    if (libA) {
      // パスワードは開いたときのものを 1 回だけ渡す（読めなければ画像で重ねる。聞き直さない）
      let given = false;
      try { libB = (await loadLib(opened.data.slice(), async () => { if (given) return null; given = true; return opened.password; })).lib; } catch { libB = null; }
    }
    // 画層のある文書は、隠した画層まで写ってしまうので画像で重ねる
    if (libA && libB && (hasLayers(libA) || hasLayers(libB))) { libA = null; libB = null; }
    // 素材（フォント・画像）を写す道具は、文書ごとに 1 つ（同じものを何度も写さない）
    const copierA = libA && libB ? PL.PDFObjectCopier.for(libA.context, out.context) : null;
    const copierB = libA && libB ? PL.PDFObjectCopier.for(libB.context, out.context) : null;
    const stageText = (i, k) => t('{p}：{s}').replace('{p}', t('ページ {i} / {n}').replace('{i}', i + 1).replace('{n}', n)).replace('{s}', t(k));
    for (let i = 0; i < n; i++) {
      if (pr.cancelled) throw new Error('CANCELLED');
      const onStage = async (frac, k) => {
        if (pr.cancelled) throw new Error('CANCELLED');
        pr.status(i + frac, stageText(i, k));
        await nextFrame();
      };
      await onStage(0, '図面の種類を調べています');
      const pa = await state.pdf.getPage(i + 1), pb = await other.getPage(i + 1);
      // CAD などの線の図面は線のまま重ねる（拡大しても鮮明）。次のページは画像で重ねる：
      // スキャン画像（細かな汚れを違いにしないよう 2 画素の許容がある）・注釈のあるページ（注釈も比べる）・pdf-lib でそのページを読めないとき
      let parts = null;
      try {
        if (copierA && i < libA.getPageCount() && i < libB.getPageCount() &&
            !(await isScanPage(pa)) && !(await isScanPage(pb)) && !(await hasMarkup(pa)) && !(await hasMarkup(pb))) {
          // 両方の中身を先に展開する（展開できないページは、出力に何も足す前に画像で重ねる方に切り替わる）
          const pgA = libA.getPage(i), pgB = libB.getPage(i);
          const bytesA = pageContentBytes(pgA), bytesB = pageContentBytes(pgB);
          parts = [pagePart(out, copierA, pgA, bytesA), pagePart(out, copierB, pgB, bytesB)];
        }
      } catch (e) {
        if (e?.message === 'CANCELLED') throw e;
        window.api?.logInfo?.(`overlay: page ${i + 1} falls back to image (${e?.message || e})`);
        parts = null;
      }
      const vector = !!parts;
      // 古い版（今の文書）は、スキャン画像のページなら速い描き方で描く
      const renderA = async (s, annotations) => {
        const { canvas } = await renderToCanvas(state.pdf, i, s * 72, { annotations });
        const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
        canvas.width = 0;
        return data;
      };
      // 線のまま重ねるときの画像は、ずれと違いの量を調べるためだけに使う（注釈は写さないので描かない）。
      // 画像で重ねるときは細かく描く（元のスキャンの細かさに近づける）
      const r = await overlayPages(pa, pb, { renderA, image: !vector, annotations: !vector, maxPixels: vector ? 12e6 : 30e6, onStage });
      let page;
      if (vector) {
        await onStage(0.9, '線のまま重ねたページを作っています');
        page = vectorOverlayPage(out, parts[0], pa.getViewport({ scale: 1 }), parts[1], pb.getViewport({ scale: 1 }), r.shiftPt);
        vectorPages++;
      } else page = rasterOverlayPage(out, r);
      // 変わった画素が線全体の 0.05% 以下なら「違いなし」とみなす（細かなにじみを数えない）
      const changed = r.removed + r.added > Math.max(20, r.total * 0.0005);
      if (changed) changedPages++;
      if (r.sizeDiffers) notes.push(t('ページ {n} は大きさが違います').replace('{n}', i + 1));
      // 凡例（左上）
      const size = Math.max(7, Math.min(14, r.widthPt / 70));
      const lines = [
        [t('赤：古い版だけにある線'), PL.rgb(0.86, 0.12, 0.12)],
        [t('青：新しい版だけにある線'), PL.rgb(0.08, 0.35, 0.92)],
        [vector ? t('黒：共通の線') : t('灰：共通の線'), PL.rgb(0.25, 0.25, 0.25)],
        [`${t('位置のずれを補正')}: ${r.shiftMm[0]} mm, ${r.shiftMm[1]} mm`, PL.rgb(0.2, 0.2, 0.2)]
      ];
      const boxW = Math.max(...lines.map(([s2]) => font.widthOfTextAtSize(s2, size))) + size * 1.2;
      const boxH = lines.length * size * 1.4 + size * 0.6;
      page.drawRectangle({ x: size * 0.6, y: r.heightPt - boxH - size * 0.6, width: boxW, height: boxH, color: PL.rgb(1, 1, 1), opacity: 0.9, borderColor: PL.rgb(0.6, 0.6, 0.6), borderWidth: 0.5 });
      lines.forEach(([s2, color], k) => page.drawText(s2, { x: size * 1.2, y: r.heightPt - size * 0.6 - size * 1.4 * (k + 1), size, font, color }));
    }
    pr.status(n, t('結果のファイルを書き出しています'));
    await nextFrame();
    bytes = await out.save();
  } catch (e) {
    if (e?.message === 'CANCELLED') return;
    return alertBox('重ねて比較できませんでした', e.message);
  } finally {
    clearInterval(watch);
    pr.close();
    other.destroy();
  }
  if (state.pdf.numPages !== other.numPages) notes.push(t('ページ数が違います（{a} / {b}）。先頭から {n} ページだけを比べました').replace('{a}', state.pdf.numPages).replace('{b}', other.numPages).replace('{n}', n));
  if (vectorPages < n) notes.push(t('{n} ページは画像で重ねました（スキャン画像、画層や注釈のある図面など。拡大すると粗く見えます）').replace('{n}', n - vectorPages));
  window.__lastOverlay = { pages: n, vectorPages, changedPages, bytes: window.__keepOverlay ? bytes : undefined }; // bytes は自動テストのときだけ
  await alertBox(t('重ねて比較しました'), `${t('{n} ページのうち {c} ページに違いがあります').replace('{n}', n).replace('{c}', changedPages)}${notes.length ? `\n\n${notes.join('\n')}` : ''}\n\n${t('回転や拡大縮小の違いは補正しません')}`);
  await openResult(bytes, `${baseName(state.name)}_${t('重ねて比較')}.pdf`);
}

export async function compare() {
  if (!requireDoc()) return;
  const files = await window.api.openDialog({ title: '比較する（新しい）PDF', filters: PDF_FILTER });
  if (!files.length) return;
  let other;
  try {
    other = await pdfjsLib.getDocument({ data: new Uint8Array(files[0].bytes), ...PDFJS_OPTS }).promise;
  } catch (e) {
    if (e?.name !== 'PasswordException') return alertBox('比較する PDF を開けませんでした', e.message);
    const pw = await askPassword(`${files[0].name} はパスワードで保護されています。`);
    if (pw == null) return;
    try {
      other = await pdfjsLib.getDocument({ data: new Uint8Array(files[0].bytes), password: pw, ...PDFJS_OPTS }).promise;
    } catch {
      return alertBox('パスワードが違います');
    }
  }
  const lines = async (pdf, i) => {
    if (i >= pdf.numPages) return [];
    const tc = await (await pdf.getPage(i + 1)).getTextContent();
    let s = '';
    for (const it of tc.items) s += it.str + (it.hasEOL ? '\n' : '');
    return s.split('\n').map((x) => x.trim()).filter(Boolean);
  };
  const report = el('div', { class: 'diff-report' });
  let changed = 0;
  try {
    for (let i = 0; i < Math.max(state.pdf.numPages, other.numPages); i++) {
      const d = diffLines(await lines(state.pdf, i), await lines(other, i));
      if (!d.length) continue;
      changed++;
      report.append(el('h3', {}, `ページ ${i + 1}`), ...d.map(([k, t]) => el('div', { class: k === '-' ? 'del' : 'ins', translate: 'no' }, `${k === '-' ? '−' : '＋'} ${t}`)));
    }
  } finally {
    other.destroy();
  }
  const summary = `現在: ${state.pdf.numPages} ページ ／ 比較先: ${other.numPages} ページ\n` + (changed ? `${changed} ページで差分が見つかりました（赤: 現在の文書のみ / 緑: 比較先のみ）` : '差分はありませんでした。');
  await ask({ title: `比較: ${state.name} ↔ ${files[0].name}`, message: summary, custom: report, cancel: null, ok: '閉じる', width: 720 });
}

// ---------------------------------------------------------------- ヘルプ

export async function help() {
  const sections = [
    ['基本操作', 'ツールバーから注釈ツール（ハイライト・下線・取り消し線・付箋・テキスト・既存テキスト編集・手書き・図形・画像・署名・スタンプ）を選んで使います。起動時は手のひらツール（ドラッグで画面を動かす）で、Esc で手のひらツールに戻ります。注釈を動かすときは選択ツール（V）を使います。選択中の注釈は Delete で削除、矢印キーで移動（Shift で 10pt）。キー 1 文字でツール切替（V 選択、H 手のひら、U ハイライト、N 付箋、T テキスト、E 編集、P 手書き、R 矩形、O 楕円、L 直線、A 矢印、S 署名、M 測定）。Ctrl + ホイールで拡大縮小。'],
    ['ページの整理', '左サイドバーのサムネイルをドラッグして並べ替え。Ctrl / Shift で複数選択し、右クリックで回転・削除・複製・挿入・抽出。エクスプローラーから PDF や画像をサムネイル欄にドロップすると挿入できます。'],
    ['既存テキストの編集', '「テキスト編集」ツールで文字列をクリックすると、元の文字を白で覆い新しい文字を同じ位置に配置します。'],
    ['墨消し', '墨消しツールで範囲をドラッグするか、検索パネルの「検索結果をすべて墨消しマーク」でマークし、「文書 > 墨消しを適用」で確定します。対象ページは画像化され、下の文字情報は保存ファイルからも完全に削除されます。'],
    ['OCR', '「文書 > テキスト認識 (OCR)」でスキャン PDF の文字を認識し、検索・コピー可能にします（日本語対応、PC 内で処理）。'],
    ['フォーム', '既存の PDF フォームはそのまま入力できます。ツールバーのフォームツールで新しい入力欄・チェックボックス・ドロップダウンを作成できます。'],
    ['一括処理', '複数のファイルにまとめて OCR・透かし・ページ番号・ベイツ番号・フラット化・圧縮・パスワード保護などを行い、PDF・Word・テキスト・画像で保存します。「ファイル > 一括処理」から使えます。元のファイルは変更しません。'],
    ['寸法の測定', 'ツールバーの定規ツールで距離（ドラッグ）、周長・面積（クリックで頂点、ダブルクリックか Enter で確定）を測ります。「文書 > 測定の縮尺」で 1:100 などの縮尺と単位を、「文書 > 縮尺を合わせる」で図面の寸法線から縮尺を設定できます。測定は選択して頂点をドラッグすると調整できます。'],
    ['TIFF', '複数ページの TIFF（LZW・JPEG・ファクス G3/G4 など）を開くと、各ページを PDF のページとして表示します。保存すると PDF になります。ページの挿入・結合にも使えます。'],
    ['不具合の報告・エラーログ', 'エラーが起きると内容を PC 内のログに記録します。「ヘルプ > 不具合を報告」で、ユーザー名やファイル名を伏せたログを GitHub の報告ページに下書きとして開けます（送信前に確認できます）。'],
    ['言語', '「表示 > 言語 / Language」で日本語・英語・タイ語を切り替えられます。'],
    ['保護', '「文書 > パスワードで保護」で開くパスワードと権限（印刷・コピー・編集）を設定できます。保存時に AES で暗号化されます。作成者が制限を付けた PDF は、その制限を守って開きます。'],
    ['書き出し', '「ファイル > 書き出し」から Word（.docx）・テキスト・画像（PNG/JPEG）に変換。「ファイルサイズを縮小して保存」で圧縮できます。']
  ];
  const body = el('div', { class: 'help' }, ...sections.flatMap(([h, t]) => [el('h3', {}, h), el('p', {}, t)]));
  await ask({ title: 'PDF Studio の使い方', custom: body, cancel: null, ok: '閉じる', width: 620 });
}
