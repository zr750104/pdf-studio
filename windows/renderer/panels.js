// ツールバー・書式バー・サイドバー（ページ／注釈／検索／しおり）
import { state, bus, hasDoc, pageText, pdfjsLib, addObjects, can, canRotate, measureValue } from './doc.js';
import { view, TOOLS, TOOL_GROUPS, setTool, select, selectedObject, scrollToPage, scrollToRect, zoomTo,
  updateObject, removeObject, editObjectContents, drawOverlay, textBoxHeight, subRange, measureWidth,
  rotateSelected, selectedDisplayAngle, setSelectedDisplayAngle, whenIdle, pageImage } from './viewer.js';
import { overflowBar, relayoutBars, panelResizer, layoutSetting, saveLayout } from './layout.js';
import { $, $$, el, toast } from './util.js';
import { ICONS } from './icons.js';
import { scanInfo, scanAvailable, renderScan, drawScan, scanTarget } from './scanpages.js';

const icon = (name, cls = '') => el('span', { class: `icon ${cls}`, html: ICONS[name] || '' });

// ---------------------------------------------------------------- ツールバー

export function initToolbar(run) {
  const bar = $('#toolbar');
  // ラベルは「»」メニューの中でだけ表示する（ツールバー上ではアイコンのみ）
  const btn = (iconName, title, action, cls = '') => el('button', { class: `tb ${cls}`, title, onclick: () => run(action) }, icon(iconName), el('span', { class: 'tb-label' }, title.replace(/\s*\(.*\)$/, '')));
  const sep = () => el('div', { class: 'sep' });

  bar.append(btn('panel-left', 'サイドバー (F4)', 'toggle-sidebar'), sep(),
    btn('folder-open', '開く (Ctrl+O)', 'open'), btn('save', '保存 (Ctrl+S)', 'save'), btn('printer', '印刷 (Ctrl+P)', 'print'),
    btn('undo-2', '元に戻す (Ctrl+Z)', 'undo'), btn('redo-2', 'やり直し (Ctrl+Y)', 'redo'), sep());

  for (const [gi, group] of TOOL_GROUPS.entries()) {
    for (const t of group) {
      const info = TOOLS[t];
      // マウスを乗せると、ツール名と使い方のヒントを出す
      bar.append(el('button', { class: 'tb tool', 'data-tool': t, title: `${info.label}${info.key ? ` (${info.key.toUpperCase()})` : ''}\n${info.hint}`, onclick: () => setTool(t) },
        icon(info.icon), el('span', { class: 'tb-label' }, info.label)));
    }
    if (gi < TOOL_GROUPS.length - 1) bar.append(sep());
  }

  const pageInput = el('input', { id: 'page-input', type: 'text', value: '1' });
  pageInput.addEventListener('change', () => {
    const n = parseInt(pageInput.value, 10);
    if (n >= 1 && n <= view.pages.length) scrollToPage(n - 1);
  });
  const zoomSel = el('select', { id: 'zoom-select', title: '表示倍率' },
    ...[['width', '幅に合わせる'], ['page', 'ページ全体'], [String(1 / 12), '8.33%'], ['0.125', '12.5%'], ['0.25', '25%'], ['0.5', '50%'], ['0.75', '75%'], ['1', '100%'], ['1.25', '125%'], ['1.5', '150%'], ['2', '200%'], ['3', '300%'], ['4', '400%'], ['8', '800%'], ['16', '1600%'], ['24', '2400%'], ['32', '3200%'], ['64', '6400%'], ['custom', '']].map(([v, l]) => el('option', { value: v }, l)));
  zoomSel.addEventListener('change', () => {
    const v = zoomSel.value;
    if (v === 'width' || v === 'page') zoomTo(view.scale, v);
    else if (v !== 'custom') zoomTo(+v);
  });
  // 右端（ページ移動・倍率）は常に表示し、入りきらないツールは「»」メニューにまとめる
  const right = el('div', { class: 'tb-right' },
    btn('chevron-up', '前のページ', 'prev-page'), pageInput, el('span', { id: 'page-count' }, '/ 0'), btn('chevron-down', '次のページ', 'next-page'), sep(),
    btn('zoom-out', '縮小 (Ctrl+-)', 'zoom-out'), zoomSel, btn('zoom-in', '拡大 (Ctrl+=)', 'zoom-in'));
  bar.append(right);
  overflowBar(bar, { fixed: right, menuClass: 'ovf-tools' });

  bus.addEventListener('tool-changed', updateToolbar);
  bus.addEventListener('page-changed', (e) => {
    if (document.activeElement !== pageInput) pageInput.value = (e.detail ?? 0) + 1;
    $('#page-count').textContent = `/ ${view.pages.length}`;
    highlightThumb(e.detail ?? 0);
  });
  bus.addEventListener('zoom-changed', updateZoomSelect);
  updateToolbar();
}

function updateToolbar() {
  $$('.tb.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === view.tool));
}

/** 作成者の制限で使えないツールを無効表示にする */
export function updateToolAvailability() {
  $$('.tb.tool').forEach((b) => {
    const perm = TOOLS[b.dataset.tool].perm;
    b.disabled = !!perm && !can(perm);
  });
  document.body.classList.toggle('restricted', !!state.perms);
}

export function updateZoomSelect() {
  const sel = $('#zoom-select');
  if (!sel) return;
  if (view.fit) sel.value = view.fit;
  else {
    const match = [...sel.options].find((o) => Math.abs(+o.value - view.scale) < 0.001);
    if (match) sel.value = match.value;
    else { sel.querySelector('[value=custom]').textContent = `${Math.round(view.scale * 100)}%`; sel.value = 'custom'; }
  }
}

// ---------------------------------------------------------------- サイドバー

let selected = new Set();
let anchor = null;
let actions = null;
let thumbEls = [];
let currentThumb = null;
let renderObserver, unloadObserver;
const thumbQueue = new Set();
const nearThumbs = new Set();   // 表示範囲の近く（描画する）
const keepThumbs = new Set();   // 保持する範囲（これより外は解放）
let thumbBusy = false;
let thumbRendering = 0;
window.__thumbBusy = () => thumbRendering > 0;
let thumbToken = 0;

export const selectedPages = () => [...selected].filter((i) => i < state.pageIds.length).sort((a, b) => a - b);

export function initSidebar(run, pageActions) {
  actions = pageActions;
  const side = $('#sidebar');
  const tabs = [['pages', 'ページ'], ['annots', '注釈'], ['search', '検索'], ['outline', 'しおり']];
  side.append(el('div', { class: 'tabs' }, ...tabs.map(([k, l]) => el('button', { 'data-tab': k, onclick: () => showTab(k) }, l))));
  // サムネイルの大きさ（スライダー、または Ctrl + ホイール）
  const sizeInput = el('input', { type: 'range', min: THUMB_MIN, max: THUMB_MAX, step: 10, value: thumbSize, title: 'サムネイルの大きさ（Ctrl + ホイールでも変更）' });
  sizeInput.addEventListener('input', () => setThumbSize(+sizeInput.value));
  side.append(el('div', { class: 'tab-body', id: 'tab-pages' },
    el('div', { class: 'thumb-bar' }, el('span', {}, '大きさ'), icon('image', 'small'), sizeInput, icon('image')),
    el('div', { id: 'thumbs' })));
  $('#tab-pages').addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setThumbSize(thumbSize + (e.deltaY < 0 ? 20 : -20));
    sizeInput.value = thumbSize;
  }, { passive: false });
  applyThumbSize();
  side.append(el('div', { class: 'tab-body', id: 'tab-annots' }, el('div', { id: 'annot-list' })));
  const q = el('input', { id: 'search-input', type: 'search', placeholder: '文書内を検索（Enter）' });
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(q.value, e.shiftKey ? -1 : 1); });
  side.append(el('div', { class: 'tab-body', id: 'tab-search' },
    el('div', { class: 'search-box' }, q, el('label', { class: 'check' }, el('input', { type: 'checkbox', id: 'search-case' }), ' 大文字小文字を区別')),
    el('div', { id: 'search-status' }),
    el('div', { id: 'search-results' }),
    el('button', { class: 'block', onclick: () => markAllForRedaction() }, '検索結果をすべて墨消しマーク')));
  side.append(el('div', { class: 'tab-body', id: 'tab-outline' }, el('div', { id: 'outline' })));
  showTab('pages');

  // サムネイル：近づいたら描画、遠ざかったら解放
  const root = $('#tab-pages');
  renderObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const i = +e.target.dataset.index;
      if (e.isIntersecting) { nearThumbs.add(i); thumbQueue.add(i); pumpThumbs(); }
      else { nearThumbs.delete(i); thumbQueue.delete(i); }
    }
  }, { root, rootMargin: '400px 0px' });
  unloadObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const i = +e.target.dataset.index;
      if (e.isIntersecting) keepThumbs.add(i);
      else { keepThumbs.delete(i); unloadThumb(i); }
    }
  }, { root, rootMargin: '2500px 0px' });

  const thumbs = $('#thumbs');
  let lastDrop = null;
  const clearDrop = () => { lastDrop?.classList.remove('drop-before', 'drop-after', 'drop-x'); lastDrop = null; };
  thumbs.addEventListener('dragover', (e) => {
    e.preventDefault();
    const t = dropTarget(e);
    if (lastDrop && lastDrop !== t?.el) clearDrop();
    if (t) {
      t.el.classList.toggle('drop-after', t.after);
      t.el.classList.toggle('drop-before', !t.after);
      t.el.classList.toggle('drop-x', t.grid);
      lastDrop = t.el;
    }
  });
  thumbs.addEventListener('dragleave', (e) => { if (!thumbs.contains(e.relatedTarget)) clearDrop(); });
  thumbs.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    clearDrop();
    const t = dropTarget(e);
    const at = t ? t.index + (t.after ? 1 : 0) : view.pages.length;
    if (e.dataTransfer.files.length) {
      const files = await Promise.all([...e.dataTransfer.files].map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
      actions.insertFile(at, files);
      return;
    }
    const from = e.dataTransfer.getData('text/x-pages');
    if (!from) return;
    const idx = from.split(',').map(Number);
    const newStart = await actions.movePagesTo(idx, at);
    if (newStart != null) selected = new Set(idx.map((_, k) => newStart + k));
    paintSelection();
  });

  document.addEventListener('click', () => $('#ctx-menu')?.remove());
  bus.addEventListener('objects-changed', () => markAnnotListDirty());
  bus.addEventListener('selection-changed', () => markAnnotListDirty());
}

let activeTab = 'pages';
function showTab(k) {
  activeTab = k;
  $$('#sidebar .tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === k));
  $$('#sidebar .tab-body').forEach((b) => b.classList.toggle('active', b.id === `tab-${k}`));
  if (k === 'search') setTimeout(() => $('#search-input').focus(), 30);
  if (k === 'annots' && annotListDirty) renderAnnotList();
}
export const showSearchTab = () => { document.body.classList.remove('no-sidebar'); showTab('search'); };

function dropTarget(e) {
  const t = e.target.closest('.thumb');
  if (!t) return null;
  const r = t.getBoundingClientRect();
  // 横に並んでいるとき（サイドバーが広い・サムネイルが小さい）は左右で判定する
  const grid = thumbEls.length > 1 && Math.abs(thumbEls[0].offsetTop - thumbEls[1].offsetTop) < 5;
  return { el: t, index: +t.dataset.index, after: grid ? e.clientX > r.left + r.width / 2 : e.clientY > r.top + r.height / 2, grid };
}

export function reloadSidebar() {
  const thumbs = $('#thumbs');
  thumbToken++;
  thumbQueue.clear();
  nearThumbs.clear();
  keepThumbs.clear();
  renderObserver.disconnect();
  unloadObserver.disconnect();
  for (const t of thumbEls) { const c = t.querySelector('canvas'); if (c) c.width = 0; }
  thumbs.replaceChildren();
  thumbEls = [];
  currentThumb = null;
  selected = new Set([...selected].filter((i) => i < state.pageIds.length));
  resetSearch();
  if (!hasDoc()) return;
  const frag = document.createDocumentFragment();
  for (let i = 0; i < state.pageIds.length; i++) {
    const t = el('div', { class: 'thumb', 'data-index': i, draggable: 'true' },
      el('div', { class: 'thumb-img' }), el('div', { class: 'thumb-label' }, String(i + 1)));
    t.addEventListener('click', (e) => onThumbClick(e, i));
    t.addEventListener('contextmenu', (e) => onThumbContext(e, i));
    t.addEventListener('dragstart', (e) => {
      if (!selected.has(i)) { selected = new Set([i]); paintSelection(); }
      e.dataTransfer.setData('text/x-pages', selectedPages().join(','));
      e.dataTransfer.effectAllowed = 'move';
    });
    frag.append(t);
    thumbEls.push(t);
  }
  thumbs.append(frag);
  for (const t of thumbEls) { renderObserver.observe(t); unloadObserver.observe(t); }
  paintSelection();
  markAnnotListDirty();
  renderOutline();
}

/** サムネイルは本体のページ描画が落ち着いてから 1 枚ずつ描く */
async function pumpThumbs() {
  if (thumbBusy) return;
  thumbBusy = true;
  const token = thumbToken;
  try {
    while (thumbQueue.size && token === thumbToken) {
      await new Promise((r) => (window.requestIdleCallback ? requestIdleCallback(r, { timeout: 300 }) : setTimeout(r, 16)));
      // 本体のページを描いている間は待つ（同じ pdf.js のワーカーを取り合わないように、本体を先に）
      await whenIdle();
      const i = thumbQueue.values().next().value;
      thumbQueue.delete(i);
      await renderThumb(i, token);
    }
  } finally {
    thumbBusy = false;
    // 描いている間に新しく頼まれた分があれば続ける
    if (thumbQueue.size) setTimeout(pumpThumbs, 0);
  }
}

// ---------------------------------------------------------------- サムネイルの大きさ

const THUMB_MIN = 70, THUMB_MAX = 320;
let thumbSize = Math.min(THUMB_MAX, Math.max(THUMB_MIN, +layoutSetting('thumbSize', 150) || 150));
let thumbSaveTimer = 0;
let thumbRedrawTimer = 0;

function applyThumbSize() {
  document.documentElement.style.setProperty('--thumb-size', `${thumbSize}px`);
}

function setThumbSize(v) {
  const next = Math.min(THUMB_MAX, Math.max(THUMB_MIN, Math.round(v / 10) * 10));
  if (next === thumbSize) return;
  thumbSize = next;
  applyThumbSize();
  // 描いてある画像はすぐ拡大縮小して見せ、落ち着いたら描き直す
  for (const t of thumbEls) {
    const c = t.firstChild?.querySelector('canvas');
    if (c) { const k = thumbSize / (+c.dataset.size || thumbSize); c.style.width = `${c.dataset.w * k}px`; c.style.height = `${c.dataset.h * k}px`; }
  }
  clearTimeout(thumbRedrawTimer);
  thumbRedrawTimer = setTimeout(redrawThumbs, 250);
  clearTimeout(thumbSaveTimer);
  thumbSaveTimer = setTimeout(() => saveLayout({ thumbSize }), 400);
}

/** 大きさを変えたあと、見えている付近のサムネイルを描き直す */
function redrawThumbs() {
  if (!thumbEls.length) return;
  thumbToken++;
  thumbQueue.clear();
  nearThumbs.clear();
  keepThumbs.clear();
  renderObserver.disconnect();
  unloadObserver.disconnect();
  for (const t of thumbEls) {
    const box = t.firstChild;
    delete box.dataset.done;
    box.dataset.stale = '1'; // 古い画像は、新しい画像ができるまで表示しておく
  }
  for (const t of thumbEls) { renderObserver.observe(t); unloadObserver.observe(t); }
}

/** 大きい画像を、半分ずつ縮めながら c に描く（一度に大きく縮めると文字がつぶれるため） */
function shrinkInto(img, c) {
  let src = img, tmp = null;
  while (src.width > c.width * 2) {
    const n = document.createElement('canvas');
    n.width = Math.max(c.width, Math.round(src.width / 2));
    n.height = Math.max(c.height, Math.round(src.height / 2));
    const x = n.getContext('2d');
    x.imageSmoothingQuality = 'high';
    x.drawImage(src, 0, 0, n.width, n.height);
    if (tmp) tmp.width = 0;
    src = tmp = n;
  }
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  if (tmp) tmp.width = 0;
}

async function renderThumb(i, token) {
  const t = thumbEls[i];
  const box = t?.firstChild;
  if (!box || box.dataset.done || !nearThumbs.has(i)) return;
  const size = thumbSize;
  const pdf = state.pdf;
  if (!pdf || i >= pdf.numPages) return;
  box.dataset.done = '1';
  const page = await pdf.getPage(i + 1).catch(() => null);
  if (!page || pdf !== state.pdf || token !== thumbToken) { delete box.dataset.done; return; }
  const vp1 = page.getViewport({ scale: 1, rotation: page.rotate });
  const scale = size / Math.max(vp1.width, vp1.height);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const vp = page.getViewport({ scale: scale * dpr, rotation: page.rotate });
  const c = el('canvas', { width: Math.round(vp.width), height: Math.round(vp.height), style: `width:${vp.width / dpr}px;height:${vp.height / dpr}px` });
  thumbRendering++;
  try {
    // 本体で描き終えた画像があれば縮小して使う（ページをもう一度展開しない。スキャン画像では大きな差）
    const img = pageImage(i);
    const scan = scanAvailable() ? scanInfo(i) : null;
    let bmp = null;
    if (!(img && img.width >= c.width) && scan) {
      // スキャン画像だけのページは、ワーカーで縮めた画像を使う
      const { tw, th } = scanTarget(scan, c.width, c.height);
      bmp = await renderScan(scan, tw, th).catch(() => null);
    }
    if (img && img.width >= c.width) shrinkInto(img, c);
    else if (bmp) { const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); drawScan(ctx, bmp, scan.rotate, c.width, c.height, scan.interpolate); bmp.close(); }
    else await page.render({ canvasContext: c.getContext('2d'), viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE }).promise;
  } catch {
    c.width = 0;
    delete box.dataset.done;
    return;
  } finally {
    thumbRendering--;
  }
  // 描いている間に遠くへスクロールされていたら捨てる（解放の通知はもう来ないため）
  if (token !== thumbToken || !box.isConnected || !keepThumbs.has(i)) { c.width = 0; delete box.dataset.done; page.cleanup(); return; }
  c.dataset.size = size;
  c.dataset.w = vp.width / dpr;
  c.dataset.h = vp.height / dpr;
  const old = box.querySelector('canvas');
  if (old) old.width = 0;
  delete box.dataset.stale;
  box.replaceChildren(c);
  // 本体で表示中でなければ、描画用キャッシュをすぐ解放する
  if (!view.pages[i]?.mounted) page.cleanup();
}

function unloadThumb(i) {
  const box = thumbEls[i]?.firstChild;
  if (!box?.dataset.done && !box?.dataset.stale) return;
  const c = box.querySelector('canvas');
  if (c) c.width = 0;
  box.replaceChildren();
  delete box.dataset.done;
  delete box.dataset.stale;
  thumbQueue.delete(i);
}

/** ページ操作の後にサムネイルを描き直す（ページ番号は変えない操作用） */
export function refreshThumb(i) {
  unloadThumb(i);
  thumbQueue.add(i);
  pumpThumbs();
}

function onThumbClick(e, i) {
  if (e.shiftKey && anchor != null) {
    selected = new Set();
    for (let k = Math.min(anchor, i); k <= Math.max(anchor, i); k++) selected.add(k);
  } else if (e.ctrlKey || e.metaKey) {
    selected.has(i) ? selected.delete(i) : selected.add(i);
    anchor = i;
  } else {
    selected = new Set([i]);
    anchor = i;
    scrollToPage(i);
  }
  paintSelection();
}

function paintSelection() {
  thumbEls.forEach((t, i) => t.classList.toggle('selected', selected.has(i)));
}

function highlightThumb(i) {
  currentThumb?.classList.remove('current');
  currentThumb = thumbEls[i] || null;
  currentThumb?.classList.add('current');
  if (selected.size <= 1 && !selected.has(i)) {
    for (const k of selected) thumbEls[k]?.classList.remove('selected');
    selected = new Set([i]);
    anchor = i;
    currentThumb?.classList.add('selected');
  }
  const box = $('#tab-pages');
  if (currentThumb && activeTab === 'pages') {
    const r = currentThumb.getBoundingClientRect(), b = box.getBoundingClientRect();
    if (r.top < b.top || r.bottom > b.bottom) currentThumb.scrollIntoView({ block: 'nearest' });
  }
}

function onThumbContext(e, i) {
  e.preventDefault();
  if (!selected.has(i)) { selected = new Set([i]); anchor = i; paintSelection(); }
  showContextMenu(e.clientX, e.clientY, [
    ['右に 90° 回転', 'rotate-right'], ['左に 90° 回転', 'rotate-left'], null,
    ['複製', 'duplicate-pages'], ['空白ページを後ろに挿入', 'insert-blank'], ['ファイルからページを挿入...', 'insert-file'], ['ページを抽出...', 'extract-pages'], null,
    ['ページを削除', 'delete-pages']
  ]);
}

export function showContextMenu(x, y, items) {
  $('#ctx-menu')?.remove();
  const m = el('div', { id: 'ctx-menu', style: `left:${x}px;top:${y}px` },
    ...items.map((it) => (it ? el('div', { class: 'ctx-item', onclick: () => { m.remove(); actions.run(it[1]); } }, it[0]) : el('div', { class: 'ctx-sep' }))));
  document.body.append(m);
  const r = m.getBoundingClientRect();
  if (r.bottom > innerHeight) m.style.top = `${innerHeight - r.height - 4}px`;
  if (r.right > innerWidth) m.style.left = `${innerWidth - r.width - 4}px`;
}

// ---------------------------------------------------------------- 注釈一覧（タブを開いたときだけ作る）

const KIND = { rect: '矩形', ellipse: '楕円', line: '直線', arrow: '矢印', ink: '手書き', highlight: 'ハイライト', underline: '下線', strike: '取り消し線', text: 'テキスト', edit: 'テキスト編集', note: '付箋', image: '画像/署名', redact: '墨消し（未適用）', link: 'リンク' };
const MEASURE_KIND = { distance: '距離の測定', perimeter: '周長の測定', area: '面積の測定' };
export const kindName = (o) => (o.type === 'measure' ? MEASURE_KIND[o.kind] : KIND[o.type]) || o.type;

let annotListDirty = true;
function markAnnotListDirty() {
  annotListDirty = true;
  if (activeTab === 'annots') renderAnnotList();
}

function renderAnnotList() {
  annotListDirty = false;
  const list = $('#annot-list');
  if (!list) return;
  const rows = [];
  state.pageIds.forEach((pid, i) => {
    for (const o of state.objects[pid] || []) {
      const desc = (o.text || o.contents || o.url || '').replace(/\n/g, ' ');
      rows.push(el('div', { class: `annot-row ${view.selected === o.id ? 'selected' : ''}`, onclick: () => { setTool('select'); select(o.id); scrollToRect(i, o.rect); } },
        el('span', { class: 'annot-page' }, `p.${i + 1}`), el('span', { class: 'annot-kind' }, kindName(o)), el('span', { class: 'annot-desc', translate: 'no' }, desc)));
    }
  });
  list.replaceChildren(...(rows.length ? rows : [el('p', { class: 'empty' }, '注釈はまだありません。')]));
}

// ---------------------------------------------------------------- 検索

let hits = [];
let hitIndex = -1;
let lastQuery = '';
let lastCase = false;
let searchToken = 0;

function resetSearch() {
  searchToken++;
  hits = [];
  hitIndex = -1;
  lastQuery = '';
  view.searchHits = [];
  $('#search-results')?.replaceChildren();
  const st = $('#search-status');
  if (st) st.textContent = '';
}

async function runSearch(q, dir = 1) {
  if (!hasDoc()) return;
  const caseSens = $('#search-case').checked;
  if (q !== lastQuery || caseSens !== lastCase || !hits.length) {
    const token = ++searchToken;
    lastQuery = q;
    lastCase = caseSens;
    hits = [];
    hitIndex = -1;
    const results = $('#search-results');
    const status = $('#search-status');
    results.replaceChildren();
    view.searchHits = [];
    if (!q) { redrawMounted(); status.textContent = ''; return; }
    const needle = caseSens ? q : q.toLowerCase();
    const n = state.pageIds.length;
    for (let i = 0; i < n; i++) {
      if (i % 20 === 0) status.textContent = `検索中… ${i + 1} / ${n} ページ`;
      const { items } = await pageText(i);
      if (token !== searchToken) return;
      const frag = document.createDocumentFragment();
      for (const it of items) {
        const hay = caseSens ? it.str : it.str.toLowerCase();
        let from = 0, pos;
        while ((pos = hay.indexOf(needle, from)) >= 0) {
          const hit = { page: i, rect: subRange(it, pos, needle.length), snippet: it.str.slice(Math.max(0, pos - 15), pos + needle.length + 25) };
          hits.push(hit);
          const k = hits.length - 1;
          frag.append(el('div', { class: 'result', translate: 'no', onclick: () => gotoHit(k) }, el('b', {}, `p.${i + 1}`), ' ', hit.snippet));
          from = pos + needle.length;
        }
      }
      results.append(frag);
    }
    status.textContent = `${hits.length} 件見つかりました`;
    view.searchHits = hits;
    redrawMounted();
  }
  if (hits.length) gotoHit((hitIndex + dir + hits.length) % hits.length);
}

function redrawMounted() {
  view.pages.forEach((p, i) => p.mounted && drawOverlay(i));
}

function gotoHit(k) {
  const prev = hits[hitIndex];
  if (prev) prev.current = false;
  hitIndex = k;
  const h = hits[k];
  h.current = true;
  const rows = $('#search-results').children;
  rows[k]?.classList.add('current');
  if (prev && prev !== h) rows[hits.indexOf(prev)]?.classList.remove('current');
  rows[k]?.scrollIntoView({ block: 'nearest' });
  if (prev && view.pages[prev.page]?.mounted) drawOverlay(prev.page);
  if (view.pages[h.page]?.mounted) drawOverlay(h.page);
  scrollToRect(h.page, h.rect);
}

function markAllForRedaction() {
  if (!can('modify')) return toast('この文書は作成者により編集が制限されています');
  if (!hits.length) return toast('先に検索してください');
  addObjects(hits.map((h) => [h.page, { type: 'redact', rect: [h.rect[0] - 1, h.rect[1] - 1, h.rect[2] + 2, h.rect[3] + 2] }]));
  toast(`${hits.length} 件に墨消しマークを付けました。「文書 > 墨消しを適用」で確定します。`, 4000);
}

// ---------------------------------------------------------------- しおり（閲覧）

async function renderOutline() {
  const box = $('#outline');
  const pdf = state.pdf;
  const outline = await pdf.getOutline().catch(() => null);
  if (pdf !== state.pdf) return;
  if (!outline?.length) { box.replaceChildren(el('p', { class: 'empty' }, 'この文書にはしおりがありません。')); return; }
  const rows = [];
  const build = (items, depth) => items.forEach((it) => {
    rows.push(el('div', { class: 'outline-item', translate: 'no', style: `padding-left:${8 + depth * 14}px`, title: it.title, onclick: async () => {
      if (it.url) return window.api.openExternal(it.url);
      const dest = typeof it.dest === 'string' ? await state.pdf.getDestination(it.dest) : it.dest;
      if (dest?.[0]) scrollToPage(await state.pdf.getPageIndex(dest[0]));
    } }, it.title));
    if (it.items?.length) build(it.items, depth + 1);
  });
  build(outline, 0);
  box.replaceChildren(...rows);
}

// ---------------------------------------------------------------- 書式バー

/** 書式バー（ツールバーの下）：今のツール・選択中の注釈の書式と操作 */
export function initInspector() {
  const s = view.settings;
  // kinds: その項目を出す場面（line / fill / hl / text / opacity は書式、sel / rot / meas は選択中の注釈の操作）
  const item = (kinds, label, ...c) => el('label', { class: 'fb-item', 'data-kinds': kinds }, el('span', { class: 'fb-label' }, label), ...c);
  const fsep = (kinds) => el('div', { class: 'sep fb-sep', 'data-kinds': kinds });
  const color = el('input', { type: 'color', value: s.color });
  const fill = el('input', { type: 'color', value: s.fill || '#ffffff' });
  const noFill = el('input', { type: 'checkbox', checked: !s.fill });
  const hl = el('input', { type: 'color', value: s.highlight });
  const width = el('input', { type: 'range', min: 0.5, max: 20, step: 0.5, value: s.width });
  const widthVal = el('span', { class: 'val' }, String(s.width));
  const opacity = el('input', { type: 'range', min: 0.1, max: 1, step: 0.05, value: s.opacity });
  const fontSize = el('input', { type: 'number', min: 4, max: 200, value: s.fontSize, style: 'width:64px' });
  const fontColor = el('input', { type: 'color', value: s.fontColor });
  const bold = el('input', { type: 'checkbox' });
  const angle = el('input', { type: 'number', min: -360, max: 360, step: 1, style: 'width:60px', title: '時計回りの角度' });
  const measure = el('span', { class: 'fb-measure', id: 'fb-measure' });
  const group = (kinds, ...c) => el('div', { class: 'fb-item', 'data-kinds': kinds }, ...c);

  overflowBar($('#formatbar'), { menuClass: 'ovf-format' });
  // 選択中の注釈の操作は、狭い幅で「»」に隠れにくいよう書式より前に置く
  $('#formatbar').prepend(
    el('div', { class: 'fb-title', id: 'fb-title' }),
    el('span', { class: 'fb-restricted', title: 'この文書は作成者により編集が制限されています。許可されていない操作は使えません。' }, '編集制限あり'),
    group('meas', measure),
    group('rot', el('span', { class: 'fb-label' }, '回転'),
      el('button', { class: 'small fb-rot', title: '左に 90° 回転', onclick: () => can('annotate') && rotateSelected(-90) }, icon('rotate-ccw'), '90°'),
      el('button', { class: 'small fb-rot', title: '右に 90° 回転', onclick: () => can('annotate') && rotateSelected(90) }, icon('rotate-cw'), '90°'),
      angle, ' °'),
    group('sel',
      el('button', { class: 'small', title: '内容・コメントを編集（ダブルクリックでも可）', onclick: () => view.selected && can('annotate') && editObjectContents(view.selected) }, '編集...'),
      el('button', { class: 'small', onclick: () => { if (view.selected && can('annotate')) removeObject(view.selected); } }, '削除')),
    fsep('sel'),
    item('line', '線の色', color), item('line', '線の太さ', width, widthVal), fsep('fill'),
    item('fill', '塗り', fill, el('label', { class: 'check' }, noFill, ' なし')), fsep('hl'),
    item('hl', 'ハイライト', hl), fsep('text'),
    item('text', '文字サイズ', fontSize, ' pt'), item('text', '文字色', fontColor), item('text', '太字', bold), fsep('opacity'),
    item('opacity', '不透明度', opacity)
  );

  const apply = (fn) => { const sel = selectedObject(); if (sel && can('annotate')) updateObject(sel.obj.id, fn); };
  color.addEventListener('input', () => { s.color = color.value; });
  color.addEventListener('change', () => apply((o) => { if (!['text', 'edit', 'image', 'redact'].includes(o.type)) o.color = s.color; }));
  const fillChange = () => { s.fill = noFill.checked ? '' : fill.value; apply((o) => { if (['rect', 'ellipse', 'text'].includes(o.type) || (o.type === 'measure' && o.kind === 'area')) o.fill = s.fill || null; }); };
  fill.addEventListener('change', () => { noFill.checked = false; fillChange(); });
  noFill.addEventListener('change', fillChange);
  hl.addEventListener('change', () => { s.highlight = hl.value; apply((o) => { if (o.type === 'highlight') o.color = s.highlight; }); });
  width.addEventListener('input', () => { s.width = +width.value; widthVal.textContent = width.value; });
  width.addEventListener('change', () => apply((o) => { if (['rect', 'ellipse', 'line', 'arrow', 'ink'].includes(o.type)) o.width = s.width; else if (o.type === 'measure') o.width = Math.min(s.width, 3); }));
  opacity.addEventListener('change', () => { s.opacity = +opacity.value; apply((o) => { o.opacity = s.opacity; }); });
  fontSize.addEventListener('change', () => {
    s.fontSize = Math.min(200, Math.max(4, +fontSize.value || 14));
    apply((o) => { if (o.type === 'text' || o.type === 'edit') { o.fontSize = s.fontSize; fitText(o); } });
  });
  fontColor.addEventListener('change', () => { s.fontColor = fontColor.value; apply((o) => { if (o.type === 'text' || o.type === 'edit') o.fontColor = s.fontColor; }); });
  bold.addEventListener('change', () => { s.bold = bold.checked; apply((o) => { if (o.type === 'text' || o.type === 'edit') { o.bold = s.bold; fitText(o); } }); });
  angle.addEventListener('change', () => {
    if (!can('annotate')) return;
    const v = Number(angle.value) || 0;
    if (selectedDisplayAngle() != null) setSelectedDisplayAngle(((v % 360) + 360) % 360);
    else rotateSelected(v);
    angle.value = selectedDisplayAngle() ?? '';
  });

  const refresh = () => {
    const t = TOOLS[view.tool];
    const sel = selectedObject();
    // 書式バー：選択中の注釈（なければ今のツール）で使う項目だけを出す
    const kinds = formatKinds(sel ? sel.obj : null, view.tool);
    if (sel) {
      kinds.add('sel');
      if (canRotate(sel.obj)) kinds.add('rot');
      if (sel.obj.type === 'measure') kinds.add('meas');
    }
    const title = $('#fb-title');
    title.textContent = sel ? `${kindName(sel.obj)}（${sel.page + 1} ページ）` : t.label;
    title.title = sel ? '' : t.hint;
    for (const n of $('#formatbar').querySelectorAll('[data-kinds]')) n.style.display = kinds.has(n.dataset.kinds) ? '' : 'none';
    $('#formatbar').classList.toggle('empty', !kinds.size);
    if (sel) {
      const o = sel.obj;
      if (o.type === 'measure') {
        const v = measureValue(o);
        const sc = o.scale || {};
        // 文ごとに分けておく（英語表示で 1 つずつ訳すため）
        const parts = [el('b', {}, `${v.label}: ${v.text}`)];
        if (v.perimeter != null) parts.push(el('span', {}, `周長: ${v.perimeter.toLocaleString('ja-JP', { maximumFractionDigits: sc.decimals ?? 1, minimumFractionDigits: sc.decimals ?? 1 })} ${sc.unit}`));
        if (o.kind !== 'distance') parts.push(el('span', {}, `頂点: ${o.points.length}`));
        parts.push(el('span', { class: 'muted', title: '頂点をドラッグで調整' }, `縮尺 ${sc.label || '1:1'}`));
        measure.replaceChildren(...parts);
      }
      const da = selectedDisplayAngle();
      angle.value = da ?? '';
      angle.placeholder = da == null ? '角度' : '';
      if (o.fontSize) fontSize.value = o.fontSize;
      if (o.color && /^#/.test(o.color)) (o.type === 'highlight' ? hl : color).value = o.color;
      if (o.fontColor) fontColor.value = o.fontColor;
      bold.checked = !!o.bold;
    }
    relayoutBars();
  };
  bus.addEventListener('tool-changed', refresh);
  bus.addEventListener('selection-changed', refresh);
  refresh();
}

/** 書式バーに出す項目 */
const KINDS_BY_TYPE = {
  ink: 'line opacity', rect: 'line fill opacity', ellipse: 'line fill opacity', line: 'line opacity', arrow: 'line opacity',
  underline: 'line opacity', strike: 'line opacity', highlight: 'hl', text: 'text fill opacity', edit: 'text', image: 'opacity',
  measure: 'line opacity', area: 'line fill opacity', note: 'line'
};
const KINDS_BY_TOOL = {
  ink: 'ink', rect: 'rect', ellipse: 'ellipse', line: 'line', arrow: 'arrow', underline: 'underline', strike: 'strike', highlight: 'highlight',
  text: 'text', edit: 'edit', image: 'image', stamp: 'image', signature: 'image', note: 'note',
  measureDist: 'measure', measurePerim: 'measure', measureArea: 'area'
};
function formatKinds(obj, tool) {
  const key = obj ? (obj.type === 'measure' && obj.kind === 'area' ? 'area' : obj.type) : KINDS_BY_TOOL[tool];
  if (!obj && tool === 'select') return new Set(['line', 'fill', 'text', 'opacity']);
  return new Set((KINDS_BY_TYPE[key] || '').split(' ').filter(Boolean));
}

/** 文字量・サイズに合わせてテキストボックスの大きさを調整 */
function fitText(o) {
  const top = o.rect[1] + o.rect[3];
  if (o.type === 'edit') {
    // 書き換えた文字が収まる幅にし、高さは元の行に合わせて上端を保つ
    o.rect[2] = Math.max(o.rect[2], measureWidth(o.text || '', o.fontSize, o.bold) + 4);
    o.rect[3] = Math.max(o.rect[3], o.fontSize * 1.18);
  } else {
    o.rect[3] = Math.max(o.rect[3], textBoxHeight(o));
  }
  o.rect[1] = top - o.rect[3];
}
