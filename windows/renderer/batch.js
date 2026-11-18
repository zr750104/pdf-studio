// 一括処理：複数のファイルに OCR・透かし・ページ番号・ベイツ番号・フラット化・圧縮・保護などをまとめて行う
// 開いている文書（state）には触らず、ファイルごとに pdf-lib / pdf.js で読み込んで処理する
import { PL, pdfjsLib, PDFJS_OPTS, saveLib, loadLib, readPermissions, collectGarbage, addInvisibleText, jpFont, flattenAnnotations } from './doc.js';
import {
  askPassword, sourcesToPdf, sniffKind, renderToCanvas, getOcrWorker, releaseOcrLater, cleanOcr, drawWatermark, drawHeaderFooter, textLines
} from './features.js';
import { addTiffPages } from './tiff.js';
import { el, ask, alertBox, toast, progress, canvasToBytes, baseName } from './util.js';
import { t } from './i18n.js';

const { PDFDocument } = PL;
const SETTINGS_KEY = 'batchSettings';
const INPUT_EXT = ['pdf', 'tif', 'tiff', 'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'docx', 'txt', 'html', 'htm', 'md', 'csv'];

/** 前回の設定（パスワードは保存しない） */
const DEFAULTS = {
  ocr: { on: false, lang: 0, skip: true },
  watermark: { on: false, text: '社外秘', size: 72, color: '#e03131', opacity: 25, angle: 45 },
  numbers: { on: false, text: '{page} / {total}', pos: 0, size: 10 },
  bates: { on: false, prefix: 'ABC', start: 1, digits: 6, pos: 0, continuous: true },
  flatten: { on: false },
  meta: { on: false, author: '', titleFromName: true },
  compress: { on: false, mode: 0, dpi: 120, quality: 70 },
  protect: { on: false, user: '', owner: '', print: true, copy: true, edit: true },
  output: { format: 'pdf', suffix: '_処理済', overwrite: false }
};
function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch { /* 初期値を使う */ }
  const out = {};
  for (const [k, v] of Object.entries(DEFAULTS)) out[k] = { ...v, ...(saved[k] || {}) };
  out.protect.user = out.protect.owner = '';
  return out;
}
function saveSettings(o) {
  const copy = JSON.parse(JSON.stringify(o));
  copy.protect.user = copy.protect.owner = '';
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(copy)); } catch { /* 保存できなくても処理は続ける */ }
}

const NUMBER_POS = ['fc', 'fr', 'fl', 'hc', 'hr', 'hl'];
const BATES_POS = ['fr', 'fc', 'fl', 'hr'];
const ext = (name) => (name.match(/\.([^.]+)$/)?.[1] || '').toLowerCase();
const joinPath = (dir, name) => `${dir.replace(/[\\/]+$/, '')}${dir.includes('\\') ? '\\' : '/'}${name}`;

/** 同じ名前のファイルがあれば「名前 (2).pdf」のようにずらす */
async function uniquePath(dir, name, overwrite) {
  const p = joinPath(dir, name);
  if (overwrite || (await window.api.fileSize(p)) == null) return p;
  const b = baseName(name), e = ext(name);
  for (let n = 2; ; n++) {
    const q = joinPath(dir, `${b} (${n}).${e}`);
    if ((await window.api.fileSize(q)) == null) return q;
  }
}

async function openPdfjs(lib) {
  // saveLib を通す（保存したあとに同じページへ描いた内容が消える pdf-lib の癖への対策）
  const bytes = await saveLib(lib);
  return pdfjsLib.getDocument({ data: bytes, ...PDFJS_OPTS }).promise;
}

/** 1 ファイルを PDF（pdf-lib）として読み込む */
async function loadSource(f) {
  const kind = sniffKind(f.name, f.bytes);
  if (kind === 'pdf') {
    const { lib, password } = await loadLib(new Uint8Array(f.bytes), askPassword, f.name);
    const perms = password != null ? await readPermissions(new Uint8Array(f.bytes), password) : null;
    return { lib, password, perms };
  }
  if (kind === 'tiff') {
    const lib = await PDFDocument.create();
    await addTiffPages(lib, f.bytes);
    return { lib, password: null, perms: null };
  }
  const skipped = [];
  const lib = await sourcesToPdf([f], skipped);
  if (skipped[0]?.cancelled) throw new Error('CANCELLED');
  if (!lib.getPageCount()) throw new Error(skipped[0]?.reason || t('読み込めませんでした'));
  return { lib, password: null, perms: null };
}

/** ページを画像にして作り直す（強力な圧縮） */
async function rasterize(lib, dpi, quality, isCancelled) {
  const pdf = await openPdfjs(lib);
  const out = await PDFDocument.create();
  try {
    for (let i = 0; i < pdf.numPages; i++) {
      if (isCancelled()) throw new Error('CANCELLED');
      const page = await pdf.getPage(i + 1);
      const { canvas } = await renderToCanvas(pdf, i, dpi);
      const vp1 = page.getViewport({ scale: 1, rotation: page.rotate });
      const img = await out.embedJpg(await canvasToBytes(canvas, 'image/jpeg', quality));
      canvas.width = 0;
      out.addPage([vp1.width, vp1.height]).drawImage(img, { x: 0, y: 0, width: vp1.width, height: vp1.height });
    }
  } finally {
    pdf.destroy();
  }
  for (const k of ['Title', 'Author', 'Subject', 'Keywords']) {
    const v = lib[`get${k}`]?.();
    if (v) out[`set${k}`](v);
  }
  return out;
}

/** 文字のないページを OCR して透明テキストを重ねる。戻り値は認識した行数 */
async function ocrPages(lib, o, step, isCancelled) {
  const pdf = await openPdfjs(lib);
  const results = [];
  try {
    const worker = await getOcrWorker([['jpn', 'eng'], ['eng'], ['jpn']][+o.lang] || ['jpn', 'eng']);
    for (let i = 0; i < pdf.numPages; i++) {
      if (isCancelled()) throw new Error('CANCELLED');
      if (o.skip) {
        const tc = await (await pdf.getPage(i + 1)).getTextContent();
        if (tc.items.some((it) => it.str.trim())) continue;
      }
      step(`OCR ${i + 1} / ${pdf.numPages}`);
      const { canvas, vp } = await renderToCanvas(pdf, i, 300, { rotate: false, annotations: false });
      const { data } = await worker.recognize(canvas);
      canvas.width = 0;
      const lines = (data.lines || []).filter((l) => l.confidence > 30 && l.text.trim()).map((l) => {
        const [ax, ay] = vp.convertToPdfPoint(l.bbox.x0, l.bbox.y1);
        const [bx, by] = vp.convertToPdfPoint(l.bbox.x1, l.bbox.y0);
        return { text: cleanOcr(l.text), rect: [Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay)] };
      });
      if (lines.length) results.push([i, lines]);
    }
  } finally {
    pdf.destroy();
    releaseOcrLater();
  }
  for (const [i, lines] of results) await addInvisibleText(lib, i, lines);
  return results.reduce((s, [, l]) => s + l.length, 0);
}

/** 書き出し（PDF 以外の形式） */
async function writeConverted(lib, f, o, outDir) {
  const pdf = await openPdfjs(lib);
  const outputs = [];
  try {
    const name = `${baseName(f.name)}${o.output.suffix || ''}`;
    if (o.output.format === 'txt' || o.output.format === 'docx') {
      const pages = await textLines(pdf);
      const p = await uniquePath(outDir, `${name}.${o.output.format}`, o.output.overwrite);
      if (o.output.format === 'txt') await window.api.writeFile(p, new TextEncoder().encode('﻿' + pages.map((l) => l.join('\r\n')).join('\r\n\f\r\n')));
      else await window.api.exportDocx(p, pages);
      outputs.push(p);
    } else {
      const jpeg = o.output.format === 'jpg';
      for (let i = 0; i < pdf.numPages; i++) {
        const { canvas } = await renderToCanvas(pdf, i, 150);
        const data = await canvasToBytes(canvas, jpeg ? 'image/jpeg' : 'image/png');
        canvas.width = 0;
        const p = await uniquePath(outDir, `${name}_${String(i + 1).padStart(3, '0')}.${jpeg ? 'jpg' : 'png'}`, o.output.overwrite);
        await window.api.writeFile(p, data);
        outputs.push(p);
      }
    }
  } finally {
    pdf.destroy();
  }
  return outputs;
}

/** 書き換えを伴う処理が選ばれているか */
const modifies = (o) => ['ocr', 'watermark', 'numbers', 'bates', 'flatten', 'meta', 'compress', 'protect'].some((k) => o[k]?.on);

/**
 * 一括処理の本体。files: [{ name, path, bytes }]、o: 設定、outDir: 保存先フォルダ
 * 戻り値: [{ name, status: 'ok' | 'skipped' | 'error', message, outputs }]
 */
export async function runBatch(files, o, outDir, { onStep = () => {}, isCancelled = () => false } = {}) {
  const results = [];
  let batesNext = o.bates.start | 0;
  for (const [fi, f] of files.entries()) {
    if (isCancelled()) break;
    const step = (s) => onStep(fi, f.name, s);
    const res = { name: f.name, status: 'ok', message: '', outputs: [] };
    results.push(res);
    try {
      step(t('読み込み中'));
      const { lib: loaded, password, perms } = await loadSource(f);
      let lib = loaded;
      // 作成者が制限した文書は、制限を守って処理しない
      if (perms && (modifies(o) || o.output.format !== 'pdf')) {
        res.status = 'skipped';
        res.message = t('作成者による編集・コピーの制限があるため処理しませんでした');
        continue;
      }
      const all = lib.getPageIndices();
      if (o.flatten.on) {
        step(t('フラット化'));
        const form = lib.getForm();
        if (form.getFields().length) {
          try { form.updateFieldAppearances(await jpFont(lib)); } catch { /* 外観を作れない欄はそのまま */ }
          form.flatten();
        }
        flattenAnnotations(lib);
      }
      if (o.watermark.on && String(o.watermark.text).trim()) { step(t('透かし')); await drawWatermark(lib, all, o.watermark); }
      if (o.numbers.on && String(o.numbers.text).trim()) {
        step(t('ページ番号'));
        await drawHeaderFooter(lib, all, { [NUMBER_POS[+o.numbers.pos] || 'fc']: o.numbers.text, size: o.numbers.size, margin: 28, start: 1 });
      }
      if (o.bates.on) {
        step(t('ベイツ番号'));
        const digits = Math.min(12, Math.max(1, o.bates.digits | 0));
        const first = o.bates.continuous ? batesNext : o.bates.start | 0;
        const label = (n) => o.bates.prefix + String(first + n).padStart(digits, '0');
        await drawHeaderFooter(lib, all, { [BATES_POS[+o.bates.pos] || 'fr']: label, size: 10, margin: 28 });
        batesNext = first + all.length;
        res.message = `${o.bates.prefix}${String(first).padStart(digits, '0')} – ${o.bates.prefix}${String(batesNext - 1).padStart(digits, '0')}`;
      }
      if (o.compress.on && +o.compress.mode === 1) {
        step(t('圧縮'));
        lib = await rasterize(lib, Math.min(300, Math.max(50, o.compress.dpi || 120)), Math.min(100, Math.max(10, o.compress.quality || 70)) / 100, isCancelled);
      }
      if (o.ocr.on) await ocrPages(lib, o.ocr, step, isCancelled);
      if (o.meta.on) {
        if (o.meta.author) lib.setAuthor(o.meta.author);
        if (o.meta.titleFromName) lib.setTitle(baseName(f.name));
      }
      step(t('保存'));
      if (o.output.format === 'pdf') {
        lib.setProducer('PDF Studio for Windows');
        lib.setModificationDate(new Date());
        // 保護：指定があればそのパスワード、元ファイルにパスワードがあればそれを引き継ぐ
        const pr = o.protect.on ? o.protect : password ? { user: password, owner: password, print: true, copy: true, edit: true } : null;
        if (pr && (pr.user || pr.owner)) {
          lib.encrypt({
            userPassword: pr.user || '',
            ownerPassword: pr.owner || pr.user,
            permissions: { printing: pr.print ? 'highResolution' : undefined, copying: pr.copy, modifying: pr.edit, annotating: pr.edit, fillingForms: pr.edit, documentAssembly: pr.edit, contentAccessibility: true }
          });
        }
        await lib.flush();
        collectGarbage(lib);
        const bytes = await lib.save({ useObjectStreams: true });
        const p = await uniquePath(outDir, `${baseName(f.name)}${o.output.suffix || ''}.pdf`, o.output.overwrite);
        await window.api.writeFile(p, bytes);
        res.outputs.push(p);
      } else {
        res.outputs.push(...(await writeConverted(lib, f, o, outDir)));
      }
    } catch (e) {
      if (e?.message === 'CANCELLED') {
        res.status = 'skipped';
        res.message = isCancelled() ? t('中止しました') : t('パスワードが入力されなかったため処理しませんでした');
        if (isCancelled()) break;
      } else {
        res.status = 'error';
        res.message = e?.message || String(e);
        window.api.logError('handled', { message: `batch: ${e?.message}`, stack: `batch: ${e?.stack || e}` });
      }
    }
  }
  return results;
}

// ---------------------------------------------------------------- 画面

/** 設定ダイアログの部品 */
function section(title, obj, rows) {
  const on = el('input', { type: 'checkbox', checked: obj.on });
  const body = el('div', { class: 'batch-body' }, ...rows);
  const sync = () => { body.classList.toggle('off', !on.checked); obj.on = on.checked; };
  on.addEventListener('change', sync);
  sync();
  return el('div', { class: 'batch-sec' }, el('label', { class: 'batch-head' }, on, ' ', title), body);
}
function input(obj, key, attrs = {}) {
  const isCheck = attrs.type === 'checkbox';
  const e = el('input', { type: 'text', ...attrs, checked: isCheck ? !!obj[key] : null });
  if (!isCheck) e.value = obj[key] ?? '';
  e.addEventListener(isCheck ? 'change' : 'input', () => { obj[key] = isCheck ? e.checked : attrs.type === 'number' ? Number(e.value) : e.value; });
  return e;
}
function select(obj, key, options) {
  const e = el('select', {}, ...options.map(([v, label]) => el('option', { value: v, selected: String(obj[key]) === String(v) }, label)));
  e.addEventListener('change', () => { obj[key] = e.value; });
  return e;
}
const field = (label, ...c) => el('label', { class: 'batch-field' }, el('span', {}, label), ...c);

/** ファイル > 一括処理 */
export async function batchProcess() {
  const o = loadSettings();
  if (o.watermark.text === '社外秘') o.watermark.text = t('社外秘');
  if (o.output.suffix === '_処理済') o.output.suffix = t('_処理済');
  let files = [];
  let outDir = localStorage.getItem('batchOutDir') || '';

  const list = el('div', { class: 'batch-files', translate: 'no' });
  const count = el('span', { class: 'batch-count' });
  const renderFiles = () => {
    list.replaceChildren(...(files.length ? files.map((f, k) => el('div', { class: 'batch-file' }, el('span', {}, f.name),
      el('button', { type: 'button', class: 'small', title: t('削除'), onclick: () => { files.splice(k, 1); renderFiles(); } }, '×')))
      : [el('p', { class: 'note' }, t('処理するファイルを追加してください（PDF・TIFF・画像・Word など）。'))]));
    count.textContent = files.length ? t(`${files.length} 件`) : '';
  };
  renderFiles();
  const addFiles = async () => {
    const picked = await window.api.openDialog({ title: '一括処理するファイル', multiple: true, filters: [{ name: '対応ファイル', extensions: INPUT_EXT }] });
    const seen = new Set(files.map((f) => f.path));
    files.push(...picked.filter((f) => !seen.has(f.path)));
    renderFiles();
  };
  const dirLabel = el('span', { class: 'batch-dir', translate: 'no' }, outDir || t('（未選択）'));
  const chooseDir = async () => {
    const d = await window.api.chooseFolder('保存先フォルダ');
    if (d) { outDir = d; dirLabel.textContent = d; }
  };

  const ui = el('div', { class: 'batch' },
    el('div', { class: 'batch-row' }, el('b', {}, t('ファイル')), count,
      el('button', { type: 'button', onclick: addFiles }, t('＋ ファイルを追加…')),
      el('button', { type: 'button', onclick: () => { files = []; renderFiles(); } }, t('すべて外す'))),
    list,
    el('b', { class: 'batch-title' }, t('処理（上から順に行います）')),
    section(t('注釈とフォームをフラット化'), o.flatten, [el('p', { class: 'note' }, t('注釈・フォームをページに焼き込みます（リンクは残ります）。'))]),
    section(t('透かし'), o.watermark, [field(t('文字'), input(o.watermark, 'text')), field(t('サイズ (pt)'), input(o.watermark, 'size', { type: 'number', min: 4, max: 400 })),
      field(t('色'), input(o.watermark, 'color', { type: 'color' })), field(t('不透明度 (%)'), input(o.watermark, 'opacity', { type: 'number', min: 1, max: 100 })),
      field(t('角度 (°)'), input(o.watermark, 'angle', { type: 'number' }))]),
    section(t('ページ番号・ヘッダー / フッター'), o.numbers, [field(t('文字'), input(o.numbers, 'text')),
      field(t('位置'), select(o.numbers, 'pos', [t('フッター 中央'), t('フッター 右'), t('フッター 左'), t('ヘッダー 中央'), t('ヘッダー 右'), t('ヘッダー 左')].map((l, i) => [i, l]))),
      field(t('文字サイズ'), input(o.numbers, 'size', { type: 'number', min: 4, max: 72 })),
      el('p', { class: 'note' }, t('{page} = ページ番号、{total} = 総ページ数、{date} = 今日の日付'))]),
    section(t('ベイツ番号'), o.bates, [field(t('接頭辞'), input(o.bates, 'prefix')), field(t('開始番号'), input(o.bates, 'start', { type: 'number', min: 0 })),
      field(t('桁数'), input(o.bates, 'digits', { type: 'number', min: 1, max: 12 })),
      field(t('位置'), select(o.bates, 'pos', [t('右下'), t('中央下'), t('左下'), t('右上')].map((l, i) => [i, l]))),
      el('label', { class: 'check' }, input(o.bates, 'continuous', { type: 'checkbox' }), ' ', t('ファイルをまたいで通し番号にする'))]),
    section(t('ファイルサイズを縮小'), o.compress, [field(t('方法'), select(o.compress, 'mode', [[0, t('標準（不要なデータを除いて保存）')], [1, t('強力（ページを画像化して圧縮）')]])),
      field(t('解像度 (dpi)'), input(o.compress, 'dpi', { type: 'number', min: 50, max: 300 })), field(t('画質 (1-100)'), input(o.compress, 'quality', { type: 'number', min: 10, max: 100 }))]),
    section(t('テキスト認識 (OCR)'), o.ocr, [field(t('言語'), select(o.ocr, 'lang', [[0, t('日本語 + 英語')], [1, t('英語のみ')], [2, t('日本語のみ')]])),
      el('label', { class: 'check' }, input(o.ocr, 'skip', { type: 'checkbox' }), ' ', t('すでに文字のあるページはスキップする'))]),
    section(t('文書のプロパティ'), o.meta, [field(t('作成者'), input(o.meta, 'author')),
      el('label', { class: 'check' }, input(o.meta, 'titleFromName', { type: 'checkbox' }), ' ', t('タイトルをファイル名にする'))]),
    section(t('パスワードで保護（AES 暗号化）'), o.protect, [field(t('開くパスワード'), input(o.protect, 'user', { type: 'password' })), field(t('権限パスワード'), input(o.protect, 'owner', { type: 'password' })),
      el('label', { class: 'check' }, input(o.protect, 'print', { type: 'checkbox' }), ' ', t('印刷を許可')),
      el('label', { class: 'check' }, input(o.protect, 'copy', { type: 'checkbox' }), ' ', t('テキスト・画像のコピーを許可')),
      el('label', { class: 'check' }, input(o.protect, 'edit', { type: 'checkbox' }), ' ', t('編集・注釈・フォーム入力を許可'))]),
    el('b', { class: 'batch-title' }, t('保存')),
    el('div', { class: 'batch-body' },
      field(t('形式'), select(o.output, 'format', [['pdf', 'PDF'], ['docx', t('Word 文書 (.docx)')], ['txt', t('テキスト (.txt)')], ['png', t('画像 (PNG)')], ['jpg', t('画像 (JPEG)')]])),
      field(t('保存先'), dirLabel, el('button', { type: 'button', class: 'small', onclick: chooseDir }, t('選択…'))),
      field(t('ファイル名に付ける文字'), input(o.output, 'suffix')),
      el('label', { class: 'check' }, input(o.output, 'overwrite', { type: 'checkbox' }), ' ', t('同じ名前のファイルがあれば上書きする')),
      el('p', { class: 'note' }, t('元のファイルは変更しません。パスワード付きの PDF は、保護を指定しない場合も同じパスワードで保存します。')))
  );

  for (;;) {
    const r = await ask({ title: '一括処理', custom: ui, ok: '実行', width: 620 });
    if (!r) return;
    if (!files.length) { await alertBox('ファイルがありません', '処理するファイルを追加してください。'); continue; }
    if (!outDir) { await alertBox('保存先を選んでください'); continue; }
    if (o.protect.on && !o.protect.user && !o.protect.owner) { await alertBox('パスワードを入力してください'); continue; }
    break;
  }
  saveSettings(o);
  localStorage.setItem('batchOutDir', outDir);

  const pr = progress('一括処理しています…', files.length);
  let results;
  try {
    results = await runBatch(files, o, outDir, {
      onStep: (k, name, s) => pr.update(k, `${name} — ${s}`),
      isCancelled: () => pr.cancelled
    });
  } finally {
    pr.close();
  }
  const ok = results.filter((x) => x.status === 'ok').length;
  const skipped = results.filter((x) => x.status === 'skipped');
  const failed = results.filter((x) => x.status === 'error');
  const lines = [t(`完了 ${ok} 件・スキップ ${skipped.length} 件・失敗 ${failed.length} 件`)];
  if (o.bates.on && o.bates.continuous) lines.push(...results.filter((x) => x.status === 'ok' && x.message).map((x) => `${x.name}: ${x.message}`));
  for (const x of [...skipped, ...failed]) lines.push(`${x.name}: ${x.message}`);
  lines.push('', outDir);
  await alertBox(failed.length ? '一括処理が終わりました（失敗あり）' : '一括処理が終わりました', lines.join('\n'));
  const first = results.find((x) => x.outputs.length)?.outputs[0];
  if (first) window.api.showInFolder(first);
  else if (!ok) toast('出力したファイルはありません');
}
