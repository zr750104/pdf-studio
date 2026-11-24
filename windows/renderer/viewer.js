// ページ表示（pdf.js）と注釈オブジェクトの描画・マウス操作
// 表示中のページ付近だけを描画し、離れたページの画像は解放する（大きな PDF でも軽く動くように）
import {
  state, bus, emit, setDirty, pdfjsLib, newId, pageText, TEXT_ASCENT, LINE_HEIGHT, can,
  findObject, objectsOf, addObject as storeAdd, removeObject as storeRemove, updateObject as storeUpdate, beginGesture, endGesture,
  objBounds, THAI, ANGLE_TYPES, rotateObjectBy, cloneObject, measureValue, measureLabel, MEASURE_LABEL_SIZE, DEFAULT_SCALE
} from './doc.js';
import { $, el, promptText, ask, toast, confirmBox } from './util.js';
import { chooseStamp, chooseSignature } from './stamps.js';
import { scanInfo, scanAvailable, renderScan, drawScan, scanTarget, warmScan } from './scanpages.js';

export { findObject };

const SVGNS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}) => {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
  return e;
};

export const TOOLS = {
  select: { label: '選択', icon: 'mouse-pointer-2', key: 'v', hint: '注釈をクリックで選択・ドラッグで移動、四隅でサイズ変更。ダブルクリックで内容を編集。文字のドラッグでテキスト選択。' },
  hand: { label: '手のひら', icon: 'hand', key: 'h', hint: 'ドラッグで表示をスクロールします。' },
  highlight: { label: 'ハイライト', icon: 'highlighter', key: 'u', hint: '文字をドラッグして選択するとハイライトされます。', perm: 'annotate' },
  underline: { label: '下線', icon: 'underline', hint: '文字をドラッグして選択すると下線が引かれます。', perm: 'annotate' },
  strike: { label: '取り消し線', icon: 'strikethrough', hint: '文字をドラッグして選択すると取り消し線が引かれます。', perm: 'annotate' },
  note: { label: '付箋', icon: 'sticky-note', key: 'n', hint: 'クリックした位置に付箋（コメント）を貼ります。', perm: 'annotate' },
  text: { label: 'テキスト', icon: 'type', key: 't', hint: 'クリックまたはドラッグで範囲を決めて文字を入力します。', perm: 'annotate' },
  edit: { label: 'テキスト編集', icon: 'text-cursor-input', key: 'e', hint: '書き換えたい文字列をクリックします。元の文字を白で覆い、新しい文字を同じ位置に配置します。', perm: 'modify' },
  ink: { label: '手書き', icon: 'pencil', key: 'p', hint: 'ドラッグで自由に描きます（続けて描いた線は 1 つにまとまります）。', perm: 'annotate' },
  rect: { label: '矩形', icon: 'square', key: 'r', hint: 'ドラッグで矩形を描きます（Shift で正方形）。', perm: 'annotate' },
  ellipse: { label: '楕円', icon: 'circle', key: 'o', hint: 'ドラッグで楕円を描きます（Shift で正円）。', perm: 'annotate' },
  line: { label: '直線', icon: 'minus', key: 'l', hint: 'ドラッグで直線を引きます（Shift で 45° 単位）。', perm: 'annotate' },
  arrow: { label: '矢印', icon: 'move-up-right', key: 'a', hint: 'ドラッグで矢印を引きます（Shift で 45° 単位）。', perm: 'annotate' },
  image: { label: '画像', icon: 'image', hint: 'クリックした位置に画像を配置します。', perm: 'annotate' },
  signature: { label: '署名', icon: 'pen-tool', key: 's', hint: 'クリックした位置に署名を配置します（新規作成もできます）。', perm: 'annotate' },
  stamp: { label: 'スタンプ', icon: 'stamp', hint: 'クリックした位置にスタンプ・印鑑を押します。', perm: 'annotate' },
  redact: { label: '墨消し', icon: 'rectangle-horizontal', hint: '隠したい範囲をドラッグしてマークし、「文書 > 墨消しを適用」で確定します。', perm: 'modify' },
  crop: { label: 'トリミング', icon: 'crop', hint: '残したい範囲をドラッグします。', perm: 'modify' },
  link: { label: 'リンク', icon: 'link', hint: 'リンクにしたい範囲をドラッグし、URL またはページ番号を指定します。', perm: 'annotate' },
  formText: { label: 'テキスト欄', icon: 'text-cursor', hint: 'フォームの入力欄にしたい範囲をドラッグします。', perm: 'modify' },
  formCheck: { label: 'チェック', icon: 'square-check-big', hint: 'クリックまたはドラッグでチェックボックスを置きます。', perm: 'modify' },
  formChoice: { label: 'ドロップダウン', icon: 'list', hint: 'ドロップダウンにしたい範囲をドラッグします。', perm: 'modify' },
  measureDist: { label: '距離の測定', icon: 'ruler', key: 'm', hint: '2 点間をドラッグして距離を測ります（Shift で 45° 単位）。縮尺は「文書 > 測定の縮尺」で設定します。', perm: 'annotate' },
  measurePerim: { label: '周長の測定', icon: 'spline', hint: 'クリックで頂点を追加し、ダブルクリックか Enter で確定します（Backspace で 1 つ戻る、Esc で中止）。', perm: 'annotate' },
  measureArea: { label: '面積の測定', icon: 'pentagon', hint: 'クリックで頂点を追加し、ダブルクリックか Enter で囲んで面積を測ります（Backspace で 1 つ戻る、Esc で中止）。', perm: 'annotate' },
  eraser: { label: '消しゴム', icon: 'eraser', hint: 'クリックした注釈を削除します。', perm: 'annotate' }
};
export const TOOL_GROUPS = [['select', 'hand'], ['highlight', 'underline', 'strike', 'note', 'text', 'edit'], ['ink', 'rect', 'ellipse', 'line', 'arrow'],
  ['image', 'signature', 'stamp'], ['measureDist', 'measurePerim', 'measureArea'], ['redact', 'crop', 'link'], ['formText', 'formCheck', 'formChoice'], ['eraser']];
const DRAG_TOOLS = new Set(['text', 'ink', 'rect', 'ellipse', 'line', 'arrow', 'measureDist', 'redact', 'crop', 'link', 'formText', 'formCheck', 'formChoice']);
const POLY_TOOLS = new Set(['measurePerim', 'measureArea']);
const MARKUP = new Set(['highlight', 'underline', 'strike']);

/** キャンバス 1 枚あたりの最大画素数（これを超える倍率では解像度を落として描く） */
const MAX_CANVAS_PIXELS = 16 * 1024 * 1024;
/** 見えている部分を細かく描くときの、ページ全体の画像の画素数（スクロールしたとき一瞬見える下地） */
const DETAIL_BASE_PIXELS = 4 * 1024 * 1024;
/** 同時に描画するページ数 */
const MAX_ACTIVE_RENDERS = 2;

/** 既定のツール（起動時・Esc で戻る先）。ドラッグで画面を動かす手のひら */
export const DEFAULT_TOOL = 'hand';

export const view = {
  scale: 1.25,
  fit: 'width',
  layout: 'single',
  tool: 'hand',  // 起動時のツール（DEFAULT_TOOL）
  selected: null,
  pages: [],
  searchHits: [],
  settings: { color: '#e03131', fill: '', width: 2, opacity: 1, fontSize: 14, fontColor: '#000000', highlight: '#ffd43b', bold: false }
};

let viewerEl, pagesEl;
let buildToken = 0;
let lastCurrent = -1;

export function initViewer() {
  document.body.dataset.tool = view.tool; // 起動直後から既定のツールの見え方・動きにする
  viewerEl = $('#viewer');
  pagesEl = $('#pages');
  viewerEl.addEventListener('scroll', scheduleUpdate, { passive: true });
  viewerEl.addEventListener('scroll', scheduleDetail, { passive: true });
  viewerEl.addEventListener('scroll', onScrollMeasure, { passive: true });
  viewerEl.addEventListener('wheel', onWheel, { passive: false });
  // 慣性で滑っている途中は、ホイール・クリック・キー操作で止める
  viewerEl.addEventListener('wheel', stopMomentum, { passive: true });
  // どこを押しても止める（サムネイル・ツールバーも）。ページの上で止めたときは、そのクリックでリンクを開かない
  document.addEventListener('pointerdown', (e) => { if (momentum && viewerEl.contains(e.target)) stoppedByPress = performance.now(); stopMomentum(); }, true);
  window.addEventListener('keydown', stopMomentum, true);
  document.addEventListener('mouseup', onMarkupMouseUp);
  // 選択ツールで空いている所をクリックしたら選択解除
  pagesEl.addEventListener('pointerdown', (e) => {
    if (view.tool === 'select' && view.selected && !e.target.closest?.('.obj, .handle')) select(null);
  });
  bus.addEventListener('objects-changed', (e) => {
    const pages = e.detail?.pages;
    for (const i of pages || view.pages.keys()) if (view.pages[i]?.mounted) drawOverlay(i);
  });
  // ウィンドウやパネルの幅が変わったら、幅・全体に合わせる表示を合わせ直す
  let resizeTimer = 0;
  let lastSize = '';
  // スクロールバーが出入りしただけ（外枠の大きさが同じ）のときは合わせ直さない（操作中に倍率が変わらないように）
  new ResizeObserver(() => {
    const size = `${viewerEl.offsetWidth}x${viewerEl.offsetHeight}`;
    if (size === lastSize) return;
    lastSize = size;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (view.fit && view.pages.length) zoomTo(view.scale, view.fit); else scheduleUpdate(); }, 120);
  }).observe(viewerEl, { box: 'border-box' });
}

// ---------------------------------------------------------------- ページ構築

const dims = (page) => {
  const vp = page.getViewport({ scale: 1, rotation: page.rotate });
  return { w: vp.width, h: vp.height };
};

export async function buildPages(keepPage = null) {
  stopMomentum();
  const token = ++buildToken;
  const target = keepPage ?? currentPage();
  for (const p of view.pages) unmountPage(p, true);
  cacheClear();
  perf = { renders: [], pixels: 0, maxGap: 0, logged: 0 };
  queue.clear();
  pagesEl.replaceChildren();
  view.pages = [];
  lastCurrent = -1;
  pagesEl.classList.toggle('two', view.layout === 'two');
  pagesEl.classList.toggle('wrap', view.layout !== 'two');
  const pdf = state.pdf;
  const n = pdf.numPages;
  const first = await pdf.getPage(1);
  if (token !== buildToken) return;
  // ページの大きさが分かるまでは 1 ページ目と同じ大きさで仮置きする
  const base1 = dims(first);
  const frag = document.createDocumentFragment();
  for (let i = 0; i < n; i++) {
    const div = document.createElement('div');
    div.className = 'page';
    div.dataset.index = i;
    div.addEventListener('pointerdown', onPagePointerDown);
    frag.append(div);
    view.pages.push({ div, base: base1, pdfPage: null, vp1: null, mounted: false, gen: 0 });
  }
  pagesEl.append(frag);
  setPageProxy(0, first);
  if (view.fit) computeFitScale();
  applySizes();
  if (target != null) scrollToPage(Math.min(target, n - 1), false);
  scheduleUpdate();
  emit('zoom-changed', view.scale);
  loadAllPages(token, pdf);
}

function setPageProxy(i, page) {
  const p = view.pages[i];
  p.pdfPage = page;
  p.vp1 = page.getViewport({ scale: 1, rotation: page.rotate });
  const d = { w: p.vp1.width, h: p.vp1.height };
  const changed = d.w !== p.base.w || d.h !== p.base.h;
  p.base = d;
  return changed;
}

/** 残りのページ情報を少しずつ読み込み、大きさが違うページがあれば直す */
async function loadAllPages(token, pdf) {
  const n = pdf.numPages;
  for (let s = 1; s < n; s += 64) {
    const idx = [];
    for (let i = s; i < Math.min(n, s + 64); i++) idx.push(i);
    const pages = await Promise.all(idx.map((i) => pdf.getPage(i + 1)));
    if (token !== buildToken) return;
    let changed = false;
    pages.forEach((page, k) => { if (setPageProxy(idx[k], page)) changed = true; });
    if (changed) {
      const anchor = captureAnchor();
      applySizes();
      restoreAnchor(anchor);
      scheduleUpdate();
    }
  }
  emit('pages-loaded');
}

async function ensurePage(i) {
  const p = view.pages[i];
  if (!p) return null;
  if (!p.pdfPage) {
    const pdf = state.pdf;
    const page = await pdf.getPage(i + 1);
    if (pdf !== state.pdf || view.pages[i] !== p) return null;
    if (setPageProxy(i, page)) { const a = captureAnchor(); applySizes(); restoreAnchor(a); scheduleUpdate(); }
  }
  return p.pdfPage;
}

function applySizes() {
  // ページが増えた・表示の並べ方が変わった・実際のページの大きさが分かったときも、倍率を表示できる範囲に収める
  const c = clampScale(view.scale);
  if (c !== view.scale) {
    view.scale = c;
    for (const [k, e] of [...canvasCache]) if (e.scale !== c) cacheDrop(k);
    // 選択枠のハンドルなど倍率に依存する部分も描き直す
    queueMicrotask(() => { for (const [i, p] of view.pages.entries()) if (p.mounted) drawOverlay(i); });
    clearTimeout(rerenderTimer);
    rerenderTimer = setTimeout(() => {
      runDetail();
      for (const [i, p] of view.pages.entries()) if (p.mounted && p.canvasScale !== view.scale) enqueue(i);
    }, 180);
    queueMicrotask(() => emit('zoom-changed', view.scale));
  }
  const s = view.scale;
  pagesEl.style.setProperty('--scale-factor', s);
  let maxW = 0;
  for (const p of view.pages) {
    const pw = Math.round(p.base.w * s);
    maxW = Math.max(maxW, pw);
    const w = `${pw}px`, h = `${Math.round(p.base.h * s)}px`;
    if (p.div.style.width !== w) p.div.style.width = w;
    if (p.div.style.height !== h) p.div.style.height = h;
  }
  // 横に並べる表示では、一番広いページが入る幅を最小にする（拡大したときは横にスクロールできるように）
  const minW = view.layout === 'two' ? '' : `${maxW + 48}px`;
  if (pagesEl.style.minWidth !== minW) pagesEl.style.minWidth = minW;
}

// 表示倍率の範囲（8.33%〜6400%。PDF-XChange Editor と同じ）
export const MIN_SCALE = 1 / 12;
export const MAX_SCALE = 64;
// 画面の部品の高さには上限（Chromium で約 3,355 万ピクセル）があり、超えると下のページが表示できない。
// ページ数が多い・大きな図面のときは、全ページを並べた高さがこれを超えない倍率までにする
const MAX_LAYOUT_PX = 30_000_000;

/** 倍率を表示できる範囲に収める */
export function clampScale(s) {
  let total = 0;
  if (view.layout === 'two') {
    // 2 ページずつ並べる。行の高さは高い方のページ。組み方がずれても大丈夫なよう、2 通りの組み方の大きい方で見積もる
    const h = view.pages.map((p) => p.base.h + 16);
    let a = 0, b = h[0] || 0;
    for (let i = 0; i < h.length; i += 2) a += Math.max(h[i], h[i + 1] || 0);
    for (let i = 1; i < h.length; i += 2) b += Math.max(h[i], h[i + 1] || 0);
    total = Math.max(a, b);
  } else for (const p of view.pages) total += p.base.h + 16;
  const max = total > 0 ? Math.min(MAX_SCALE, MAX_LAYOUT_PX / total) : MAX_SCALE;
  return Math.max(Math.min(MIN_SCALE, max), Math.min(max, s));
}

function computeFitScale() {
  const b = view.pages[0]?.base;
  if (!b) return;
  const availW = viewerEl.clientWidth - 52;
  const availH = viewerEl.clientHeight - 32;
  const cols = view.layout === 'two' ? 2 : 1;
  const sw = (availW - (cols - 1) * 16) / (b.w * cols);
  view.scale = clampScale(view.fit === 'page' ? Math.min(sw, availH / b.h) : sw);
}

function captureAnchor() {
  const i = currentPage();
  const d = view.pages[i]?.div;
  if (!d) return null;
  return {
    i,
    y: (viewerEl.scrollTop - d.offsetTop) / Math.max(1, d.offsetHeight),
    x: (viewerEl.scrollLeft + viewerEl.clientWidth / 2) / Math.max(1, viewerEl.scrollWidth)
  };
}

function restoreAnchor(a) {
  if (!a) return;
  const d = view.pages[a.i]?.div;
  if (!d) return;
  viewerEl.scrollTop = d.offsetTop + a.y * d.offsetHeight;
  viewerEl.scrollLeft = a.x * viewerEl.scrollWidth - viewerEl.clientWidth / 2;
}

// ---------------------------------------------------------------- ズーム

let rerenderTimer = 0;

export function zoomTo(scale, fit = null) {
  stopMomentum();
  if (!view.pages.length) return;
  const anchor = captureAnchor();
  view.fit = fit;
  if (fit) computeFitScale();
  else view.scale = clampScale(scale);
  // 倍率が変わったら、ほかの倍率で描いたキャッシュは使えないので捨てる
  for (const [k, e] of [...canvasCache]) if (e.scale !== view.scale) cacheDrop(k);
  applySizes();
  restoreAnchor(anchor);
  // 選択枠のハンドルなど倍率に依存する部分だけ描き直す。画像は拡大縮小して見せておき、少し待ってから描き直す
  for (const [i, p] of view.pages.entries()) if (p.mounted) drawOverlay(i);
  clearTimeout(rerenderTimer);
  rerenderTimer = setTimeout(() => {
    // 大きなページは、見えている部分の細かい画像を先に作る（ページ全体の画像より先に鮮明になる）
    runDetail();
    for (const [i, p] of view.pages.entries()) if (p.mounted && p.canvasScale !== view.scale) enqueue(i);
  }, 180);
  scheduleUpdate();
  emit('zoom-changed', view.scale);
}

let wheelFactor = 1;
let wheelFrame = 0;
function onWheel(e) {
  if (!e.ctrlKey) return;
  e.preventDefault();
  wheelFactor *= Math.exp(-e.deltaY * 0.0025);
  if (!wheelFrame) {
    wheelFrame = requestAnimationFrame(() => {
      wheelFrame = 0;
      const f = wheelFactor;
      wheelFactor = 1;
      zoomTo(view.scale * f);
    });
  }
}

export function setLayout(l) {
  view.layout = l;
  buildPages();
}

// ---------------------------------------------------------------- 表示範囲の計算

/** y 以降に下端があるページの最初のインデックス */
function firstPageBelow(y) {
  let lo = 0, hi = view.pages.length - 1, ans = view.pages.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const d = view.pages[mid].div;
    if (d.offsetTop + d.offsetHeight >= y) { ans = mid; hi = mid - 1; } else lo = mid + 1;
  }
  return ans;
}

/** 上端が y 以前にある最後のページ */
function lastPageAbove(y) {
  let lo = 0, hi = view.pages.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (view.pages[mid].div.offsetTop <= y) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/** ページを指定して移動したときのページ（横に並んでいるとき、その行の中ではこれを「現在のページ」にする） */
let pinnedPage = -1;

/** i を含む行の先頭のページ */
function rowHead(i) {
  const top = view.pages[i].div.offsetTop;
  while (i > 0 && view.pages[i - 1].div.offsetTop === top) i--;
  return i;
}

export function currentPage() {
  if (!view.pages.length) return 0;
  const i = rowHead(lastPageAbove(viewerEl.scrollTop + viewerEl.clientHeight * 0.35));
  // 横に並んでいるときは、行の先頭。ただし同じ行のページを指定して移動したときはそのページ
  const pin = view.pages[pinnedPage];
  if (pin && pinnedPage !== i && pin.div.offsetTop === view.pages[i].div.offsetTop) return pinnedPage;
  return i;
}

/** 次・前の行の先頭へ（1 列のときは次・前のページ） */
export function stepPage(dir) {
  if (!view.pages.length) return;
  const n = view.pages.length;
  const head = rowHead(currentPage());
  const top = view.pages[head].div.offsetTop;
  if (dir > 0) {
    let i = head;
    while (i < n - 1 && view.pages[i].div.offsetTop <= top) i++;
    if (view.pages[i].div.offsetTop > top) scrollToPage(i);
  } else if (head > 0) scrollToPage(rowHead(head - 1));
}

let updateFrame = 0;
let lastScrollTop = 0;

/**
 * 実機での重さを確かめるための記録（文書ごとに、描画 10 回目と 60 回目に updater.log へ 1 行。ファイル名は書かない）。
 * 描画時間の平均・最大、1 ページの画素数、画面の倍率、コア数、スクロール中の画面更新の最大の間隔
 */
let perf = { renders: [], pixels: 0, maxGap: 0, logged: 0 };
/** スクロール中だけ毎フレームの間隔を測る（止まってから 300ms で終える）。長いほど引っかかって見える */
let scrollMeasure = { until: 0, last: 0, running: false };
function onScrollMeasure() {
  const now = performance.now();
  scrollMeasure.until = now + 300;
  if (scrollMeasure.running) return;
  scrollMeasure.running = true;
  scrollMeasure.last = now;
  const tick = (t) => {
    perf.maxGap = Math.max(perf.maxGap, t - scrollMeasure.last);
    scrollMeasure.last = t;
    if (t < scrollMeasure.until) requestAnimationFrame(tick);
    else scrollMeasure.running = false;
  };
  requestAnimationFrame(tick);
}
// 手元と比べるための物差し：決まった計算の時間（開発機 M4 で約 15ms）。起動後、手が空いたときに 1 回だけ測る
let cpuBench = -1;
setTimeout(() => (window.requestIdleCallback || setTimeout)(() => {
  const tb = performance.now();
  let acc = 0;
  for (let k = 0; k < 5e6; k++) acc = (acc + k * 31) % 1000003;
  cpuBench = Math.round(performance.now() - tb) + (acc < 0 ? 1 : 0);
}), 3000);

function notePerf(ms, pixels, kind = 'pdfjs') {
  perf.renders.push(ms);
  perf[kind] = (perf[kind] || 0) + 1;
  perf.pixels = Math.max(perf.pixels, pixels);
  const n = perf.renders.length;
  if ((n === 10 || n === 60) && perf.logged < n) {
    perf.logged = n;
    const avg = Math.round(perf.renders.reduce((a, b) => a + b, 0) / n);
    window.api?.logInfo?.(`render: ${n} pages avg=${avg}ms max=${Math.round(Math.max(...perf.renders))}ms canvasMP=${(perf.pixels / 1e6).toFixed(1)} scan=${perf.scan || 0} pdfjs=${perf.pdfjs || 0} dpr=${window.devicePixelRatio} cores=${navigator.hardwareConcurrency} bench=${cpuBench}ms pages=${view.pages.length} scrollMaxFrame=${Math.round(perf.maxGap)}ms`);
  }
}
function scheduleUpdate() {
  if (!updateFrame) updateFrame = requestAnimationFrame(updateVisible);
}

function updateVisible() {
  updateFrame = 0;
  if (!view.pages.length) return;
  const top = viewerEl.scrollTop, h = viewerEl.clientHeight, bottom = top + h;
  // 描画する範囲：表示中 + 進んでいる向きに 1.5 画面、反対側に半画面
  const down = top >= lastScrollTop;
  lastScrollTop = top;
  const r0 = firstPageBelow(top - h * (down ? 0.5 : 1.5)), r1 = lastPageAbove(bottom + h * (down ? 1.5 : 0.5));
  // 保持する範囲：これより外のページは画像を解放
  const k0 = firstPageBelow(top - h * 2), k1 = lastPageAbove(bottom + h * 2);
  for (const [i, p] of view.pages.entries()) {
    if (p.mounted && (i < k0 || i > k1)) unmountPage(p);
  }
  for (let i = r0; i <= r1; i++) mountPage(i);
  snapPages();
  // スキャン画像のページは、進んでいる向きの先 8 ページを先に展開しておく
  if (scanAvailable()) {
    const ahead = [];
    for (let k = 1; k <= 8; k++) {
      const i = down ? r1 + k : r0 - k;
      if (i >= 0 && i < view.pages.length) ahead.push(scanInfo(i));
    }
    warmScan(ahead);
  }
  const cur = currentPage();
  if (cur !== lastCurrent) {
    lastCurrent = cur;
    emit('page-changed', cur);
  }
}

/**
 * ページの左端を画面の画素の境目にそろえる。中央寄せで半端（0.5 画素）な位置になると、
 * ページの絵が画面に出るときにぼかされて、文字がにじむ。上下はページの高さとすき間が整数なので、そろえるのは左右だけ
 */
function snapPages() {
  const dpr = window.devicePixelRatio || 1;
  // 先に全部の位置を読み、あとでまとめて書く（読み書きを交互にすると、そのたびに配置の計算が走る）
  const moves = [];
  for (const p of view.pages) {
    if (!p.mounted) continue;
    const now = p.snapX || 0;
    // ずらす前の位置から、いちばん近い画素の境目までの差を求める（ずれが積み重ならないように）
    const natural = p.div.getBoundingClientRect().left - now;
    const want = Math.round(natural * dpr) / dpr - natural;
    if (Math.abs(want - now) >= 0.01) moves.push([p, want]);
  }
  for (const [p, want] of moves) {
    p.snapX = want;
    p.div.style.left = Math.abs(want) < 0.01 ? '' : `${want}px`;
  }
}

export function scrollToPage(i, smooth = true) {
  stopMomentum();
  const p = view.pages[i];
  if (!p) return;
  pinnedPage = i;
  // 横方向はそのページが中央に来るように
  const left = Math.max(0, p.div.offsetLeft + p.div.offsetWidth / 2 - viewerEl.clientWidth / 2);
  viewerEl.scrollTo({ top: p.div.offsetTop - 12, left, behavior: smooth ? 'smooth' : 'auto' });
  scheduleUpdate();
}

/** PDF 座標の矩形が見えるようにスクロール */
export async function scrollToRect(i, rect) {
  stopMomentum();
  const p = view.pages[i];
  if (!p) return;
  await ensurePage(i);
  const s = view.scale;
  const [x1, y1, x2, y2] = p.vp1.convertToViewportRectangle([rect[0], rect[1], rect[0] + rect[2], rect[1] + rect[3]]);
  viewerEl.scrollTo({
    top: p.div.offsetTop + Math.min(y1, y2) * s - viewerEl.clientHeight / 3,
    left: p.div.offsetLeft + Math.min(x1, x2) * s - 60,
    behavior: 'smooth'
  });
  scheduleUpdate();
}

// ---------------------------------------------------------------- ページの描画と解放

const queue = new Set();
let active = 0;

/**
 * 描き終えたページ画像のキャッシュ。画面から離れたページの画像を、合計の大きさの上限まで残しておき、
 * 戻ってきたときに描き直さずにすぐ出す（スキャン画像のように描画が重い文書で、行き来を軽くする）。
 * 文書（state.pdf）か倍率が変わったものは使わない
 */
// メモリの少ない PC（ブラウザーが報告するメモリが 8GB 未満）では控えめに
const CACHE_BYTES = ((navigator.deviceMemory || 8) >= 8 ? 256 : 128) * 1024 * 1024;
const canvasCache = new Map(); // ページの番号 → { canvas, scale, pdf, bytes }
let cacheBytes = 0;
function cachePut(i, canvas, scale) {
  cacheDrop(i);
  const bytes = canvas.width * canvas.height * 4;
  if (bytes > CACHE_BYTES / 4) { canvas.width = 0; return; }
  canvasCache.set(i, { canvas, scale, pdf: state.pdf, bytes });
  cacheBytes += bytes;
  // 古いものから捨てる（Map は入れた順）
  for (const [k, e] of canvasCache) {
    if (cacheBytes <= CACHE_BYTES) break;
    cacheDrop(k);
  }
}
function cacheTake(i, scale) {
  const e = canvasCache.get(i);
  if (!e) return null;
  canvasCache.delete(i);
  cacheBytes -= e.bytes;
  if (e.pdf !== state.pdf || e.scale !== scale) { e.canvas.width = 0; return null; }
  return e.canvas;
}
function cacheDrop(i) {
  const e = canvasCache.get(i);
  if (!e) return;
  canvasCache.delete(i);
  cacheBytes -= e.bytes;
  e.canvas.width = 0;
}
function cacheClear() { for (const k of [...canvasCache.keys()]) cacheDrop(k); }
/** サムネイル用：そのページの描き終えた画像（表示中かキャッシュ）があれば返す */
export function pageImage(i) {
  const p = view.pages[i];
  if (p?.canvas && p.canvasScale) return p.canvas;
  const e = canvasCache.get(i);
  return e && e.pdf === state.pdf ? e.canvas : null;
}

function enqueue(i) {
  queue.add(i);
  pump();
}

/** 画面中央に近いページから順に描画する */
function pump() {
  while (active < 4 && queue.size) {
    const center = viewerEl.scrollTop + viewerEl.clientHeight / 2;
    let best = -1, bestD = Infinity;
    for (const i of queue) {
      const p = view.pages[i];
      if (!p?.mounted) { queue.delete(i); continue; }
      const d = Math.abs(p.div.offsetTop + p.div.offsetHeight / 2 - center);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best < 0) return;
    // pdf.js の描画は 2 つまで。スキャン画像のページはワーカーで描くので 4 つまで同時に
    if (active >= MAX_ACTIVE_RENDERS && !(active < 4 && scanAvailable() && scanInfo(best))) return;
    queue.delete(best);
    active++;
    renderCanvas(best).finally(() => { active--; pump(); });
  }
  if (!queue.size && !active) {
    emit('render-idle');
    scheduleDocCleanup();
  }
}

/**
 * たくさんのページを表示し終えたら、pdf.js が文書全体で抱えるキャッシュ（解析済みのページ・画像など）も解放する。
 * 描画中は解放できないので、描画が落ち着いてから行う。
 */
let unmountedSinceCleanup = 0;
let cleanupTimer = 0;
function scheduleDocCleanup() {
  if (unmountedSinceCleanup < 20) return;
  clearTimeout(cleanupTimer);
  cleanupTimer = setTimeout(async () => {
    if (queue.size || active || !state.pdf) return;
    const busy = (window.__thumbBusy && window.__thumbBusy()) || view.pages.some((p) => p.task || p.detailTask) || detailBusy;
    if (busy) { scheduleDocCleanup(); return; }
    try {
      await state.pdf.cleanup(true);
      unmountedSinceCleanup = 0;
    } catch {
      scheduleDocCleanup();
    }
  }, 1500);
}

async function mountPage(i) {
  const p = view.pages[i];
  if (!p || p.mounted) return;
  p.mounted = true;
  const gen = ++p.gen;
  const page = await ensurePage(i);
  if (!page || !p.mounted || p.gen !== gen) return;
  const { w, h } = p.base;
  p.textDiv = el('div', { class: 'textLayer' });
  p.linkDiv = el('div', { class: 'link-layer' });
  p.formDiv = el('div', { class: 'form-layer' });
  p.overlay = svg('svg', { class: `overlay tool-${view.tool}`, viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: 'none' });
  p.div.append(p.textDiv, p.linkDiv, p.formDiv, p.overlay);
  attachOverlayEvents(i, p.overlay);
  drawOverlay(i);
  // キャッシュに同じ倍率の画像があれば、すぐに出す（文字選択・リンクなどの層は作り直す）
  const cached = cacheTake(i, view.scale);
  if (cached) {
    p.div.prepend(cached);
    p.canvas = cached;
    p.canvasScale = view.scale;
    if (!window.__noText) { p.layersBuilt = true; buildTextAndAnnotationLayers(i, gen); }
    if (detailWanted(i)) scheduleDetail();
    return;
  }
  enqueue(i);
}

function unmountPage(p, force = false) {
  if (!p.mounted) return;
  // 入力中のフォーム欄があるページは解放しない
  if (!force && p.formDiv?.contains(document.activeElement)) return;
  p.mounted = false;
  p.gen++;
  p.task?.cancel();
  p.task = null;
  p.detailTask?.cancel();
  p.detailTask = null;
  p.textLayer?.cancel();
  p.textLayer = null;
  // 倍率に合った描き終えた画像は、キャッシュに残す（手動で解放するとき＝force は捨てる）
  if (p.canvas) {
    if (!force && p.canvasScale === view.scale) { p.canvas.remove(); cachePut(view.pages.indexOf(p), p.canvas, p.canvasScale); }
    else { p.canvas.width = 0; p.canvas.height = 0; }
  }
  p.canvas = null;
  p.canvasScale = 0;
  if (p.detail) { p.detail.width = 0; p.detail = null; }
  p.layersBuilt = false;
  p.overlay = p.textDiv = p.linkDiv = p.formDiv = p.objGroup = p.preview = null;
  p.div.replaceChildren();
  // pdf.js がページごとに抱える描画命令・フォントのキャッシュも解放する（描画の中止が済んでから）
  const page = p.pdfPage;
  if (page) setTimeout(() => { if (!p.mounted) page.cleanup(); }, 0);
  unmountedSinceCleanup++;
}

// ---------------------------------------------------------------- 見えている部分の細かい画像
// ページ全体の画像は画素数に上限（MAX_CANVAS_PIXELS）があるため、大きな図面を拡大するとぼやける。
// そのときは、画面に見えている部分だけを画面の解像度で描いた画像（page-detail）を重ねる（XChange などと同じ考え方）。
// スキャン画像のページはワーカーで範囲だけを縮め、それ以外は pdf.js に範囲だけを描かせる。

/** ページ i に細かい画像が要るか（全体の画像では画面の解像度に足りない） */
export function detailWanted(i) {
  const p = view.pages[i];
  if (!p?.mounted || !p.pdfPage) return false;
  const dpr = window.devicePixelRatio || 1;
  const vp = p.vp1;
  if (!vp) return false;
  // スキャン画像のページは、回転していないもの（ワーカーで範囲だけ描ける）に限る。pdf.js で 5 億画素を描き直すと重い
  const scan = scanAvailable() ? scanInfo(i) : null;
  if (scan && (scan.rotate !== 0 || scan.failed)) return false;
  const need = vp.width * vp.height * view.scale * view.scale * dpr * dpr;
  return need > detailThreshold * 1.02;
}

let detailThreshold = MAX_CANVAS_PIXELS;
/** 自動テスト用：細かい画像を使い始める画素数を変える（小さなページでも確かめるため） */
export function setDetailThreshold(px) { detailThreshold = px || MAX_CANVAS_PIXELS; }

let detailTimer = 0;
let detailToken = 0;
/** スクロールが止まってから（または拡大のあと）、見えているページの細かい画像を作る */
let lastDetailRun = 0;
function scheduleDetail() {
  clearTimeout(detailTimer);
  // スクロールしている最中も 0.3 秒ごとに作り直す（止まるまで待つと、新しく見えた部分がしばらくぼやける）
  // スクロールしている最中に作るのはスキャン画像のページだけ（普通の PDF は描くのが重いので、止まってから）
  if (performance.now() - lastDetailRun > 300 && view.pages.some((p, i) => p.mounted && detailWanted(i) && scanAvailable() && scanInfo(i))) runDetail();
  else detailTimer = setTimeout(runDetail, 120);
}

let detailBusy = false, detailPending = false;
async function runDetail() {
  clearTimeout(detailTimer);
  lastDetailRun = performance.now();
  // 作っている最中なら、終わってから最新の状態でもう一度作る（依頼をためない）
  if (detailBusy) { detailPending = true; return; }
  detailBusy = true;
  try { await runDetailOnce(); } finally {
    detailBusy = false;
    if (detailPending) { detailPending = false; runDetail(); }
  }
}

async function runDetailOnce() {
  const token = ++detailToken;
  const vr = viewerEl.getBoundingClientRect();
  for (const [i, p] of view.pages.entries()) {
    if (!p.mounted) continue;
    const r = p.div.getBoundingClientRect();
    const visible = r.bottom > vr.top && r.top < vr.bottom && r.right > vr.left && r.left < vr.right;
    if (!visible || !detailWanted(i)) {
      if (p.detail && !detailWanted(i)) { p.detail.remove(); p.detail.width = 0; p.detail = null; }
      continue;
    }
    try { await renderDetail(i, token); } catch (e) { console.warn(e); }
    if (token !== detailToken) return;
  }
}

let detailLogged = 0;
async function renderDetail(i, token) {
  const t0 = performance.now();
  const p = view.pages[i];
  const gen = p.gen, scale = view.scale;
  const dpr = window.devicePixelRatio || 1;
  const vr = viewerEl.getBoundingClientRect();
  const r = p.div.getBoundingClientRect();
  if (!r.width || !r.height) return;
  // 見えている範囲（ページの中の CSS 画素）。少しはみ出して作り、少しのスクロールでは作り直さない
  const mx = vr.width * 0.15, my = vr.height * 0.15;
  let x0 = Math.max(0, vr.left - r.left - mx), y0 = Math.max(0, vr.top - r.top - my);
  let x1 = Math.min(r.width, vr.right - r.left + mx), y1 = Math.min(r.height, vr.bottom - r.top + my);
  if (x1 <= x0 || y1 <= y0) return;
  // 今の画像がこの範囲・倍率をすでに覆っていれば作らない
  const d = p.detail;
  if (d && d.dataset.scale === String(scale)) {
    const [dx, dy, dw, dh] = d.dataset.rect.split(',').map(Number);
    if (dx <= x0 + 1 && dy <= y0 + 1 && dx + dw >= x1 - 1 && dy + dh >= y1 - 1) return;
  }
  let k = dpr;
  const cw0 = (x1 - x0) * k, ch0 = (y1 - y0) * k;
  if (cw0 * ch0 > MAX_CANVAS_PIXELS) k *= Math.sqrt(MAX_CANVAS_PIXELS / (cw0 * ch0));
  const canvas = document.createElement('canvas');
  canvas.className = 'page-detail';
  canvas.width = Math.max(1, Math.round((x1 - x0) * k));
  canvas.height = Math.max(1, Math.round((y1 - y0) * k));
  const ctx = canvas.getContext('2d');
  const scan = scanAvailable() ? scanInfo(i) : null;
  let ok = false;
  if (scan && scan.rotate === 0) {
    // 画像の画素での範囲（ページ全体 = 画像全体）。整数の画素にそろえ、置く位置もそれに合わせる（注釈とずれないように）
    const ix0 = Math.max(0, Math.floor((x0 / r.width) * scan.w)), iy0 = Math.max(0, Math.floor((y0 / r.height) * scan.h));
    const ix1 = Math.min(scan.w, Math.ceil((x1 / r.width) * scan.w)), iy1 = Math.min(scan.h, Math.ceil((y1 / r.height) * scan.h));
    x0 = (ix0 / scan.w) * r.width; x1 = (ix1 / scan.w) * r.width;
    y0 = (iy0 / scan.h) * r.height; y1 = (iy1 / scan.h) * r.height;
    canvas.width = Math.max(1, Math.round((x1 - x0) * k));
    canvas.height = Math.max(1, Math.round((y1 - y0) * k));
    const region = { x: ix0, y: iy0, w: ix1 - ix0, h: iy1 - iy0 };
    let bmp = null;
    try { bmp = await renderScan(scan, canvas.width, canvas.height, region); } catch { bmp = null; }
    if (bmp) {
      if (token !== detailToken || p.gen !== gen || view.scale !== scale) { bmp.close(); canvas.width = 0; return; }
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      drawScan(ctx, bmp, 0, canvas.width, canvas.height, scan.interpolate);
      bmp.close();
      ok = true;
    }
  }
  if (!ok) {
    // pdf.js に範囲だけを描かせる（ずらして描き、canvas の外は描かれない）
    const vp = p.pdfPage.getViewport({ scale, rotation: p.pdfPage.rotate });
    const sx = vp.width / r.width, sy = vp.height / r.height; // CSS 画素あたりの viewport 画素（通常 1）
    const task = p.pdfPage.render({ canvasContext: ctx, viewport: vp, transform: [k / sx, 0, 0, k / sy, -x0 * k, -y0 * k], annotationMode: pdfjsLib.AnnotationMode.ENABLE });
    p.detailTask?.cancel();
    p.detailTask = task;
    try { await task.promise; } catch (e) { canvas.width = 0; if (e?.name !== 'RenderingCancelledException') console.warn(e); return; }
    finally { if (p.detailTask === task) p.detailTask = null; }
  }
  if (token !== detailToken || p.gen !== gen || view.scale !== scale || !p.mounted) { canvas.width = 0; return; }
  // ページの中の割合で置く（拡大・縮小しても位置がずれない）
  Object.assign(canvas.style, { position: 'absolute', left: `${(x0 / r.width) * 100}%`, top: `${(y0 / r.height) * 100}%`, width: `${((x1 - x0) / r.width) * 100}%`, height: `${((y1 - y0) / r.height) * 100}%`, pointerEvents: 'none' });
  canvas.dataset.scale = String(scale);
  canvas.dataset.rect = [x0, y0, x1 - x0, y1 - y0].join(',');
  if (p.detail) { p.detail.replaceWith(canvas); p.detail.width = 0; } else if (p.canvas) p.canvas.after(canvas); else p.div.prepend(canvas);
  p.detail = canvas;
  // 実際の PC での時間を記録する（最初の 5 回だけ。ファイル名などは入れない）
  if (detailLogged < 5) {
    detailLogged++;
    window.api?.logInfo?.(`detail: ${Math.round(performance.now() - t0)}ms ${canvas.width}x${canvas.height} ${scan ? 'scan' : 'pdfjs'} scale=${scale.toFixed(2)}`);
  }
}

async function renderCanvas(i) {
  const p = view.pages[i];
  if (!p?.mounted || !p.pdfPage) return;
  const gen = p.gen;
  const page = p.pdfPage;
  const scale = view.scale;
  if (p.canvasScale === scale) return;
  const vp = page.getViewport({ scale, rotation: page.rotate });
  const dpr = window.devicePixelRatio || 1;
  // 見えている部分を細かく描くページ（大きな図面の拡大）は、ページ全体の画像を小さめにして速く描く
  const cap = detailWanted(i) && scanAvailable() && scanInfo(i)?.rotate === 0 ? DETAIL_BASE_PIXELS : MAX_CANVAS_PIXELS;
  // 枠（ページの div）と同じ四捨五入で、画面上の大きさを求める。絵の画素数を枠とぴったり同じにして、
  // 引き伸ばしでにじまないようにする（切り捨てだと 1 画素小さくなり、ページ全体がぼやけていた）
  const boxW = Math.round(p.base.w * scale), boxH = Math.round(p.base.h * scale);
  const outScale = Math.min(dpr, Math.sqrt(cap / Math.max(1, boxW * boxH)));
  const canvas = document.createElement('canvas');
  canvas.className = 'page-canvas';
  canvas.width = Math.max(1, Math.round(boxW * outScale));
  canvas.height = Math.max(1, Math.round(boxH * outScale));
  // スキャン画像だけのページは、ワーカーで縮めた画像を描く（pdf.js より大幅に速い）。失敗したら pdf.js で描く
  const scan = scanAvailable() ? scanInfo(i) : null;
  if (scan) {
    const t0 = performance.now();
    let bmp = null;
    try {
      const { tw, th } = scanTarget(scan, canvas.width, canvas.height);
      bmp = await renderScan(scan, tw, th);
    } catch { bmp = null; }
    if (bmp) {
      if (!p.mounted || p.gen !== gen || view.pages[i] !== p) { bmp.close(); canvas.width = 0; return; }
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      drawScan(ctx, bmp, scan.rotate, canvas.width, canvas.height, scan.interpolate);
      bmp.close();
      notePerf(performance.now() - t0, canvas.width * canvas.height, 'scan');
      return placeCanvas(i, p, gen, canvas, scale);
    }
  }
  const sx = canvas.width / vp.width, sy = canvas.height / vp.height;
  const task = page.render({
    canvasContext: canvas.getContext('2d'),
    viewport: vp,
    transform: sx !== 1 || sy !== 1 ? [sx, 0, 0, sy, 0, 0] : null,
    annotationMode: pdfjsLib.AnnotationMode.ENABLE
  });
  p.task = task;
  const t0 = performance.now();
  try {
    await task.promise;
    notePerf(performance.now() - t0, canvas.width * canvas.height, 'pdfjs');
  } catch (e) {
    canvas.width = 0;
    if (e?.name !== 'RenderingCancelledException') console.error(e);
    return;
  } finally {
    if (p.task === task) p.task = null;
  }
  return placeCanvas(i, p, gen, canvas, scale);
}

function placeCanvas(i, p, gen, canvas, scale) {
  if (!p.mounted || p.gen !== gen) { canvas.width = 0; return; }
  // 描き終わってから差し替える（ズーム中に白くならないように）
  if (p.canvas) { p.canvas.replaceWith(canvas); p.canvas.width = 0; } else p.div.prepend(canvas);
  p.canvas = canvas;
  p.canvasScale = scale;
  // 細かい画像（見えている部分）は全体の画像の上に重ねる
  if (p.detail) canvas.after(p.detail);
  if (detailWanted(i)) scheduleDetail();
  if (!p.layersBuilt && !window.__noText) {
    p.layersBuilt = true;
    buildTextAndAnnotationLayers(i, gen);
  }
  if (view.scale !== scale) enqueue(i);
}

/** 文字選択用のテキストレイヤーと、リンク・フォーム入力欄（倍率に依存しない配置） */
async function buildTextAndAnnotationLayers(i, gen) {
  const p = view.pages[i];
  try {
    p.textLayer = new pdfjsLib.TextLayer({ textContentSource: p.pdfPage.streamTextContent(), container: p.textDiv, viewport: p.vp1 });
    await p.textLayer.render();
    if (!p.mounted || p.gen !== gen) return;
    await buildAnnotationLayers(i, gen);
  } catch (e) {
    if (e?.name !== 'AbortException') console.warn(e);
  }
}

async function buildAnnotationLayers(i, gen) {
  const p = view.pages[i];
  const annots = await p.pdfPage.getAnnotations({ intent: 'display' });
  if (!p.mounted || p.gen !== gen) return;
  const { w: W, h: H } = p.base;
  const form = state.lib.getForm();
  const formsAllowed = can('forms');
  for (const a of annots) {
    const r = p.vp1.convertToViewportRectangle(a.rect);
    const left = Math.min(r[0], r[2]), top = Math.min(r[1], r[3]);
    const width = Math.abs(r[2] - r[0]), height = Math.abs(r[3] - r[1]);
    const style = `left:${(left / W) * 100}%;top:${(top / H) * 100}%;width:${(width / W) * 100}%;height:${(height / H) * 100}%`;
    if (a.subtype === 'Link' && (a.url || a.dest)) {
      const link = el('a', { class: 'pdf-link', style, title: a.url || 'ページ内リンク' });
      // 手のひらでは、リンクの上からでもドラッグで画面を動かせるようにする（目次などページ全体がリンクのこともある）
      // down: 押した位置と、押しているあいだに動いた最大の距離（戻してもドラッグとみなす）
      let down = null;
      link.addEventListener('pointerdown', (e) => {
        down = { x: e.clientX, y: e.clientY, max: 0 };
        if (view.tool !== 'hand' || e.button !== 0) return;
        blurFormField();
        e.preventDefault();
        document.body.classList.add('panning');
        startDrag(e, { kind: 'pan', x: e.clientX, y: e.clientY, sl: viewerEl.scrollLeft, st: viewerEl.scrollTop });
      });
      link.addEventListener('pointermove', (e) => {
        if (down) down.max = Math.max(down.max, Math.hypot(e.clientX - down.x, e.clientY - down.y));
      });
      link.addEventListener('click', async (e) => {
        e.preventDefault();
        const d = down;
        down = null;
        // リンクは選択ツールと手のひら（既定）で開く。ドラッグして画面を動かしたときは開かない
        // （マウス以外からのクリック〔e.detail === 0〕は位置で判定しない）
        if (view.tool !== 'select' && view.tool !== 'hand') return;
        // 滑っているのを止めるために押したときは開かない
        if (performance.now() - stoppedByPress < 600) return;
        if (e.detail !== 0 && d && Math.max(d.max, Math.hypot(e.clientX - d.x, e.clientY - d.y)) > 4) return;
        if (a.url) {
          // 開けるのは Web とメールのリンクだけ（メインプロセスも同じ条件）
          if (!/^(https?:|mailto:)/i.test(a.url)) { toast('このリンクは開けない種類です'); return; }
          // 誤ってクリックしてもブラウザが開かないよう、URL を見せて確認する
          if (await confirmBox('このリンクを開きますか？', a.url, '開く')) window.api.openExternal(a.url);
        } else {
          const dest = typeof a.dest === 'string' ? await state.pdf.getDestination(a.dest) : a.dest;
          if (dest?.[0]) scrollToPage(await state.pdf.getPageIndex(dest[0]));
        }
      });
      p.linkDiv.append(link);
    }
    if (a.subtype === 'Widget' && a.fieldName && !a.hidden) {
      const fs = Math.max(6, Math.min(height * 0.7, 14));
      const fontStyle = `${style};font-size:calc(var(--scale-factor) * ${fs.toFixed(2)}px)`;
      let input;
      try {
        if (a.fieldType === 'Tx') {
          const field = form.getTextField(a.fieldName);
          input = a.multiLine ? el('textarea', { class: 'pdf-input', style: fontStyle }) : el('input', { class: 'pdf-input', style: fontStyle, type: a.password ? 'password' : 'text' });
          input.value = field.getText() ?? '';
          input.addEventListener('change', () => { field.setText(input.value); formChanged(); });
        } else if (a.fieldType === 'Btn' && a.checkBox) {
          const field = form.getCheckBox(a.fieldName);
          input = el('input', { class: 'pdf-check', style, type: 'checkbox' });
          input.checked = field.isChecked();
          input.addEventListener('change', () => { input.checked ? field.check() : field.uncheck(); formChanged(); });
        } else if (a.fieldType === 'Btn' && a.radioButton) {
          const field = form.getRadioGroup(a.fieldName);
          input = el('input', { class: 'pdf-check', style, type: 'radio', name: `${state.pageIds[i]}-${a.fieldName}` });
          const value = field.getOptions().includes(a.buttonValue) ? a.buttonValue : null;
          input.checked = value != null && field.getSelected() === value;
          input.addEventListener('change', () => { if (value) { field.select(value); formChanged(); } });
        } else if (a.fieldType === 'Ch') {
          const field = a.combo ? form.getDropdown(a.fieldName) : form.getOptionList(a.fieldName);
          input = el('select', { class: 'pdf-input', style: fontStyle }, ...field.getOptions().map((o) => el('option', { value: o }, o)));
          input.value = field.getSelected()[0] ?? '';
          input.addEventListener('change', () => { field.select(input.value); formChanged(); });
        }
      } catch (e) {
        console.warn('form field', a.fieldName, e.message);
      }
      if (input) {
        input.title = a.fieldName;
        if (a.readOnly || !formsAllowed) input.disabled = true;
        p.formDiv.append(input);
      }
    }
  }
}

function formChanged() {
  state.formDirty = true;
  setDirty(true);
}

// ---------------------------------------------------------------- 注釈オブジェクトの描画

export const selectedObject = () => (view.selected ? findObject(view.selected) : null);

/** canvas の measureText で文字幅を測り、PDF 出力と同じ規則で折り返す */
const measureCtx = document.createElement('canvas').getContext('2d');
/** 文字列に使うフォント（PDF に書き込むときと同じ決め方：タイ文字を含めば文字列全体を Noto Sans Thai） */
// タイ文字と日本語が混ざると、PDF では日本語の部分を描けない（制限）。画面では日本語も表示できるよう予備に入れる
export const fontFamilyFor = (text) => (THAI.test(text || '') ? '"Noto Sans Thai", "Noto Sans JP"' : '"Noto Sans JP"');
export function layoutLines(text, size, width, bold = false) {
  measureCtx.font = `${bold ? 700 : 400} ${size}px ${fontFamilyFor(text)}`;
  const out = [];
  for (const para of String(text).split('\n')) {
    if (!width) { out.push(para); continue; }
    let line = '';
    for (const ch of Array.from(para)) {
      const next = line + ch;
      if (line && measureCtx.measureText(next).width > width) { out.push(line); line = ch; } else line = next;
    }
    out.push(line);
  }
  return out;
}
/** ref: フォントを決める元の文字列（1 行だけ測るときは注釈の文字全体を渡す） */
export function measureWidth(text, size, bold = false, ref = text) {
  measureCtx.font = `${bold ? 700 : 400} ${size}px ${fontFamilyFor(ref)}`;
  return Math.max(...String(text).split('\n').map((l) => measureCtx.measureText(l).width), 0);
}
/** テキスト項目のうち pos から len 文字分の矩形（文字幅の比率で推定） */
export function subRange(item, pos, len) {
  measureCtx.font = '100px "Noto Sans JP"';
  const full = measureCtx.measureText(item.str).width || 1;
  const a = measureCtx.measureText(item.str.slice(0, pos)).width / full;
  const b = measureCtx.measureText(item.str.slice(0, pos + len)).width / full;
  const [x, y, w, h] = item.rect;
  return item.vertical ? [x, y + h * (1 - b), w, h * (b - a)] : [x + w * a, y, w * (b - a), h];
}

export function textBoxHeight(o) {
  const lines = layoutLines(o.text || '', o.fontSize, o.type === 'edit' ? 0 : o.rect[2] - 6, o.bold).length;
  const pad = o.type === 'edit' ? 0 : 3;
  return pad * 2 + o.fontSize * (TEXT_ASCENT + 0.3 + (lines - 1) * LINE_HEIGHT);
}

function drawShape(o) {
  const [x, y, w, h] = o.rect;
  const g = svg('g', { 'data-id': o.id, class: 'obj', opacity: o.type === 'highlight' ? null : (o.opacity ?? 1) });
  const sw = o.width ?? 1;
  switch (o.type) {
    case 'rect':
      g.append(svg('rect', { x: x + sw / 2, y: y + sw / 2, width: Math.max(0, w - sw), height: Math.max(0, h - sw), fill: o.fill || 'none', stroke: o.color, 'stroke-width': sw }));
      if (!o.fill) g.append(svg('rect', { x, y, width: w, height: h, fill: 'none', stroke: 'transparent', 'stroke-width': sw + 8 / view.scale }));
      break;
    case 'ellipse':
      g.append(svg('ellipse', { cx: x + w / 2, cy: y + h / 2, rx: Math.max(0, w / 2 - sw / 2), ry: Math.max(0, h / 2 - sw / 2), fill: o.fill || 'none', stroke: o.color, 'stroke-width': sw }));
      if (!o.fill) g.append(svg('ellipse', { cx: x + w / 2, cy: y + h / 2, rx: w / 2, ry: h / 2, fill: 'none', stroke: 'transparent', 'stroke-width': sw + 8 / view.scale }));
      break;
    case 'redact':
      g.append(svg('rect', { x, y, width: w, height: h, fill: 'rgba(0,0,0,0.35)', stroke: '#e03131', 'stroke-width': 1.5 }));
      break;
    case 'line':
    case 'arrow': {
      const [p1, p2] = o.points;
      g.append(svg('line', { x1: p1[0], y1: p1[1], x2: p2[0], y2: p2[1], stroke: o.color, 'stroke-width': sw, 'stroke-linecap': 'round' }));
      if (o.type === 'arrow') {
        const ang = Math.atan2(p2[1] - p1[1], p2[0] - p1[0]);
        const len = Math.max(8, sw * 4);
        const a1 = ang + Math.PI * 0.85, a2 = ang - Math.PI * 0.85;
        g.append(svg('polygon', { points: `${p2[0]},${p2[1]} ${p2[0] + Math.cos(a1) * len},${p2[1] + Math.sin(a1) * len} ${p2[0] + Math.cos(a2) * len},${p2[1] + Math.sin(a2) * len}`, fill: o.color }));
      }
      // 細い線でもクリックしやすいように透明の太線を重ねる
      g.append(svg('line', { x1: p1[0], y1: p1[1], x2: p2[0], y2: p2[1], stroke: 'transparent', 'stroke-width': sw + 8 / view.scale }));
      break;
    }
    case 'ink':
      for (const s of o.strokes) {
        const d = s.map((p, k) => `${k ? 'L' : 'M'}${p[0]} ${p[1]}`).join(' ') + (s.length === 1 ? ' l0.1 0' : '');
        g.append(svg('path', { d, fill: 'none', stroke: o.color, 'stroke-width': sw, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
        g.append(svg('path', { d, fill: 'none', stroke: 'transparent', 'stroke-width': sw + 8 / view.scale }));
      }
      break;
    case 'highlight':
      g.setAttribute('style', 'mix-blend-mode:multiply');
      for (const [qx, qy, qw, qh] of o.quads) g.append(svg('rect', { x: qx, y: qy, width: qw, height: qh, fill: o.color, opacity: o.opacity ?? 1 }));
      break;
    case 'underline':
    case 'strike':
      for (const [qx, qy, qw, qh] of o.quads) {
        const ly = o.type === 'underline' ? qy + qh * 0.08 : qy + qh * 0.45;
        g.append(svg('rect', { x: qx, y: qy, width: qw, height: qh, fill: 'transparent' }));
        g.append(svg('line', { x1: qx, y1: ly, x2: qx + qw, y2: ly, stroke: o.color, 'stroke-width': Math.max(0.8, qh * 0.07) }));
      }
      break;
    case 'text':
    case 'edit': {
      g.append(svg('rect', { x, y, width: w, height: h, fill: o.type === 'edit' ? '#ffffff' : (o.fill || 'transparent') }));
      if (o.type === 'text' && o.borderColor) g.append(svg('rect', { x: x + 0.5, y: y + 0.5, width: w - 1, height: h - 1, fill: 'none', stroke: o.borderColor, 'stroke-width': 1 }));
      const pad = o.type === 'edit' ? 0 : 3;
      const size = o.fontSize || 12;
      const lines = layoutLines(o.text || '', size, o.type === 'edit' ? 0 : w - pad * 2, o.bold);
      lines.forEach((ln, k) => {
        let lx = x + pad;
        if (o.align && o.align !== 'left') {
          const lw = measureWidth(ln, size, o.bold, o.text);
          lx = o.align === 'center' ? x + (w - lw) / 2 : x + w - pad - lw;
        }
        const t = svg('text', { transform: `matrix(1 0 0 -1 ${lx} ${y + h - pad - size * TEXT_ASCENT - k * size * LINE_HEIGHT})`, 'font-size': size, fill: o.fontColor || '#000', 'font-family': fontFamilyFor(o.text), 'font-weight': o.bold ? 700 : 400 });
        t.textContent = ln;
        g.append(t);
      });
      break;
    }
    case 'note':
      g.append(svg('path', { d: `M${x} ${y} L${x + w} ${y} L${x + w} ${y + h * 0.7} L${x + w * 0.7} ${y + h} L${x} ${y + h} Z`, fill: o.color || '#ffd43b', stroke: '#735a00', 'stroke-width': 0.8 }));
      for (const f of [0.65, 0.45, 0.25]) g.append(svg('line', { x1: x + 4, y1: y + h * f, x2: x + w - 4, y2: y + h * f, stroke: '#735a00', 'stroke-width': 0.8 }));
      break;
    case 'image': {
      const img = svg('image', { width: 1, height: 1, preserveAspectRatio: 'none', transform: `matrix(${w} 0 0 ${-h} ${x} ${y + h})` });
      img.setAttribute('href', o.src);
      g.append(img);
      break;
    }
    case 'link':
      g.append(svg('rect', { x, y, width: w, height: h, fill: 'rgba(28,126,214,0.08)', stroke: '#1c7ed6', 'stroke-width': 1 / view.scale, 'stroke-dasharray': `${4 / view.scale} ${3 / view.scale}` }));
      break;
    case 'measure':
      drawMeasure(g, o);
      break;
  }
  if (o.angle && ANGLE_TYPES.has(o.type)) {
    const inner = svg('g', { transform: `rotate(${o.angle} ${x + w / 2} ${y + h / 2})` });
    inner.append(...g.childNodes);
    g.append(inner);
  }
  return g;
}

/** 測定の図形とラベル（PDF 座標。保存時の見た目に合わせる） */
function drawMeasure(g, o) {
  const pts = o.points;
  const sw = o.width ?? 1;
  const d = pts.map((p, k) => `${k ? 'L' : 'M'}${p[0]} ${p[1]}`).join(' ') + (o.kind === 'area' ? ' Z' : '');
  if (o.kind === 'area' && o.fill) g.append(svg('path', { d, fill: o.fill, 'fill-opacity': 0.2, stroke: 'none' }));
  g.append(svg('path', { d, fill: 'none', stroke: o.color, 'stroke-width': sw, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  if (o.kind !== 'area' && pts.length >= 2) {
    const tick = Math.max(4, sw * 3);
    for (const [a, b] of [[pts[0], pts[1]], [pts[pts.length - 1], pts[pts.length - 2]]]) {
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]) + Math.PI / 2;
      g.append(svg('line', { x1: a[0] - Math.cos(ang) * tick, y1: a[1] - Math.sin(ang) * tick, x2: a[0] + Math.cos(ang) * tick, y2: a[1] + Math.sin(ang) * tick, stroke: o.color, 'stroke-width': sw }));
    }
  }
  // つかみやすいように、見えない太い線を重ねる
  g.append(svg('path', { d, fill: o.kind === 'area' ? 'transparent' : 'none', stroke: 'transparent', 'stroke-width': sw + 8 / view.scale }));
  const L = measureLabel(o);
  const fs = MEASURE_LABEL_SIZE;
  // 距離の数値は、選択ツールでつかんで動かせる（data-mlabel）
  const lg = svg('g', { transform: `rotate(${L.angle} ${L.cx} ${L.cy})`, ...(o.kind === 'distance' ? { class: 'mlabel', 'data-mlabel': '1' } : {}) });
  lg.append(svg('rect', { x: L.cx - L.w / 2, y: L.cy - L.h / 2, width: L.w, height: L.h, fill: '#ffffff', 'fill-opacity': 0.92 }));
  const t = svg('text', { transform: `matrix(1 0 0 -1 ${L.cx} ${L.cy - fs * 0.35})`, 'font-size': fs, fill: o.color, 'font-family': 'Noto Sans JP', 'text-anchor': 'middle' });
  t.textContent = L.text;
  lg.append(t);
  g.append(lg);
}

const matrixOf = (vp) => `matrix(${vp.transform.join(' ')})`;

export function drawOverlay(i) {
  const p = view.pages[i];
  if (!p?.overlay || !p.vp1) return;
  const o = p.overlay;
  o.setAttribute('class', `overlay tool-${view.tool}`);
  const g = svg('g', { transform: matrixOf(p.vp1) });
  for (const h of view.searchHits) {
    if (h.page === i) g.append(svg('rect', { x: h.rect[0], y: h.rect[1], width: h.rect[2], height: h.rect[3], class: h.current ? 'search-hit current' : 'search-hit' }));
  }
  for (const obj of objectsOf(i)) g.append(drawShape(obj));
  p.objGroup = g;
  p.preview = svg('g', { transform: matrixOf(p.vp1), class: 'preview' });
  const children = [svg('rect', { class: 'capture', x: 0, y: 0, width: '100%', height: '100%' }), g];
  const sel = selectedObject();
  if (sel && sel.page === i) children.push(selectionGroup(p, sel.obj));
  children.push(p.preview);
  o.replaceChildren(...children);
}

/** 選択枠とリサイズハンドル（ページの表示座標。倍率によらず同じ見た目の大きさにする） */
function selectionGroup(p, obj) {
  const r = viewRect(p, objBounds(obj));
  const s = view.scale;
  const g = svg('g', { class: 'selection' });
  const pad = 3 / s;
  g.append(svg('rect', { x: r.x - pad, y: r.y - pad, width: r.w + pad * 2, height: r.h + pad * 2, class: 'sel-box', 'stroke-width': 1 / s, 'stroke-dasharray': `${4 / s} ${3 / s}` }));
  if (obj.type === 'measure') {
    const hs = 9 / s;
    obj.points.forEach((pt, k) => {
      const [vx, vy] = p.vp1.convertToViewportPoint(pt[0], pt[1]);
      g.append(svg('circle', { cx: vx, cy: vy, r: hs / 2, class: 'handle vertex', 'data-vertex': k, 'stroke-width': 1.5 / s }));
    });
  }
  if (resizable(obj)) {
    const hs = 10 / s;
    for (const [hx, hy, corner] of [[r.x, r.y, 'nw'], [r.x + r.w, r.y, 'ne'], [r.x, r.y + r.h, 'sw'], [r.x + r.w, r.y + r.h, 'se']]) {
      g.append(svg('rect', { x: hx - hs / 2, y: hy - hs / 2, width: hs, height: hs, class: `handle h-${corner}`, 'data-corner': corner, 'stroke-width': 1.5 / s }));
    }
  }
  return g;
}

const resizable = (o) => ['rect', 'ellipse', 'text', 'image', 'redact', 'link'].includes(o.type);

/** PDF 座標の矩形 → 倍率 1 の表示座標 */
function viewRect(p, rect) {
  const [x1, y1, x2, y2] = p.vp1.convertToViewportRectangle([rect[0], rect[1], rect[0] + rect[2], rect[1] + rect[3]]);
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}

export function select(id) {
  const prev = view.selected ? findObject(view.selected) : null;
  view.selected = id;
  if (prev && view.pages[prev.page]?.mounted) drawOverlay(prev.page);
  const cur = id ? findObject(id) : null;
  if (cur && cur.page !== prev?.page && view.pages[cur.page]?.mounted) drawOverlay(cur.page);
  emit('selection-changed', id);
}

export function setTool(t) {
  if (!TOOLS[t]) return;
  if (TOOLS[t].perm && !can(TOOLS[t].perm)) {
    toast('この文書は作成者により編集が制限されているため、このツールは使えません');
    return;
  }
  if (t !== view.tool) cancelPoly();
  if (t !== 'measureDist') view.calibrating = false;
  view.tool = t;
  if (t !== 'select') select(null);
  if (!MARKUP.has(t) && t !== 'select') window.getSelection()?.removeAllRanges();
  document.body.dataset.tool = t;
  for (const p of view.pages) if (p.overlay) p.overlay.setAttribute('class', `overlay tool-${t}`);
  emit('tool-changed', t);
}

// ---------------------------------------------------------------- 注釈の追加・削除

export function addObject(pageIndex, obj, { selectIt = false } = {}) {
  storeAdd(pageIndex, obj);
  if (selectIt) select(obj.id);
  return obj;
}

export function removeObject(id) {
  if (view.selected === id) view.selected = null;
  storeRemove(id);
  emit('selection-changed', view.selected);
}

export function updateObject(id, fn) {
  storeUpdate(id, fn);
  if (view.selected === id) emit('selection-changed', id);
}

function translateObject(o, dx, dy) {
  o.rect = [o.rect[0] + dx, o.rect[1] + dy, o.rect[2], o.rect[3]];
  if (o.points) o.points = o.points.map(([x, y]) => [x + dx, y + dy]);
  if (o.strokes) o.strokes = o.strokes.map((s) => s.map(([x, y]) => [x + dx, y + dy]));
  if (o.quads) o.quads = o.quads.map(([x, y, w, h]) => [x + dx, y + dy, w, h]);
}
export function nudgeSelected(dx, dy) {
  if (!view.selected) return;
  updateObject(view.selected, (o) => translateObject(o, dx, dy));
}

/** ページの表示上の回転（時計回り 0/90/180/270） */
export function pageRotation(i) {
  return (((view.pages[i]?.pdfPage?.rotate || 0) % 360) + 360) % 360;
}

/** 選択中の注釈を画面上で時計回りに deg 度回す */
export function rotateSelected(deg) {
  if (!view.selected) return;
  updateObject(view.selected, (o) => rotateObjectBy(o, -deg));
}

/** 選択中の注釈の画面上の角度（時計回り、ページの向きを基準） */
export function selectedDisplayAngle() {
  const f = selectedObject();
  if (!f || !ANGLE_TYPES.has(f.obj.type)) return null;
  return ((((pageRotation(f.page) - (f.obj.angle || 0)) % 360) + 360) % 360);
}

/** 画面上の角度（時計回り）を指定して設定する */
export function setSelectedDisplayAngle(deg) {
  const f = selectedObject();
  if (!f || !ANGLE_TYPES.has(f.obj.type)) return;
  updateObject(f.obj.id, (o) => { o.angle = ((((pageRotation(f.page) - deg) % 360) + 360) % 360); });
}

function boundsOfPoints(pts, pad) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX - pad, minY - pad, maxX - minX + pad * 2, maxY - minY + pad * 2];
}

// ---------------------------------------------------------------- マウス操作

function pdfPoint(i, ev) {
  const p = view.pages[i];
  const r = p.div.getBoundingClientRect();
  return p.vp1.convertToPdfPoint((ev.clientX - r.left) / view.scale, (ev.clientY - r.top) / view.scale);
}

let drag = null;
let lastInk = null;

function attachOverlayEvents(i, overlay) {
  overlay.addEventListener('pointerdown', (ev) => onPointerDown(i, ev));
  overlay.addEventListener('pointermove', (ev) => {
    if (poly && poly.page === i && view.pages[i]?.vp1) drawPolyPreview(polySnap(pdfPoint(i, ev), ev.shiftKey));
  });
  overlay.addEventListener('dblclick', (ev) => {
    const id = ev.target.closest('.obj')?.dataset.id;
    if (id && view.tool === 'select') editObjectContents(id);
  });
}

async function onPointerDown(i, ev) {
  if (ev.button !== 0) return;
  const p = view.pages[i];
  if (!p?.vp1) return;
  const pt = pdfPoint(i, ev);
  const t = view.tool;
  const target = ev.target;

  if (t === 'select') {
    const corner = target.dataset?.corner;
    const sel = selectedObject();
    if (target.dataset?.vertex != null && sel && can('annotate')) {
      ev.preventDefault();
      ev.stopPropagation();
      const g = beginGesture(sel.obj.id);
      startDrag(ev, { kind: 'vertex', page: i, gesture: g, k: +target.dataset.vertex, changed: false });
      return;
    }
    // 距離の測定の数値をつかんだら、数値だけを動かす（線と端点はそのまま）
    const labelOf = target.closest?.('[data-mlabel]')?.closest('.obj')?.dataset.id;
    if (labelOf && can('annotate')) {
      ev.preventDefault();
      ev.stopPropagation();
      if (view.selected !== labelOf) select(labelOf);
      const g = beginGesture(labelOf);
      const o = g?.obj;
      if (o) startDrag(ev, { kind: 'label', page: i, gesture: g, start: pt, orig: Array.isArray(o.labelOffset) ? [...o.labelOffset] : [0, 0], changed: false });
      return;
    }
    if (corner && sel) {
      ev.preventDefault();
      ev.stopPropagation();
      const vr = viewRect(p, objBounds(sel.obj));
      const opp = { nw: [vr.x + vr.w, vr.y + vr.h], ne: [vr.x, vr.y + vr.h], sw: [vr.x + vr.w, vr.y], se: [vr.x, vr.y] }[corner];
      const g = beginGesture(sel.obj.id);
      startDrag(ev, { kind: 'resize', page: i, gesture: g, orig: cloneObject(sel.obj), anchor: p.vp1.convertToPdfPoint(opp[0], opp[1]), changed: false });
      return;
    }
    const id = target.closest?.('.obj')?.dataset.id;
    if (id) {
      ev.preventDefault();
      ev.stopPropagation();
      if (view.selected !== id) select(id);
      if (!can('annotate')) return;
      const g = beginGesture(id);
      startDrag(ev, { kind: 'move', page: i, gesture: g, start: pt, dx: 0, dy: 0, el: p.objGroup?.querySelector(`[data-id="${id}"]`), sel: p.overlay.querySelector('.selection') });
    }
    return;
  }
  if (t === 'hand') {
    ev.preventDefault();
    document.body.classList.add('panning'); // ドラッグ中は「つかんだ手」のカーソルにする
    startDrag(ev, { kind: 'pan', x: ev.clientX, y: ev.clientY, sl: viewerEl.scrollLeft, st: viewerEl.scrollTop });
    return;
  }
  if (t === 'eraser') {
    const id = target.closest?.('.obj')?.dataset.id;
    if (id) removeObject(id);
    return;
  }
  if (t === 'note') {
    const text = await promptText('付箋（コメント）', '', { multiline: true, message: 'コメントを入力してください。' });
    if (text) addObject(i, { type: 'note', rect: [pt[0] - 10, pt[1] - 10, 20, 20], color: '#ffd43b', contents: text, author: 'PDF Studio' });
    return;
  }
  if (t === 'edit') { editExistingText(i, pt); return; }
  if (t === 'image') { placeImageFromFile(i, pt); return; }
  if (t === 'stamp') { const src = await chooseStamp(); if (src) placeImage(i, pt, src, null, 'スタンプ'); return; }
  if (t === 'signature') { const src = await chooseSignature(); if (src) placeImage(i, pt, src, 150, '署名'); return; }
  if (POLY_TOOLS.has(t)) {
    ev.preventDefault();
    // ダブルクリックの 2 回目は点を足さずに確定する。
    // pointerdown の detail（連続クリックの回数）は、この版の Chromium では 0 のことがあるので当てにせず、
    // 前に押した時刻と位置から自分で見分ける（0.5 秒以内に、ほぼ同じ場所＝6 画素以内）
    const now = performance.now();
    const quick = lastPolyDown && now - lastPolyDown.t < 500 && Math.hypot(ev.clientX - lastPolyDown.x, ev.clientY - lastPolyDown.y) <= 6;
    lastPolyDown = { t: now, x: ev.clientX, y: ev.clientY };
    if ((ev.detail >= 2 || quick) && poly?.page === i) { lastPolyDown = null; finishPoly(); return; }
    if (!poly || poly.page !== i) { cancelPoly(); poly = { page: i, kind: t === 'measureArea' ? 'area' : 'perimeter', points: [] }; }
    const q = polySnap(pt, ev.shiftKey);
    poly.points.push(q);
    drawPolyPreview(q);
    return;
  }
  if (DRAG_TOOLS.has(t)) {
    ev.preventDefault();
    startDrag(ev, { kind: 'create', page: i, start: pt, cur: pt, points: [pt], path: null });
  }
}

// ---------------------------------------------------------------- 測定

let poly = null;  // 入力中の折れ線・多角形 { page, kind, points }
let lastPolyDown = null; // 周長・面積で最後にマウスを押した時刻と位置（ダブルクリックを見分ける）

/** 文書の縮尺 */
export const currentScale = () => state.measureScale || DEFAULT_SCALE;

function addMeasure(i, kind, points) {
  const s = view.settings;
  const o = {
    type: 'measure', kind, points: points.map((q) => [q[0], q[1]]), color: s.color, width: Math.min(s.width, 3), opacity: s.opacity,
    fill: kind === 'area' ? (s.fill || s.color) : null, scale: { ...currentScale() }, labelAngle: pageRotation(i), rect: [0, 0, 0, 0]
  };
  o.rect = objBounds(o);
  o.contents = `${measureValue(o).label}: ${measureValue(o).text}`;
  addObject(i, o);
  return o;
}

/** Shift で直前の頂点から 45° 単位にそろえる */
function polySnap(pt, shift) {
  if (!shift || !poly?.points.length) return pt;
  const ref = poly.points[poly.points.length - 1];
  const ang = Math.round(Math.atan2(pt[1] - ref[1], pt[0] - ref[0]) / (Math.PI / 4)) * (Math.PI / 4);
  const len = Math.hypot(pt[0] - ref[0], pt[1] - ref[1]);
  return [ref[0] + Math.cos(ang) * len, ref[1] + Math.sin(ang) * len];
}

function drawPolyPreview(cursor) {
  const p = view.pages[poly?.page];
  if (!p?.preview) return;
  const s = view.settings;
  const pts = cursor ? [...poly.points, cursor] : poly.points;
  const area = poly.kind === 'area';
  const d = pts.map((q, k) => `${k ? 'L' : 'M'}${q[0]} ${q[1]}`).join(' ') + (area && pts.length > 2 ? ' Z' : '');
  const shapes = [svg('path', { d, fill: area ? (s.fill || s.color) : 'none', 'fill-opacity': 0.15, stroke: s.color, 'stroke-width': Math.min(s.width, 3), 'stroke-dasharray': `${4 / view.scale} ${3 / view.scale}` })];
  for (const q of poly.points) shapes.push(svg('circle', { cx: q[0], cy: q[1], r: 3 / view.scale, fill: s.color }));
  if (pts.length >= (area ? 3 : 2)) {
    const last = pts[pts.length - 1];
    const t = svg('text', { transform: `matrix(1 0 0 -1 ${last[0] + 8 / view.scale} ${last[1] + 8 / view.scale})`, 'font-size': 11 / view.scale, fill: s.color, 'font-family': 'Noto Sans JP' });
    t.textContent = measureValue({ type: 'measure', kind: poly.kind, points: pts, scale: currentScale() }).text;
    shapes.push(t);
  }
  p.preview.replaceChildren(...shapes);
}

/** 入力中の折れ線・多角形を確定する（Enter・ダブルクリック） */
export function finishPoly() {
  if (!poly) return false;
  const { page, kind, points } = poly;
  poly = null;
  view.pages[page]?.preview?.replaceChildren();
  // ダブルクリックで同じ位置に 2 点入ったときは 1 つにする
  const pts = points.filter((q, k) => !k || Math.hypot(q[0] - points[k - 1][0], q[1] - points[k - 1][1]) > 0.5);
  if (pts.length >= (kind === 'area' ? 3 : 2)) addMeasure(page, kind, pts);
  else toast(kind === 'area' ? '面積は 3 点以上クリックしてから確定してください' : '2 点以上クリックしてから確定してください');
  return true;
}

/** 入力中の折れ線・多角形をやめる（Esc） */
export function cancelPoly() {
  if (!poly) return false;
  view.pages[poly.page]?.preview?.replaceChildren();
  poly = null;
  return true;
}

/** 最後に置いた頂点を取り消す（Backspace） */
export function undoPolyPoint() {
  if (!poly) return false;
  poly.points.pop();
  if (!poly.points.length) return cancelPoly();
  drawPolyPreview(null);
  return true;
}

export const polyActive = () => !!poly;

/** キャリブレーション：距離ツールで基準線を引いてもらう */
export function startCalibration() {
  setTool('measureDist');
  if (view.tool !== 'measureDist') return false;
  view.calibrating = true;
  toast('長さが分かっている線（図面の寸法線など）の両端をドラッグしてください。Esc で中止します。');
  return true;
}

/** 手のひら：ページの上をドラッグして画面を動かす（入力欄・リンクの上は除く。リンクは自分で処理する） */
function onPagePointerDown(ev) {
  if (view.tool !== 'hand' || ev.button !== 0) return;
  // 入力できる欄とリンクの上はドラッグしない（入力できない欄の上は画面を動かせる）
  if (ev.target.closest?.('.pdf-input:not(:disabled), .pdf-check:not(:disabled), .pdf-link')) return;
  // preventDefault するとフォーカスが移らないので、入力中の欄は先に外して値を確定させる
  blurFormField();
  ev.preventDefault();
  document.body.classList.add('panning');
  startDrag(ev, { kind: 'pan', x: ev.clientX, y: ev.clientY, sl: viewerEl.scrollLeft, st: viewerEl.scrollTop });
}

/** 入力中のフォームの欄からフォーカスを外す（change が発生して値が確定する） */
function blurFormField() {
  const a = document.activeElement;
  if (a?.matches?.('.pdf-input, .pdf-check')) a.blur();
}

// ---------------------------------------------------------------- 手のひらの慣性スクロール

/**
 * 手のひらでドラッグして離したとき、その速さのまま滑らせて、だんだん止める（スマートフォンのような動き）。
 * 時定数 325ms で減速する。つかみ直す・ホイール・キー操作で止める
 */
const MOMENTUM_TAU = 325;
let momentum = null;
let stoppedByPress = 0; // 滑っている途中に押して止めた時刻
export function stopMomentum() {
  if (momentum) { cancelAnimationFrame(momentum.frame); momentum = null; }
}
function startMomentum(vx, vy) {
  stopMomentum();
  const m = { vx, vy, last: performance.now(), frame: 0 };
  const step = (t) => {
    if (momentum !== m) return;
    const dt = Math.max(0, Math.min(50, t - m.last));
    m.last = t;
    const l0 = viewerEl.scrollLeft, t0 = viewerEl.scrollTop;
    viewerEl.scrollLeft = l0 - m.vx * dt;
    viewerEl.scrollTop = t0 - m.vy * dt;
    // 端に着いた向きは止める
    if (viewerEl.scrollLeft === l0) m.vx = 0;
    if (viewerEl.scrollTop === t0) m.vy = 0;
    const k = Math.exp(-dt / MOMENTUM_TAU);
    m.vx *= k;
    m.vy *= k;
    if (Math.hypot(m.vx, m.vy) < 0.02) { momentum = null; return; }
    m.frame = requestAnimationFrame(step);
  };
  momentum = m;
  m.frame = requestAnimationFrame(step);
}
/** ドラッグ中の動きを記録（直近 100ms） */
function notePan(ev) {
  const now = performance.now();
  drag.samples ||= [];
  drag.samples.push([now, ev.clientX, ev.clientY]);
  drag.pointerType = ev.pointerType;
  while (drag.samples.length > 2 && now - drag.samples[0][0] > 100) drag.samples.shift();
}
/** 離したときの速さ（px/ms）。止めてから離したときは 0 */
function panVelocity(d) {
  const s = d.samples || [];
  if (s.length < 2) return [0, 0];
  const now = performance.now();
  const [t1, x1, y1] = s[s.length - 1];
  if (now - t1 > 60) return [0, 0];
  const [t0, x0, y0] = s[0];
  const dt = Math.max(8, t1 - t0);
  return [(x1 - x0) / dt, (y1 - y0) / dt];
}

function startDrag(ev, d) {
  stopMomentum();
  drag = d;
  const target = ev.target;
  try { target.setPointerCapture?.(ev.pointerId); } catch { /* 無視 */ }
  const move = (e) => onDragMove(e);
  const up = (e) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    onDragEnd(e);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

/** 頂点を動かすとき、Shift で隣の頂点から 45° 単位にそろえる */
function constrainVertex(o, k, pt, shift) {
  if (!shift) return pt;
  const ref = o.points[k - 1] || o.points[k + 1];
  if (!ref) return pt;
  const dx = pt[0] - ref[0], dy = pt[1] - ref[1];
  const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  const len = Math.hypot(dx, dy);
  return [ref[0] + Math.cos(ang) * len, ref[1] + Math.sin(ang) * len];
}

function constrain(start, pt, shift) {
  if (!shift) return pt;
  const dx = pt[0] - start[0], dy = pt[1] - start[1];
  if (view.tool === 'line' || view.tool === 'arrow' || view.tool === 'measureDist') {
    const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    const len = Math.hypot(dx, dy);
    return [start[0] + Math.cos(ang) * len, start[1] + Math.sin(ang) * len];
  }
  const s = Math.max(Math.abs(dx), Math.abs(dy));
  return [start[0] + Math.sign(dx || 1) * s, start[1] + Math.sign(dy || 1) * s];
}

function onDragMove(ev) {
  if (!drag) return;
  if (drag.kind === 'pan') {
    notePan(ev);
    viewerEl.scrollLeft = drag.sl - (ev.clientX - drag.x);
    viewerEl.scrollTop = drag.st - (ev.clientY - drag.y);
    return;
  }
  const i = drag.page;
  const p = view.pages[i];
  if (!p?.vp1) return;
  const pt = pdfPoint(i, ev);
  if (drag.kind === 'move') {
    // 動かしている注釈の要素だけを平行移動して見せる（確定はドロップ時）
    drag.dx = pt[0] - drag.start[0];
    drag.dy = pt[1] - drag.start[1];
    drag.el?.setAttribute('transform', `translate(${drag.dx} ${drag.dy})`);
    if (drag.sel) {
      const [a, b, c, d] = p.vp1.transform;
      drag.sel.setAttribute('transform', `translate(${a * drag.dx + c * drag.dy} ${b * drag.dx + d * drag.dy})`);
    }
  } else if (drag.kind === 'label') {
    const o = drag.gesture?.obj;
    if (!o) return;
    o.labelOffset = [drag.orig[0] + pt[0] - drag.start[0], drag.orig[1] + pt[1] - drag.start[1]];
    o.rect = objBounds(o);
    drag.changed = true;
    const old = p.objGroup?.querySelector(`[data-id="${o.id}"]`);
    if (old) old.replaceWith(drawShape(o));
    p.overlay.querySelector('.selection')?.replaceWith(selectionGroup(p, o));
  } else if (drag.kind === 'vertex') {
    const o = drag.gesture?.obj;
    if (!o) return;
    o.points[drag.k] = constrainVertex(o, drag.k, pt, ev.shiftKey);
    o.rect = objBounds(o);
    drag.changed = true;
    const old = p.objGroup?.querySelector(`[data-id="${o.id}"]`);
    if (old) old.replaceWith(drawShape(o));
    p.overlay.querySelector('.selection')?.replaceWith(selectionGroup(p, o));
  } else if (drag.kind === 'resize') {
    const o = drag.gesture?.obj;
    if (!o) return;
    const [ax, ay] = drag.anchor;
    // 外接矩形の大きさから、回転前の枠の大きさを求める
    const W = Math.max(4, Math.abs(pt[0] - ax)), H = Math.max(4, Math.abs(pt[1] - ay));
    const a = (((o.angle || 0) % 360) + 360) % 360;
    const ob = objBounds(drag.orig);
    const [ow, oh] = [drag.orig.rect[2], drag.orig.rect[3]];
    let w, h;
    if (a % 180 === 0) { w = W; h = H; }
    else if (a % 180 === 90) { w = H; h = W; }
    else { const k = Math.max(W / ob[2], H / ob[3]); w = ow * k; h = oh * k; }
    if (o.type === 'image' && o.ratio) h = w * o.ratio;
    w = Math.max(4, w);
    h = Math.max(o.type === 'text' ? 8 : 4, h);
    const tmp = { ...o, rect: [0, 0, w, h] };
    const [, , bw, bh] = objBounds(tmp);
    const bx = pt[0] < ax ? ax - bw : ax;
    const by = pt[1] < ay ? ay - bh : ay;
    o.rect = [bx + bw / 2 - w / 2, by + bh / 2 - h / 2, w, h];
    drag.changed = true;
    const old = p.objGroup?.querySelector(`[data-id="${o.id}"]`);
    if (old) old.replaceWith(drawShape(o));
    p.overlay.querySelector('.selection')?.replaceWith(selectionGroup(p, o));
  } else if (drag.kind === 'create') {
    drag.cur = constrain(drag.start, pt, ev.shiftKey);
    if (view.tool === 'ink') drag.points.push(pt);
    drawPreview(i);
  }
}

function drawPreview(i) {
  const g = view.pages[i].preview;
  const s = view.settings;
  const [x1, y1] = drag.start, [x2, y2] = drag.cur;
  const r = { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
  const t = view.tool;
  if (t === 'ink') {
    // 線は伸ばすだけ（毎回作り直さない）
    if (!drag.path) {
      drag.path = svg('path', { fill: 'none', stroke: s.color, 'stroke-width': s.width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: s.opacity });
      drag.d = `M${drag.points[0][0]} ${drag.points[0][1]}`;
      g.replaceChildren(drag.path);
    }
    const q = drag.points[drag.points.length - 1];
    drag.d += ` L${q[0]} ${q[1]}`;
    drag.path.setAttribute('d', drag.d);
    return;
  }
  let shape;
  if (t === 'measureDist') {
    const tmp = { type: 'measure', kind: 'distance', points: [drag.start, drag.cur], scale: currentScale() };
    const lbl = svg('text', { transform: `matrix(1 0 0 -1 ${x2 + 8 / view.scale} ${y2 + 8 / view.scale})`, 'font-size': 11 / view.scale, fill: s.color, 'font-family': 'Noto Sans JP' });
    lbl.textContent = view.calibrating ? `基準線 ${measureValue(tmp).text}` : measureValue(tmp).text;
    g.replaceChildren(svg('line', { x1, y1, x2, y2, stroke: view.calibrating ? '#e8590c' : s.color, 'stroke-width': Math.min(s.width, 3), 'stroke-dasharray': view.calibrating ? `${4 / view.scale} ${3 / view.scale}` : null }), lbl);
    return;
  }
  if (t === 'line' || t === 'arrow') {
    shape = svg('line', { x1, y1, x2, y2, stroke: s.color, 'stroke-width': s.width, opacity: s.opacity });
  } else if (t === 'ellipse') {
    shape = svg('ellipse', { cx: r.x + r.w / 2, cy: r.y + r.h / 2, rx: r.w / 2, ry: r.h / 2, fill: s.fill || 'none', stroke: s.color, 'stroke-width': s.width, opacity: s.opacity });
  } else if (t === 'rect') {
    shape = svg('rect', { x: r.x, y: r.y, width: r.w, height: r.h, fill: s.fill || 'none', stroke: s.color, 'stroke-width': s.width, opacity: s.opacity });
  } else if (t === 'redact') {
    shape = svg('rect', { x: r.x, y: r.y, width: r.w, height: r.h, fill: 'rgba(0,0,0,0.35)', stroke: '#e03131', 'stroke-width': 1.5 });
  } else {
    shape = svg('rect', { x: r.x, y: r.y, width: r.w, height: r.h, fill: 'rgba(28,126,214,0.08)', stroke: '#1c7ed6', 'stroke-width': 1.2 / view.scale, 'stroke-dasharray': `${5 / view.scale} ${3 / view.scale}` });
  }
  g.replaceChildren(shape);
}

async function onDragEnd(ev) {
  const d = drag;
  drag = null;
  document.body.classList.remove('panning');
  if (!d) return;
  if (d.kind === 'pan') {
    // マウスだけ。タッチ・ペンはブラウザ自身の慣性があるので二重にしない。中断（pointercancel）のときも滑らせない
    if (ev?.type === 'pointercancel' || (d.pointerType && d.pointerType !== 'mouse')) return;
    const [vx, vy] = panVelocity(d);
    // ある程度の速さで離したときだけ滑らせる（上限 6px/ms）
    const sp = Math.hypot(vx, vy);
    if (sp > 0.25) { const f = Math.min(1, 6 / sp); startMomentum(vx * f, vy * f); }
    return;
  }
  if (d.kind === 'move') {
    const moved = Math.abs(d.dx) > 0.01 || Math.abs(d.dy) > 0.01;
    if (moved && d.gesture) translateObject(d.gesture.obj, d.dx, d.dy);
    endGesture(d.gesture, moved);
    if (!moved && view.pages[d.page]?.mounted) drawOverlay(d.page);
    if (moved) emit('selection-changed', view.selected);
    return;
  }
  if (d.kind === 'resize' || d.kind === 'vertex' || d.kind === 'label') {
    if (d.kind === 'vertex' && d.changed) {
      const o = d.gesture.obj;
      o.contents = `${measureValue(o).label}: ${measureValue(o).text}`;
    }
    endGesture(d.gesture, d.changed);
    if (d.changed) emit('selection-changed', view.selected);
    else if (view.pages[d.page]?.mounted) drawOverlay(d.page);
    return;
  }
  if (d.kind !== 'create') return;
  const i = d.page;
  view.pages[i].preview?.replaceChildren();
  const s = view.settings;
  const [x1, y1] = d.start, [x2, y2] = d.cur;
  const rect = [Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1)];
  const small = rect[2] < 5 && rect[3] < 5;
  const t = view.tool;
  const base = { color: s.color, width: s.width, opacity: s.opacity };

  switch (t) {
    case 'ink': {
      if (d.points.length < 2) return;
      // 同じ設定で続けて描いた線は 1 つの手書きにまとめる
      const prev = lastInk && lastInk.page === i && Date.now() - lastInk.time < 1500 ? findObject(lastInk.id) : null;
      if (prev && prev.obj.color === s.color && prev.obj.width === s.width && prev.obj.opacity === s.opacity) {
        updateObject(lastInk.id, (o) => {
          o.strokes.push(d.points);
          o.rect = boundsOfPoints(o.strokes.flat(), o.width);
        });
        lastInk.time = Date.now();
      } else {
        const o = addObject(i, { type: 'ink', ...base, strokes: [d.points], rect: boundsOfPoints(d.points, s.width) });
        lastInk = { id: o.id, page: i, time: Date.now() };
      }
      break;
    }
    case 'rect':
    case 'ellipse': {
      const r = small ? [x1, y1 - 60, 100, 60] : rect;
      addObject(i, { type: t, ...base, fill: s.fill || null, rect: r }, { selectIt: small });
      break;
    }
    case 'line':
    case 'arrow':
      if (Math.hypot(x2 - x1, y2 - y1) < 4) return;
      addObject(i, { type: t, ...base, points: [d.start, d.cur], rect: boundsOfPoints([d.start, d.cur], 0) });
      break;
    case 'text': {
      const text = await promptText('テキストボックス', '', { multiline: true, message: '入力した文字を配置します。' });
      if (!text) return;
      await document.fonts.load(`${s.bold ? 700 : 400} 16px "Noto Sans JP"`).catch(() => {});
      const size = s.fontSize;
      const rot = pageRotation(i);
      // 回転したページでは、画面で見た幅・高さが PDF 上の高さ・幅になる
      const sideways = rot % 180 === 90;
      const dragW = sideways ? rect[3] : rect[2], dragH = sideways ? rect[2] : rect[3];
      const width = small ? Math.min(420, measureWidth(text, size, s.bold) + 10) : dragW;
      const o = { type: 'text', text, fontSize: size, fontColor: s.fontColor, bold: s.bold, fill: s.fill || null, opacity: s.opacity, angle: rot, rect: [0, 0, width, 0] };
      const hh = Math.max(textBoxHeight(o), small ? 0 : dragH);
      if (!rot) {
        const top = small ? y1 : rect[1] + rect[3];
        o.rect = [small ? x1 : rect[0], top - hh, width, hh];
      } else {
        // 回転したページでは、ドラッグした範囲（またはクリック位置）の中心に置く
        const cx = small ? x1 : rect[0] + rect[2] / 2, cy = small ? y1 : rect[1] + rect[3] / 2;
        o.rect = [cx - width / 2, cy - hh / 2, width, hh];
      }
      addObject(i, o, { selectIt: true });
      setTool('select');
      break;
    }
    case 'measureDist': {
      if (Math.hypot(x2 - x1, y2 - y1) < 2) return;
      if (view.calibrating) {
        view.calibrating = false;
        emit('calibrate', { page: i, points: [d.start, d.cur] });
        return;
      }
      addMeasure(i, 'distance', [d.start, d.cur]);
      break;
    }
    case 'redact':
      if (!small) addObject(i, { type: 'redact', rect });
      break;
    case 'crop':
      if (!small) emit('crop-request', { page: i, rect });
      break;
    case 'link':
      if (!small) createLink(i, rect);
      break;
    case 'formText':
    case 'formCheck':
    case 'formChoice':
      emit('form-field-request', { page: i, rect: small ? null : rect, at: d.start, kind: t });
      break;
  }
}

/** 文字選択からハイライト等を作る */
function onMarkupMouseUp() {
  if (!MARKUP.has(view.tool)) return;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.toString().trim()) return;
  const rects = [];
  for (let r = 0; r < sel.rangeCount; r++) for (const cr of sel.getRangeAt(r).getClientRects()) if (cr.width >= 1 && cr.height >= 1) rects.push(cr);
  // 文字以外（行末の余白など）の極端に背の高い矩形は除く
  const hs = rects.map((r) => r.height).sort((a, b) => a - b);
  const median = hs[hs.length >> 1] || 0;
  const byPage = new Map();
  for (const cr of rects) {
    if (median && cr.height > median * 2.5) continue;
    const cx = cr.left + cr.width / 2, cy = cr.top + cr.height / 2;
    const i = view.pages.findIndex((p) => p.mounted && (() => { const b = p.div.getBoundingClientRect(); return cx >= b.left && cx <= b.right && cy >= b.top && cy <= b.bottom; })());
    if (i < 0) continue;
    const p = view.pages[i];
    const b = p.div.getBoundingClientRect();
    const s = view.scale;
    const [ax, ay] = p.vp1.convertToPdfPoint((cr.left - b.left) / s, (cr.top - b.top) / s);
    const [bx, by] = p.vp1.convertToPdfPoint((cr.right - b.left) / s, (cr.bottom - b.top) / s);
    const q = [Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay)];
    (byPage.get(i) || byPage.set(i, []).get(i)).push(q);
  }
  const text = sel.toString();
  sel.removeAllRanges();
  const s = view.settings;
  for (const [i, quads] of byPage) {
    const merged = mergeQuads(quads);
    const rect = boundsOfPoints(merged.flatMap(([x, y, w, h]) => [[x, y], [x + w, y + h]]), 0);
    addObject(i, { type: view.tool, quads: merged, rect, color: view.tool === 'highlight' ? s.highlight : s.color, opacity: view.tool === 'highlight' ? 0.45 : s.opacity, contents: text });
  }
}

/** 同じ行の矩形をつなげる */
function mergeQuads(qs) {
  const sorted = [...qs].sort((a, b) => (b[1] - a[1]) || (a[0] - b[0]));
  const out = [];
  for (const q of sorted) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[1] - q[1]) < last[3] * 0.5 && Math.abs(last[3] - q[3]) < last[3] * 0.6 && q[0] <= last[0] + last[2] + last[3]) {
      const x = Math.min(last[0], q[0]), y = Math.min(last[1], q[1]);
      const r = Math.max(last[0] + last[2], q[0] + q[2]), t = Math.max(last[1] + last[3], q[1] + q[3]);
      out[out.length - 1] = [x, y, r - x, t - y];
    } else out.push([...q]);
  }
  return out;
}

// ---------------------------------------------------------------- 個別の作成処理

async function editExistingText(i, pt) {
  const { items } = await pageText(i);
  const hit = items.find((it) => !it.vertical && it.str.trim() && pt[0] >= it.rect[0] - 1 && pt[0] <= it.rect[0] + it.rect[2] + 1 && pt[1] >= it.rect[1] - 1 && pt[1] <= it.rect[1] + it.rect[3] + 1);
  if (!hit) { toast('この位置に編集できる文字が見つかりません'); return; }
  const text = await promptText('テキストを編集', hit.str, { message: '元の文字は白で覆われ、新しい文字が同じ位置に配置されます。' });
  if (text == null || text === hit.str) return;
  await document.fonts.load('16px "Noto Sans JP"').catch(() => {});
  const size = +(hit.fontSize * 0.98).toFixed(2);
  const width = Math.max(hit.rect[2], measureWidth(text, size) + 2);
  addObject(i, { type: 'edit', text, original: hit.str, fontSize: size, fontColor: '#000000', rect: [hit.rect[0] - 1, hit.rect[1], width + 2, hit.rect[3]] }, { selectIt: true });
}

/** 大きな写真はそのまま貼ると重いので、長辺 2000px までに縮める */
async function imageToDataUrl(bytes, name) {
  const png = /\.png$/i.test(name);
  const blob = new Blob([bytes], { type: png ? 'image/png' : 'image/jpeg' });
  const bmp = await createImageBitmap(blob);
  const k = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
  if (k === 1 && bytes.length < 3 * 1024 * 1024) {
    bmp.close();
    return new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });
  }
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  const url = c.toDataURL(png ? 'image/png' : 'image/jpeg', 0.9);
  c.width = 0;
  return url;
}

async function placeImageFromFile(i, pt) {
  const files = await window.api.openDialog({ title: '配置する画像', filters: [{ name: '画像', extensions: ['png', 'jpg', 'jpeg'] }] });
  if (!files.length) return;
  try {
    placeImage(i, pt, await imageToDataUrl(files[0].bytes, files[0].name), null, '画像');
  } catch (e) {
    toast(`画像を読み込めませんでした: ${e.message}`);
  }
}

export function placeImage(i, pt, src, width, label) {
  const img = new Image();
  img.onload = () => {
    const p = view.pages[i];
    const pageW = Math.abs(p.vp1.viewBox[2] - p.vp1.viewBox[0]);
    const natural = img.naturalWidth * 0.5;
    const w = Math.min(width || natural, pageW * 0.6);
    const ratio = img.naturalHeight / img.naturalWidth;
    const h = w * ratio;
    addObject(i, { type: 'image', src, ratio, angle: pageRotation(i), rect: [pt[0] - w / 2, pt[1] - h / 2, w, h], opacity: view.settings.opacity, contents: label }, { selectIt: true });
    setTool('select');
  };
  img.src = src;
}

async function createLink(i, rect, existing = null) {
  const r = await ask({
    title: 'リンク', message: 'URL（https://…）またはページ番号を入力してください。',
    fields: [{ key: 't', label: 'リンク先', value: existing ? (existing.url || (existing.page != null ? existing.page + 1 : '')) : '' }]
  });
  if (!r || !String(r.t).trim()) return;
  const t = String(r.t).trim();
  let props;
  if (/^\d+$/.test(t)) {
    const n = +t;
    if (n < 1 || n > state.pageIds.length) { toast(`ページ番号は 1〜${state.pageIds.length} で指定してください`); return; }
    props = { page: n - 1, url: null };
  } else {
    props = { url: /^(https?:|mailto:)/i.test(t) ? t : `https://${t}`, page: null };
  }
  if (existing) updateObject(existing.id, (o) => Object.assign(o, props));
  else addObject(i, { type: 'link', rect, ...props, contents: t });
}

export async function editObjectContents(id) {
  const f = findObject(id);
  if (!f) return;
  const o = f.obj;
  if (o.type === 'text' || o.type === 'edit') {
    const text = await promptText(o.type === 'edit' ? 'テキストを編集' : 'テキストボックス', o.text, { multiline: o.type === 'text' });
    if (text == null) return;
    updateObject(id, (x) => {
      x.text = text;
      if (x.type === 'edit') x.rect[2] = Math.max(x.rect[2], measureWidth(text, x.fontSize, x.bold) + 4);
      const h = textBoxHeight(x);
      if (x.type === 'text' && h > x.rect[3]) { x.rect[1] -= h - x.rect[3]; x.rect[3] = h; }
    });
  } else if (o.type === 'link') {
    createLink(f.page, o.rect, o);
  } else {
    const text = await promptText('コメント', o.contents || '', { multiline: true });
    if (text != null) updateObject(id, (x) => { x.contents = text; });
  }
}

/** 描画待ちがなくなるまで待つ（テスト・計測用） */
export function whenIdle() {
  return new Promise((resolve) => {
    const check = () => (queue.size || active || updateFrame ? setTimeout(check, 30) : resolve());
    check();
  });
}

/** 計測用：いま保持しているページ画像の数と画素数 */
export function renderStats() {
  let canvases = 0, pixels = 0;
  for (const p of view.pages) if (p.canvas) { canvases++; pixels += p.canvas.width * p.canvas.height; }
  return { mounted: view.pages.filter((p) => p.mounted).length, canvases, pixels, scan: perf.scan || 0, pdfjs: perf.pdfjs || 0 };
}
