// エントリーポイント：画面の初期化・メニュー/キーボードの振り分け
import { startAutoTranslate, setLang, t } from './i18n.js';
import { state, bus, hasDoc, undo, redo, setDirty, can, setBusyProbe } from './doc.js';
import { initViewer, buildPages, view, setTool, zoomTo, scrollToPage, currentPage, stepPage, setLayout, select, removeObject, nudgeSelected, TOOLS, DEFAULT_TOOL, finishPoly, cancelPoly, undoPolyPoint, polyActive } from './viewer.js';
import { initToolbar, initSidebar, initInspector, reloadSidebar, showSearchTab, updateZoomSelect, updateToolAvailability, outlineAction } from './panels.js';
import * as F from './features.js';
import { batchProcess } from './batch.js';
import { panelResizer } from './layout.js';
import { $, toast, promptText } from './util.js';

const ACTIONS = {
  open: F.openDialog,
  'new-blank': F.newBlank,
  'create-from-files': F.createFromFiles,
  'merge-files': F.mergeFiles,
  batch: batchProcess,
  save: F.save,
  'save-as': F.saveAs,
  'save-and-close': F.saveAndClose,
  'save-optimized': F.saveOptimized,
  'export-docx': F.exportDocx,
  'export-text': F.exportText,
  'export-images': F.exportImages,
  print: F.print,
  undo: () => (isTyping() ? document.execCommand('undo') : undo()),
  redo: () => (isTyping() ? document.execCommand('redo') : redo()),
  'delete-selected': () => view.selected && removeObject(view.selected),
  find: showSearchTab,
  'zoom-in': () => zoomTo(view.scale * 1.2),
  'zoom-out': () => zoomTo(view.scale / 1.2),
  'zoom-100': () => zoomTo(1),
  'zoom-page': () => zoomTo(view.scale, 'page'),
  'zoom-width': () => zoomTo(view.scale, 'width'),
  'layout-single': () => hasDoc() && setLayout('single'),
  'layout-two': () => hasDoc() && setLayout('two'),
  'prev-page': () => stepPage(-1),
  'next-page': () => stepPage(1),
  'goto-page': async () => {
    if (!hasDoc()) return;
    const v = await promptText('ページへ移動', String(currentPage() + 1), { message: `1〜${view.pages.length}` });
    const n = parseInt(v, 10);
    if (n >= 1 && n <= view.pages.length) scrollToPage(n - 1);
  },
  'toggle-sidebar': () => document.body.classList.toggle('no-sidebar'),
  'rotate-right': () => F.rotate(90),
  'rotate-left': () => F.rotate(-90),
  'insert-blank': F.insertBlankPage,
  'insert-file': () => F.insertFile(),
  'duplicate-pages': F.duplicate,
  'extract-pages': F.extractPages,
  split: F.split,
  'delete-pages': F.deleteSelectedPages,
  ocr: F.ocr,
  watermark: F.watermark,
  'header-footer': F.headerFooter,
  bates: F.bates,
  'apply-redactions': F.applyRedactions,
  flatten: F.flatten,
  protect: F.protect,
  unprotect: F.unprotect,
  compare: F.compare,
  'compare-overlay': () => F.compareOverlay(),
  'normalize-size': F.normalizeSizeDialog,
  // しおりの欄のボタン（ほかの操作と重ならないよう run を通す）
  ...Object.fromEntries(['add', 'rename', 'delete', 'up', 'down', 'indent', 'outdent'].map((k) => [`outline-${k}`, () => outlineAction(k)])),
  'measure-scale': F.measureScale,
  calibrate: F.calibrate,
  properties: F.properties,
  help: F.help
};

/** 処理中でも受け付ける軽い操作 */
const ALWAYS = new Set(['zoom-in', 'zoom-out', 'zoom-100', 'zoom-page', 'zoom-width', 'toggle-sidebar', 'prev-page', 'next-page']);

const modalOpen = () => !!document.querySelector('.backdrop');

let busy = false;
let restoringView = false; // 前回の続きのページ・倍率に戻している途中
async function run(action) {
  const fn = ACTIONS[action];
  if (!fn) return;
  // ダイアログ表示中・処理中は、裏で別の操作が走らないようにする
  if ((busy || modalOpen()) && !ALWAYS.has(action)) return;
  const exclusive = !ALWAYS.has(action);
  if (exclusive) busy = true;
  try {
    await fn();
  } catch (e) {
    console.error(e);
    if (e?.message !== 'CANCELLED') window.api.logError('handled', { message: `${action}: ${e?.message}`, stack: `${action}: ${e?.stack || e}` });
    if (e?.message !== 'CANCELLED') toast(t(`エラー: ${e.message}`), 5000);
  } finally {
    if (exclusive) busy = false;
  }
}

function isTyping() {
  const a = document.activeElement;
  return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable);
}

// ---------------------------------------------------------------- 初期化

// 想定外のエラーはログに記録する（報告をすすめるかはメインプロセスが決める）
window.addEventListener('error', (e) => window.api.logError('uncaught', { message: e.message, stack: e.error?.stack || `${e.message} @ ${e.filename}:${e.lineno}` }));
window.addEventListener('unhandledrejection', (e) => {
  if (e.reason?.message === 'CANCELLED') return;
  window.api.logError('uncaught', { message: String(e.reason?.message || e.reason), stack: e.reason?.stack || String(e.reason) });
});

async function init() {
  startAutoTranslate();
  window.api.onLang((l) => setLang(l));
  window.api.onToast((m) => toast(m, 5000));
  initViewer();
  initToolbar(run);
  initSidebar(run, { run, insertFile: F.insertFile, movePagesTo: F.movePagesTo });
  initInspector();
  // サイドバーは境目をドラッグして幅を変えられる
  panelResizer($('#sidebar'), 'left', { min: 150, max: 600, def: 230, key: 'sidebarWidth' });
  window.api.onMenu(run);

  bus.addEventListener('doc-opened', async () => {
    document.body.classList.add('has-doc');
    view.fit = 'width';
    view.selected = null;
    updateToolAvailability();
    if (TOOLS[view.tool].perm && !can(TOOLS[view.tool].perm)) setTool('select');
    await buildPages(0);
    reloadSidebar();
    updateZoomSelect();
  });
  bus.addEventListener('doc-changed', async () => {
    if (view.selected && !state.pageIds.some((pid) => (state.objects[pid] || []).some((o) => o.id === view.selected))) view.selected = null;
    updateToolAvailability();
    await buildPages(currentPage());
    reloadSidebar();
  });
  bus.addEventListener('crop-request', (e) => run2(() => F.cropTo(e.detail)));
  bus.addEventListener('form-field-request', (e) => run2(() => F.createFormField(e.detail)));
  bus.addEventListener('calibrate', (e) => run2(() => F.finishCalibration(e.detail)));

  // キーボード
  document.addEventListener('keydown', (e) => {
    if (modalOpen() || isTyping() || !hasDoc()) return;
    // 周長・面積の入力中
    if (polyActive()) {
      if (e.key === 'Enter') { e.preventDefault(); finishPoly(); return; }
      if (e.key === 'Escape') { e.preventDefault(); cancelPoly(); return; }
      if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); undoPolyPoint(); return; }
    }
    if (e.key === 'Escape' && view.calibrating) { view.calibrating = false; toast('キャリブレーションを中止しました'); return; }
    if (e.key === 'Escape') { if (view.selected) select(null); else setTool(DEFAULT_TOOL); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && view.selected) { e.preventDefault(); if (can('annotate')) removeObject(view.selected); return; }
    if (view.selected && e.key.startsWith('Arrow')) {
      e.preventDefault();
      if (!can('annotate')) return;
      const step = e.shiftKey ? 10 : 1;
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
      nudgeSelected(...d);
      return;
    }
    if (e.key === 'PageDown') { e.preventDefault(); ACTIONS['next-page'](); return; }
    if (e.key === 'PageUp') { e.preventDefault(); ACTIONS['prev-page'](); return; }
    // テンキーの ＋ と － で拡大・縮小（Ctrl を押していても同じ）
    if (e.code === 'NumpadAdd' || e.code === 'NumpadSubtract') {
      e.preventDefault();
      ACTIONS[e.code === 'NumpadAdd' ? 'zoom-in' : 'zoom-out']();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const tool = Object.entries(TOOLS).find(([, t]) => t.key === e.key.toLowerCase());
    if (tool) setTool(tool[0]);
  });

  // ファイルのドロップで開く
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    if (modalOpen()) return;
    // 先頭だけ読んで形式を見分け、開ける・PDF にできるファイルだけ全部読む（大きな動画などを丸ごと読まないように）
    const files = [];
    for (const f of [...e.dataTransfer.files]) {
      try {
        const head = new Uint8Array(await f.slice(0, 4097).arrayBuffer());
        files.push({ name: f.name, bytes: F.droppedKind(f.name, head) ? new Uint8Array(await f.arrayBuffer()) : head });
      } catch {
        files.push({ name: f.name, bytes: new Uint8Array(0) }); // フォルダーなど読めないもの
      }
    }
    await F.openDropped(files);
  });

  // ようこそ画面
  $('#welcome-open').addEventListener('click', () => run('open'));
  $('#welcome-create').addEventListener('click', () => run('create-from-files'));
  $('#welcome-merge').addEventListener('click', () => run('merge-files'));
  $('#welcome-blank').addEventListener('click', () => run('new-blank'));
  $('#welcome-batch').addEventListener('click', () => run('batch'));

  window.api.setTitle('PDF Studio');
  // 画面が最初に描かれるまでの時間が長ければ記録する（タブの画面が描かれないままになっていないかの確認用）
  requestAnimationFrame(() => { const ms = Math.round(performance.now()); if (ms > 2000) window.api.logInfo(`slow first frame: ${ms}ms`); });
  // 日本語フォント（注釈の表示用）は裏で読み込み、読み込めたら注釈を描き直す
  Promise.all(['16px "Noto Sans JP"', '16px "Noto Sans Thai"', '700 16px "Noto Sans Thai"'].map((f) => document.fonts.load(f))).then(() => bus.dispatchEvent(new CustomEvent('objects-changed', { detail: { pages: null } }))).catch(() => {});

  // 自動テストから、開き直したタブのページと倍率を確かめられるように
  window.__view = view;
  window.__currentPage = currentPage;
  // 最近使ったファイル（ようこそ画面）
  renderRecent();
  window.api.onRecentChanged(() => renderRecent());
  // 異常終了時の写しは、ほかの操作の途中には作らない
  setBusyProbe(() => busy);
  // 前回の続き：見ているページと倍率をアプリに知らせる（少しまとめてから）。
  // 前のページ・倍率に戻している間は知らせない（開いた直後の「幅に合わせる」で上書きしないように）
  let viewTimer = null;
  const reportView = () => {
    if (restoringView) return;
    clearTimeout(viewTimer);
    viewTimer = setTimeout(() => { if (hasDoc()) window.api.docView({ page: currentPage(), scale: view.scale, fit: view.fit || null }); }, 500);
  };
  bus.addEventListener('page-changed', reportView);
  bus.addEventListener('zoom-changed', reportView);

  const init = await window.api.getInitial();
  if (init?.error) toast(`開けませんでした: ${init.error}`, 5000);
  else if (init?.bytes) {
    await F.openHere(new Uint8Array(init.bytes), init.path, init.name);
    // 開けなかった（パスワードのキャンセル・壊れたファイル）ときは、前回の続き・最近使ったファイルの対象から外す
    if (!hasDoc()) window.api.docSource(null);
    if (init.recovered) {
      // 異常終了時の写しから復元した文書：保存していない状態で開き、元のファイルを知らせる（保存するときは保存先を聞く）
      if (hasDoc()) {
        if (init.source) window.api.docSource(init.source);
        setDirty(true);
        window.api.recoveryOpened();
        toast('前回保存していなかった文書を復元しました。内容を確かめてから保存してください。', 6000);
      }
    } else if (!init.path && hasDoc() && !state.convertedOnly) setDirty(true); // TIFF を変換しただけのときは印をそのままにする
    if (init.view && hasDoc()) {
      restoringView = true;
      try { await restoreView(init.view); } finally { restoringView = false; }
    }
  }
}

/** 前回の続き：前に見ていた倍率とページに戻す。
 *  後ろのタブは表示されるまで画面の大きさが 0 なので、ページが並んで大きさが付いてから戻す */
async function restoreView(v) {
  const viewerEl = document.getElementById('viewer');
  const ok = () => view.pages.length > 0 && viewerEl.clientWidth > 0 && viewerEl.clientHeight > 0;
  while (!ok()) {
    if (!hasDoc()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  // 表示されたときの「幅に合わせる」の計算が終わってから戻す
  await new Promise((r) => setTimeout(r, 300));
  if (!hasDoc()) return;
  if (v.fit === 'width' || v.fit === 'page') zoomTo(view.scale, v.fit);
  else if (v.scale > 0) zoomTo(v.scale);
  const page = Math.min(Math.max(0, v.page | 0), state.pageIds.length - 1);
  if (page > 0) scrollToPage(page, false);
}

/** ようこそ画面に最近使ったファイルを並べる（ファイル名は訳さない） */
async function renderRecent() {
  const box = $('#welcome-recent');
  if (!box) return;
  let list = [];
  try { list = await window.api.recentFiles(); } catch { /* 出せなくても続ける */ }
  const ul = box.querySelector('ul');
  ul.replaceChildren(...list.map((f) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.className = 'recent-item';
    b.title = f.path;
    b.setAttribute('translate', 'no');
    const n = document.createElement('span'); n.className = 'recent-name'; n.textContent = f.name;
    const d = document.createElement('span'); d.className = 'recent-dir'; d.textContent = f.dir;
    b.append(n, d);
    b.addEventListener('click', () => window.api.openRecent(f.path));
    li.append(b);
    return li;
  }));
  box.hidden = !list.length;
}

/** イベントから呼ばれる処理も、他の処理と重ならないようにする */
async function run2(fn) {
  if (busy) return;
  busy = true;
  try { await fn(); } catch (e) { console.error(e); toast(`エラー: ${e.message}`, 5000); } finally { busy = false; }
}

init().then(() => {
  if (location.search.includes('selftest')) import('./selftest.js').then((m) => m.run());
  if (location.search.includes('perftest')) import('./perftest.js').then((m) => m.run());
});
