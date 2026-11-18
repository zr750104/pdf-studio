// 自動テスト（`electron . --selftest`）。主要機能を UI 経由で操作し、結果とスクリーンショットを保存する
import {
  state, PL, pdfjsLib, PDFJS_OPTS, openBytes, buildOutput, jpFont, pageText, undo, redo, changeStructure, insertFromSources,
  rotatePages, insertBlank, duplicatePages, can, beginGesture, endGesture, findObject, measureValue, refreshFromLib
} from './doc.js';
import { view, setDetailThreshold, addObject, removeObject, setTool, buildPages, scrollToPage, currentPage, stepPage, setLayout, subRange, whenIdle, zoomTo, clampScale, MAX_SCALE, MIN_SCALE, renderStats, placeImage, select, rotateSelected, selectedDisplayAngle, pageRotation } from './viewer.js';
import { textStamp, hanko, chooseStamp } from './stamps.js';
import * as F from './features.js';
import { runBatch, batchProcess } from './batch.js';
import { setLang, getLang, missing, t as tr } from './i18n.js';
import { canvasToBytes } from './util.js';

const api = window.api;
let failures = 0;
const log = (s) => api.selftest('log', s);
const check = (ok, name) => { if (!ok) failures++; return log(`${ok ? '✅' : '❌'} ${name}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const answer = (...a) => { window.__askQueue = window.__askQueue || []; window.__askQueue.push(...a); };
const queue = (kind, value) => api.selftest('queue', { kind, value });
const shot = async (name) => { await sleep(100); await whenIdle(); await sleep(300); await api.selftest('shot', name); };

async function makeSample() {
  const { PDFDocument, rgb } = PL;
  const doc = await PDFDocument.create();
  const font = await jpFont(doc);
  for (let p = 1; p <= 4; p++) {
    const page = doc.addPage([595.28, 841.89]);
    page.drawText(`第${p}章 PDF Studio テスト`, { x: 50, y: 780, size: 20, font, color: rgb(0.1, 0.1, 0.3) });
    for (let i = 0; i < 30; i++) {
      page.drawText(`これは日本語の本文です。The quick brown fox ${i} 機密番号 SECRET-${p}${i}`, { x: 50, y: 740 - i * 22, size: 12, font });
    }
  }
  return doc.save();
}

async function textOf(bytes, password) {
  const pdf = await pdfjsLib.getDocument({ data: bytes.slice ? bytes.slice() : bytes, password, ...PDFJS_OPTS }).promise;
  let t = '';
  const annots = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    t += (await page.getTextContent()).items.map((x) => x.str).join('') + '\n';
    annots.push(...(await page.getAnnotations()));
  }
  const perms = await pdf.getPermissions();
  const n = pdf.numPages;
  pdf.destroy();
  return { text: t, annots, pages: n, perms };
}

/** PDF のすべてのストリームを展開して、ASCII 文字列（16 進表記も含む）が残っていないか調べる */
async function rawContains(bytes, needle) {
  const latin = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 65536) s += String.fromCharCode(...u8.subarray(i, i + 65536)); return s; };
  const hex = Array.from(new TextEncoder().encode(needle), (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  const s = latin(bytes);
  const chunks = [s];
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    let end = s.indexOf('endstream', start);
    if (end < 0) break;
    while (end > start && (s[end - 1] === '\n' || s[end - 1] === '\r')) end--;
    try {
      const ds = new DecompressionStream('deflate');
      const out = await new Response(new Blob([bytes.subarray(start, end)]).stream().pipeThrough(ds)).arrayBuffer();
      chunks.push(latin(new Uint8Array(out)));
    } catch { /* 圧縮されていないストリーム */ }
  }
  return chunks.some((c) => c.includes(needle) || c.toUpperCase().includes(hex));
}

// ---------------------------------------------------------------- 実際のマウス・キー入力での操作テスト

const input = (evs) => api.selftest('input', evs);
const R = Math.round;
// マウスを離した入力がアプリで処理されるまで待つ（固定時間の待ちだと負荷が高いときに失敗する）
let pointerUps = 0;
window.addEventListener('pointerup', () => { pointerUps++; }, true);
async function waitPointerUp(before) {
  for (let k = 0; k < 100 && pointerUps === before; k++) await sleep(20);
  await sleep(30);
}
async function mouseDrag(x1, y1, x2, y2, steps = 10, mods = []) {
  const before = pointerUps;
  const evs = [{ type: 'mouseMove', x: R(x1), y: R(y1) }, { type: 'mouseDown', x: R(x1), y: R(y1), button: 'left', clickCount: 1, modifiers: mods }];
  for (let k = 1; k <= steps; k++) evs.push({ type: 'mouseMove', x: R(x1 + ((x2 - x1) * k) / steps), y: R(y1 + ((y2 - y1) * k) / steps), button: 'left', modifiers: [...mods, 'leftButtonDown'] });
  // 離す前に少し止める（手のひらの慣性スクロールが起きないように。慣性は別に確かめる）
  evs.push({ wait: 120 });
  evs.push({ type: 'mouseUp', x: R(x2), y: R(y2), button: 'left', clickCount: 1, modifiers: mods });
  await input(evs);
  await waitPointerUp(before);
  await sleep(50);
}
async function click(x, y) {
  const before = pointerUps;
  await input([{ type: 'mouseMove', x: R(x), y: R(y) }, { type: 'mouseDown', x: R(x), y: R(y), button: 'left', clickCount: 1 }, { type: 'mouseUp', x: R(x), y: R(y), button: 'left', clickCount: 1 }]);
  await waitPointerUp(before);
  await sleep(50);
}
async function key(keyCode) {
  await input([{ type: 'keyDown', keyCode }, { type: 'char', keyCode }, { type: 'keyUp', keyCode }]);
  await sleep(60);
}
/** 文書を開いたあと、ページ表示の準備が終わるまで待つ */
async function ready() {
  for (let k = 0; k < 500 && (view.pages.length !== state.pageIds.length || !view.pages[0]?.canvas); k++) await sleep(20);
  await whenIdle();
}
/** ページ i の「画面に見えている部分」の中での相対位置（fy は見えている範囲の上端 0〜下端 1） */
const at = (i, fx, fy) => {
  const r = view.pages[i].div.getBoundingClientRect();
  const v = document.getElementById('viewer').getBoundingClientRect();
  const top = Math.max(r.top, v.top + 10), bottom = Math.min(r.bottom, v.bottom - 10);
  return [r.left + r.width * fx, top + (bottom - top) * fy];
};
const centerOf = (el) => { const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
const objs = (i = 0) => state.objects[state.pageIds[i]] || [];

async function uiTests() {
  await openBytes(await makeSample(), { name: 'ui.pdf', askPassword: async () => null });
  await ready();
  const s = view.scale;
  // 矩形をドラッグで描く
  setTool('rect');
  view.settings.fill = '#ffff00';
  await mouseDrag(...at(0, 0.15, 0.35), ...at(0, 0.35, 0.5));
  const rect = objs().find((o) => o.type === 'rect');
  check(rect && Math.abs(rect.rect[2] - 0.2 * 595.28) < 3, `マウスで矩形を描く (${rect?.rect.map(Math.round)})`);
  view.settings.fill = '';
  // 選択ツールでドラッグして移動
  setTool('select');
  const [cx, cy] = centerOf(document.querySelector(`.obj[data-id="${rect.id}"]`));
  await mouseDrag(cx, cy, cx + 60, cy + 30);
  const moved = objs().find((o) => o.id === rect.id);
  check(Math.abs(moved.rect[0] - (rect.rect[0] + 60 / s)) < 1.5 && Math.abs(moved.rect[1] - (rect.rect[1] - 30 / s)) < 1.5, 'ドラッグで移動');
  check(view.selected === rect.id, 'クリックで選択');
  // 何もない所をクリックすると選択解除（以前は解除されなかった）
  await click(...at(0, 0.03, 0.9));
  check(view.selected === null, '空いている所をクリックして選択解除');
  // 右下のハンドルでサイズ変更
  await click(...centerOf(document.querySelector(`.obj[data-id="${rect.id}"]`)));
  const [hx, hy] = centerOf(document.querySelector('.handle.h-se'));
  await mouseDrag(hx, hy, hx + 40, hy + 20);
  const resized = objs().find((o) => o.id === rect.id);
  check(Math.abs(resized.rect[2] - (moved.rect[2] + 40 / s)) < 1.5, 'ハンドルでサイズ変更');
  await undo();
  check(Math.abs(objs().find((o) => o.id === rect.id).rect[2] - moved.rect[2]) < 0.01, 'サイズ変更の取り消し');
  // Delete キーで削除
  await click(...centerOf(document.querySelector(`.obj[data-id="${rect.id}"]`)));
  await input([{ type: 'keyDown', keyCode: 'Delete' }, { type: 'keyUp', keyCode: 'Delete' }]);
  await sleep(80);
  check(!objs().some((o) => o.id === rect.id), 'Delete キーで削除');
  // 文字をドラッグしてハイライト
  setTool('highlight');
  const span = [...view.pages[0].div.querySelectorAll('.textLayer span')].find((x) => x.textContent.includes('quick brown fox 5'));
  const sr = span.getBoundingClientRect();
  await mouseDrag(sr.left + 2, sr.top + sr.height / 2, sr.right - 2, sr.top + sr.height / 2, 12);
  check(objs().some((o) => o.type === 'highlight'), 'マウスで文字を選んでハイライト');
  // 手書き
  setTool('ink');
  const [ix, iy] = at(0, 0.2, 0.8);
  await input([{ type: 'mouseMove', x: R(ix), y: R(iy) }, { type: 'mouseDown', x: R(ix), y: R(iy), button: 'left', clickCount: 1 },
    ...[...Array(12).keys()].map((k) => ({ type: 'mouseMove', x: R(ix + k * 12), y: R(iy + (k % 2 ? 15 : -15)), button: 'left', modifiers: ['leftButtonDown'] })),
    { type: 'mouseUp', x: R(ix + 132), y: R(iy), button: 'left', clickCount: 1 }]);
  await sleep(80);
  const ink = objs().find((o) => o.type === 'ink');
  check(ink && ink.strokes[0].length >= 10, 'マウスで手書き');
  // 手のひらツールでスクロール
  setTool('hand');
  const viewerEl = document.getElementById('viewer');
  const st0 = viewerEl.scrollTop;
  await mouseDrag(...at(0, 0.5, 0.8), ...at(0, 0.5, 0.3));
  check(viewerEl.scrollTop > st0 + 50, '手のひらツールでスクロール');
  // 手のひらで勢いよく動かして離すと、離したあとも滑って、だんだん止まる（慣性スクロール）
  {
    viewerEl.scrollTop = 0;
    await sleep(100);
    const [fx, fy1] = at(0, 0.5, 0.85), [, fy2] = at(0, 0.5, 0.35);
    const before = pointerUps;
    const evs = [{ type: 'mouseMove', x: R(fx), y: R(fy1) }, { type: 'mouseDown', x: R(fx), y: R(fy1), button: 'left', clickCount: 1 }];
    for (let k = 1; k <= 8; k++) evs.push({ type: 'mouseMove', x: R(fx), y: R(fy1 + ((fy2 - fy1) * k) / 8), button: 'left', modifiers: ['leftButtonDown'] });
    evs.push({ type: 'mouseUp', x: R(fx), y: R(fy2), button: 'left', clickCount: 1 });
    await input(evs);
    await waitPointerUp(before);
    const atUp = viewerEl.scrollTop;
    await sleep(250);
    const mid = viewerEl.scrollTop;
    await sleep(2600);
    const end = viewerEl.scrollTop;
    await sleep(300);
    check(mid > atUp + 30 && end > mid && Math.abs(viewerEl.scrollTop - end) < 1, `手のひらで払うと滑って止まる (離したとき ${Math.round(atUp)} → 0.25 秒後 ${Math.round(mid)} → 止まった位置 ${Math.round(end)})`);
    // つかみ直すと止まる
    viewerEl.scrollTop = 0;
    await sleep(100);
    await input(evs);
    await sleep(80);
    await click(...at(currentPage(), 0.5, 0.5));
    const stopAt = viewerEl.scrollTop;
    await sleep(300);
    check(Math.abs(viewerEl.scrollTop - stopAt) < 2, `滑っている途中にクリックすると止まる (${Math.round(stopAt)} → ${Math.round(viewerEl.scrollTop)})`);
  }
  // Ctrl + ホイールで拡大
  setTool('select');
  const sc0 = view.scale;
  const [wx, wy] = centerOf(viewerEl);
  await input([{ type: 'mouseWheel', x: R(wx), y: R(wy), deltaX: 0, deltaY: 120, wheelTicksY: 1, modifiers: ['control'], canScroll: true }]);
  await sleep(150);
  check(view.scale > sc0, `Ctrl + ホイールで拡大 (${sc0.toFixed(2)} → ${view.scale.toFixed(2)})`);
  // キーでツール切り替え・Esc
  await key('r');
  check(view.tool === 'rect', 'R キーで矩形ツール');
  await key('Escape');
  check(view.tool === 'hand', 'Esc で既定のツール（手のひら）に戻る');
  await shot('00_ui');
}

/** 回転したページ（横向きスキャンなど）にスタンプ・テキストを置いたとき正立するか */
async function rotationTests() {
  const { PDFDocument, degrees } = PL;
  const d = await PDFDocument.load(await makeSample());
  d.getPage(0).setRotation(degrees(90));
  await openBytes(await d.save(), { name: 'rot.pdf', askPassword: async () => null });
  await ready();
  check(pageRotation(0) === 90, '（前提）1 ページ目は 90° 回転したページ');
  // スタンプを置く
  const src = textStamp('承認', '#d6191f', true);
  placeImage(0, [300, 420], src, 110, 'スタンプ');
  await sleep(300);
  const stamp = state.objects[state.pageIds[0]].find((o) => o.type === 'image');
  check(stamp && stamp.angle === 90, `回転したページではスタンプを正立で置く (angle=${stamp?.angle})`);
  check(selectedDisplayAngle() === 0, '画面上の角度は 0°');
  // テキストをドラッグで作る（画面で横長にドラッグ）
  setTool('text');
  answer({ v: '回転ページのテキスト' });
  await mouseDrag(...at(0, 0.3, 0.2), ...at(0, 0.8, 0.3));
  await sleep(200);
  const txt = state.objects[state.pageIds[0]].find((o) => o.type === 'text');
  const drawnW = (at(0, 0.8, 0)[0] - at(0, 0.3, 0)[0]) / view.scale;
  check(txt && txt.angle === 90 && Math.abs(txt.rect[2] - drawnW) < 3, `回転したページでもテキストは画面どおりの向き・幅 (w=${txt?.rect[2].toFixed(1)}, 期待 ${drawnW.toFixed(1)})`);
  await shot('11_rotated_page');
  // あとから回転
  select(stamp.id);
  rotateSelected(90);
  check(selectedDisplayAngle() === 90, '選択した注釈を右に 90° 回転');
  rotateSelected(-45);
  check(selectedDisplayAngle() === 45, '角度を指定して回転（45°）');
  // 保存・再読み込みで角度が残る。注釈の範囲は回転後の外接矩形
  const out = await buildOutput();
  const info = await textOf(out);
  const stampAnnot = info.annots.find((a) => a.subtype === 'Stamp');
  const sw = stampAnnot.rect[2] - stampAnnot.rect[0], sh = stampAnnot.rect[3] - stampAnnot.rect[1];
  check(Math.abs(sw - sh) < 4, `45° 回転したスタンプの注釈範囲は外接矩形 (${sw.toFixed(0)}×${sh.toFixed(0)})`);
  await openBytes(out, { name: 'rot2.pdf', askPassword: async () => null });
  await ready();
  const back = state.objects[state.pageIds[0]].find((o) => o.type === 'image');
  check(back && back.angle === 45, '保存して開き直しても角度が残る');
  // 手書きの回転（点を回す）
  const inkId = addObject(0, { type: 'ink', strokes: [[[100, 100], [200, 100]]], rect: [98, 98, 104, 4], color: '#000', width: 2, opacity: 1 }).id;
  select(inkId);
  rotateSelected(90);
  const ink = state.objects[state.pageIds[0]].find((o) => o.id === inkId);
  check(Math.abs(ink.strokes[0][0][0] - ink.strokes[0][1][0]) < 0.01, '手書きの線も回転できる（横線 → 縦線）');
  // フラット化しても回転が保たれる（画像化して見た目を確認）
  answer({});
  await F.flatten();
  await shot('12_rotated_flattened');
}

async function measureTests() {
  await openBytes(await makeSample(), { name: 'measure.pdf', askPassword: async () => null });
  await ready();
  const ms = () => objs().filter((o) => o.type === 'measure');
  // 距離：画面で水平にドラッグ
  setTool('measureDist');
  const [x1, y1] = at(0, 0.2, 0.3), [x2] = at(0, 0.6, 0.3);
  const scaleBefore = view.scale;
  await mouseDrag(x1, y1, x2, y1);
  await sleep(150);
  const dist = ms()[0];
  check(view.scale === scaleBefore, '操作の途中で倍率が変わらない（スクロールバーの出入りで合わせ直さない）');
  const expectMm = ((x2 - x1) / view.scale) * 25.4 / 72;
  check(dist && dist.kind === 'distance' && Math.abs(measureValue(dist).value - expectMm) < 0.5, `距離の測定 (${dist && measureValue(dist).text}, 期待 ${expectMm.toFixed(1)} mm)`);
  // 面積：3 点クリックして Enter
  setTool('measureArea');
  const pA = at(0, 0.2, 0.5), pB = at(0, 0.5, 0.5), pC = at(0, 0.5, 0.8);
  await click(...pA); await click(...pB); await click(...pC);
  await key('Enter');
  await sleep(150);
  const area = ms().find((o) => o.kind === 'area');
  const w = (pB[0] - pA[0]) / view.scale * 25.4 / 72, h = (pC[1] - pB[1]) / view.scale * 25.4 / 72;
  check(area && area.points.length === 3 && Math.abs(measureValue(area).value - (w * h) / 2) < (w * h) * 0.02, `面積の測定 (${area && measureValue(area).text}, 期待 ${((w * h) / 2).toFixed(1)} mm²)`);
  // 周長：4 点クリック、Backspace で 1 点戻して Enter
  setTool('measurePerim');
  for (const f of [[0.65, 0.4], [0.8, 0.4], [0.8, 0.6], [0.9, 0.9]]) await click(...at(0, ...f));
  await key('Backspace');
  await key('Enter');
  await sleep(150);
  const per = ms().find((o) => o.kind === 'perimeter');
  check(per && per.points.length === 3, `周長の測定（Backspace で頂点を取り消し） (頂点 ${per?.points.length})`);
  await shot('13_measure');
  // 縮尺 1:100（m）を既存の測定にも適用
  answer({ preset: '100', unit: 'm', decimals: 2, all: true });
  await F.measureScale();
  const d2 = ms().find((o) => o.kind === 'distance');
  check(d2.scale.unit === 'm' && Math.abs(measureValue(d2).value - expectMm * 100 / 1000) < 0.05, `縮尺 1:100 を適用 (${measureValue(d2).text})`);
  // 頂点をドラッグして長さを変える
  setTool('select');
  select(d2.id);
  await sleep(100);
  const vtx = document.querySelector('.selection .vertex[data-vertex="1"]');
  const before = measureValue(d2).value;
  const [vx, vy] = centerOf(vtx);
  await mouseDrag(vx, vy, vx + 60, vy);
  await sleep(100);
  const d3 = ms().find((o) => o.id === d2.id);
  check(measureValue(d3).value > before && d3.contents.includes(measureValue(d3).text), `頂点のドラッグで測定値が更新される (${measureValue(d3).text})`);
  await undo();
  check(Math.abs(measureValue(ms().find((o) => o.id === d2.id)).value - before) < 1e-6, '頂点の移動を元に戻せる');
  // キャリブレーション：引いた線を 5 m とする
  F.calibrate();
  answer({ len: 5, unit: 'm', decimals: 2, all: false });
  const [c1, cy] = at(0, 0.3, 0.15), [c2] = at(0, 0.7, 0.15);
  await mouseDrag(c1, cy, c2, cy);
  await sleep(200);
  setTool('measureDist');
  await mouseDrag(c1, cy + 30, c2, cy + 30);
  await sleep(150);
  const cal = ms()[ms().length - 1];
  check(Math.abs(measureValue(cal).value - 5) < 0.05, `キャリブレーション後、同じ長さの線は 5 m (${measureValue(cal).text})`);
  // 保存すると測定注釈（/Measure 付き）として残り、開き直しても編集できる
  const out = await buildOutput();
  const info = await textOf(out);
  const lines = info.annots.filter((a) => a.subtype === 'Line' || a.subtype === 'Polygon' || a.subtype === 'PolyLine');
  check(lines.length >= 4 && info.annots.some((a) => /面積|Area|พื้นที่/.test(a.contentsObj?.str || '')), `測定を PDF 注釈として保存 (${lines.length} 件)`);
  const mdoc = await PL.PDFDocument.load(out, { updateMetadata: false });
  const measures = mdoc.getPages().flatMap((pg) => pg.node.Annots()?.asArray() || []).map((ref) => mdoc.context.lookup(ref)).filter((a) => a.get?.(PL.PDFName.of('Measure')));
  check(measures.length >= 4, `測定の縮尺情報 (/Measure) を書き出す (${measures.length} 件)`);
  await openBytes(out, { name: 'measure2.pdf', askPassword: async () => null });
  await ready();
  check(ms().length === 4 && ms().some((o) => o.kind === 'area'), '開き直しても測定を編集できる');
}

async function tiffTests() {
  const fetchBytes = async (n) => new Uint8Array(await (await fetch(`app://local/test/fixtures/${n}`)).arrayBuffer());
  // 複数ページの TIFF（LZW・カラー / 白黒 / 横長グレー、150 dpi）
  await F.openHere(await fetchBytes('multipage.tif'), null, 'multipage.tif');
  await ready();
  check(state.pageIds.length === 3 && state.name === 'multipage.pdf', `複数ページの TIFF を開く (${state.pageIds.length} ページ, ${state.name})`);
  const { width: w1, height: h1 } = state.lib.getPage(0).getSize(), { width: w3, height: h3 } = state.lib.getPage(2).getSize();
  check(Math.abs(w1 - 1240 * 72 / 150) < 1 && Math.abs(h1 - 1754 * 72 / 150) < 1 && w3 > h3, `解像度からページの大きさを決める (${w1.toFixed(0)}×${h1.toFixed(0)} pt, 3 ページ目は横長)`);
  // サムネイルが全ページ分並ぶ
  await sleep(600);
  const thumbs = [...document.querySelectorAll('#thumbs .thumb canvas, #thumbs .thumb img')].length;
  check(thumbs >= 3, `TIFF の各ページのサムネイルを表示 (${thumbs})`);
  await shot('14_tiff');
  // G4（ファクス形式）
  await F.openHere(await fetchBytes('fax_g4.tif'), null, 'fax_g4.tif');
  await ready();
  check(state.pageIds.length === 2, `CCITT G4 圧縮の TIFF を開く (${state.pageIds.length} ページ)`);
  const ocrLike = await (async () => {
    const page = await state.pdf.getPage(1);
    const vp = page.getViewport({ scale: 0.3 });
    const c = document.createElement('canvas');
    c.width = vp.width; c.height = vp.height;
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let dark = 0;
    for (let k = 0; k < d.length; k += 4) if (d[k] < 100) dark++;
    return dark / (d.length / 4);
  })();
  check(ocrLike > 0.005 && ocrLike < 0.5, `G4 の画像が正しく描かれる（黒い画素 ${(ocrLike * 100).toFixed(1)}%）`);
  // 開いている PDF に TIFF を挿入
  const n = await changeStructure(async (lib) => insertFromSources(lib, 2, [{ name: 'multipage.tif', bytes: await fetchBytes('multipage.tif') }], async () => null));
  await ready();
  check(state.pageIds.length === 5, `TIFF のページを挿入 (${state.pageIds.length} ページ)`);
}

/**
 * TIFF のいろいろな形（白黒反転・複数ストリップ・8 の倍数でない幅・FillOrder=2・グレー・予測付き LZW・カラー）を
 * PDF にしたあと pdf.js で描き、UTIF.js で直接 RGBA にした画素（元の読み込み方式の結果）と比べる
 */
async function tiffPixelTests() {
  const { addTiffPages, lastStats } = await import('./tiff.js');
  const fetchBytes = async (n) => new Uint8Array(await (await fetch(`app://local/test/fixtures/${n}`)).arrayBuffer());
  // [ファイル, 1 ストリップの G4 のページ数, それ以外で直接埋め込むページ数, canvas 経由になるページ数]
  // packbits_fill2（非圧縮系の FillOrder=2）は、直接埋め込みの対象外で canvas 経由になることの確認（ビット順の正しさは従来どおり UTIF 任せ）
  const files = [
    ['tiffvar/g4_single_white0.tif', 1, 0, 0], ['tiffvar/g4_single_black0.tif', 1, 0, 0],
    ['tiffvar/g4_strips_white0.tif', 0, 1, 0], ['tiffvar/raw_w333.tif', 0, 1, 0], ['tiffvar/packbits_fill2.tif', 0, 0, 1],
    ['tiffvar/gray_deflate_white0.tif', 0, 1, 0], ['tiffvar/gray_lzw_pred.tif', 0, 1, 0], ['fax_g4.tif', 0, 2, 0], ['multipage.tif', 0, 2, 1],
    ['tiffvar/jpeg_ycbcr_3.tif', 0, 0, 3]
  ];
  // 既定（1 ストリップの G4 はそのまま埋め込み、ほかはワーカーで展開）／ワーカーなし／G4 も展開して Flate／UTIF だけ／速い G4 が失敗したとき
  const modes = [[{}, ''], [{ workers: 0 }, '（ワーカーなし）'], [{ passthruG4: false }, '（G4 も展開）'], [{ passthruG4: false, fastG4: false, workers: 0 }, '（UTIF）'],
    [{ passthruG4: false, testFailG4: true }, '（速い G4 が失敗 → UTIF、ワーカー）'], [{ passthruG4: false, testFailG4: true, workers: 0 }, '（速い G4 が失敗 → UTIF、画面）']];
  for (const [opts, label] of modes)
  for (const [f, g4single, otherDirect, wantCanvas] of files) {
    const pass = opts.passthruG4 ?? true;
    const wantCcitt = pass ? g4single : 0;
    const wantDirect = otherDirect + (pass ? 0 : g4single);
    const bytes = await fetchBytes(f);
    const lib = await PL.PDFDocument.create();
    await addTiffPages(lib, bytes, opts);
    const info = { ...lastStats.info };
    const pdf = await pdfjsLib.getDocument({ data: await lib.save(), ...PDFJS_OPTS }).promise;
    const UTIF = window.UTIF;
    const buf = bytes.slice().buffer;
    const ifds = UTIF.decode(buf).filter((d) => d.t256 && d.t257);
    const res = [];
    for (const [k, ifd] of ifds.entries()) {
      UTIF.decodeImage(buf, ifd, ifds);
      const ref = UTIF.toRGBA8(ifd);
      const w = ifd.width, h = ifd.height;
      const page = await pdf.getPage(k + 1);
      const vp0 = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: w / vp0.width });
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      const d = c.getContext('2d').getImageData(0, 0, w, h).data;
      const bilevel = (ifd.t258 ? ifd.t258[0] : 1) === 1;
      let bad = 0, diff = 0;
      for (let i = 0; i < d.length; i += 4) {
        const a = (ref[i] + ref[i + 1] + ref[i + 2]) / 3, b = (d[i] + d[i + 1] + d[i + 2]) / 3;
        diff += Math.abs(a - b);
        if ((a < 128) !== (b < 128)) bad++;
      }
      const px = d.length / 4;
      res.push({ bad: bad / px, mean: diff / px, bilevel });
    }
    // 白黒は 1% 未満の画素だけ違ってよい（縁の補間）。グレー・カラーは平均の差で見る（カラーは JPEG）
    // 既定（ワーカーあり）で 2 ページ以上なら、実際にワーカーで展開できていること（ワーカーが動かず黙って画面側で展開していないか）
    const workersOk = (!(info.workers > 0) || info.workerPages > 0)
      // 失敗させたときは、G4 のページがすべて UTIF に戻っていること
      && (!opts.testFailG4 || info.g4fallback === info.g4fast);
    const ok = workersOk && res.length === info.pages && info.ccitt === wantCcitt && info.direct === wantDirect && info.canvas === wantCanvas && res.every((r) => (r.bilevel ? r.bad < 0.01 : r.mean < 6));
    check(ok, `TIFF の画素が元の方式と一致${label} ${f} (${res.map((r) => `${(r.bad * 100).toFixed(2)}%/${r.mean.toFixed(1)}`).join(', ')}; G4 そのまま ${info.ccitt}・G4 高速 ${info.g4fast}・直接 ${info.direct}・canvas ${info.canvas}・ワーカー ${info.workers}／ワーカーで展開 ${info.workerPages})`);
  }
}

/**
 * スキャン画像のページの速い表示：pdf.js で描いた画素と比べる（G4 そのまま／Flate、白黒の向き、回転、幅が 8 の倍数でない画像）。
 * 中身を足したページ（透かしなど）は速い表示の対象から外れること
 */
async function scanFastTests() {
  const { addTiffPages } = await import('./tiff.js');
  const S = await import('./scanpages.js');
  const fetchBytes = async (n) => new Uint8Array(await (await fetch(`app://local/test/fixtures/${n}`)).arrayBuffer());
  const gray = (d, k) => (d[k] + d[k + 1] + d[k + 2]) / 3;
  // region：ページの一部（割合 { x, y, w, h }）だけを比べる（拡大したときの「見えている部分」の描き方）
  async function compare(i, scale, region = null) {
    const page = await state.pdf.getPage(i + 1);
    const vp = page.getViewport({ scale, rotation: page.rotate });
    const g = region || { x: 0, y: 0, w: 1, h: 1 };
    const W = Math.floor(vp.width * g.w), H = Math.floor(vp.height * g.h);
    const a = document.createElement('canvas'); a.width = W; a.height = H;
    const actx = a.getContext('2d'); actx.fillStyle = '#fff'; actx.fillRect(0, 0, W, H);
    await page.render({ canvasContext: actx, viewport: vp, transform: [1, 0, 0, 1, -vp.width * g.x, -vp.height * g.y] }).promise;
    const info = S.scanInfo(i);
    const b = document.createElement('canvas'); b.width = W; b.height = H;
    const bctx = b.getContext('2d'); bctx.fillStyle = '#fff'; bctx.fillRect(0, 0, W, H);
    const { tw, th } = S.scanTarget(info, W, H);
    const bmp = await S.renderScan(info, tw, th, region ? { x: g.x * info.w, y: g.y * info.h, w: g.w * info.w, h: g.h * info.h } : null);
    S.drawScan(bctx, bmp, info.rotate, W, H);
    bmp.close();
    const da = actx.getImageData(0, 0, W, H).data, db = bctx.getImageData(0, 0, W, H).data;
    let diff = 0, bad = 0, darkA = 0, darkB = 0;
    for (let k = 0; k < da.length; k += 4) {
      const ga = gray(da, k), gb = gray(db, k);
      diff += Math.abs(ga - gb);
      if (Math.abs(ga - gb) > 128) bad++;
      if (ga < 128) darkA++;
      if (gb < 128) darkB++;
    }
    const px = da.length / 4;
    return { mean: diff / px, bad: bad / px, dark: darkA / px, darkB: darkB / px, scale };
  }
  // 黒の割合も両方で近いこと（真っ白・中身が消えた出力を見逃さない）。等倍以上では差を厳しく
  const near = (r) => r && Math.abs(r.dark - r.darkB) < r.dark * 0.3 && r.dark > 0.003 && r.mean < 15 && r.bad < (r.scale >= 1 ? 0.025 : 0.04);
  const cases = [
    ['tiffvar/g4_single_white0.tif', { passthruG4: true }, 'G4 そのまま・WhiteIsZero'],
    ['tiffvar/g4_single_black0.tif', { passthruG4: true }, 'G4 そのまま・BlackIsZero'],
    ['tiffvar/g4_single_white0.tif', { passthruG4: false }, 'Flate・WhiteIsZero'],
    ['fax_g4.tif', { passthruG4: true }, 'G4（複数ストリップ→Flate）・2 ページ'],
    ['tiffvar/raw_w333.tif', {}, 'Flate・幅 333']
  ];
  for (const [f, opts, label] of cases) {
    const lib = await PL.PDFDocument.create();
    await addTiffPages(lib, await fetchBytes(f), opts);
    await openBytes(await lib.save(), { name: 'scan.pdf', askPassword: async () => null });
    await ready();
    const res = [];
    for (let i = 0; i < state.pageIds.length; i++) {
      if (!S.scanInfo(i)) { res.push(null); continue; }
      for (const s of [0.37, 1, 1.6]) res.push(await compare(i, s));
    }
    const ok = res.every(near); // 縮小の仕方の違いで細い線の縁が少し違う。白黒の反転・向きの誤りなら大きく外れる
    check(ok, `スキャン画像の速い表示が pdf.js と一致 ${label} (${res.map((r) => (r ? `${r.mean.toFixed(1)}/${(r.bad * 100).toFixed(1)}%` : '対象外')).join(', ')})`);
  }
  // 拡大したとき：ページの一部だけ（見えている部分）を描いても pdf.js と同じ。大きな図面用の縮小版（1/4・1/8・1/16）を使っても同じ
  {
    const lib0 = await PL.PDFDocument.create();
    await addTiffPages(lib0, await fetchBytes('tiffvar/g4_single_white0.tif'), { passthruG4: true });
    await openBytes(await lib0.save(), { name: 'region.pdf', askPassword: async () => null });
    await ready();
    const reg = { x: 0.3, y: 0.25, w: 0.4, h: 0.35 };
    const rs = [];
    for (const pyr of [80e6, 0]) {
      S.setScanTestOptions({ pyramidMin: pyr });
      await sleep(50);
      for (const s of [0.37, 1, 2.5]) rs.push(await compare(0, s, reg));
      rs.push(await compare(0, 0.37));
    }
    S.setScanTestOptions({ pyramidMin: 80e6 });
    check(rs.every(near), `拡大したときの「見えている部分だけ」・縮小版を使った描き方も pdf.js と一致 (${rs.map((r) => `${r.mean.toFixed(1)}/${(r.bad * 100).toFixed(1)}%`).join(', ')})`);
    // 画面：大きく拡大すると、見えている部分の細かい画像（page-detail）が重なる（試験のページは小さいので、使い始める大きさを下げる）
    setDetailThreshold(1024 * 1024);
    zoomTo(Math.min(6, view.scale * 3));
    let d = null;
    for (let k = 0; k < 300; k++) {
      d = view.pages[0]?.div.querySelector('canvas.page-detail');
      if (d && d.dataset.scale === String(view.scale)) break;
      await sleep(20);
    }
    const dpr = window.devicePixelRatio || 1;
    const vr = document.getElementById('viewer').getBoundingClientRect();
    check(d && d.dataset.scale === String(view.scale) && d.width >= Math.min(vr.width, view.pages[0].div.getBoundingClientRect().width) * dpr * 0.95,
      `大きく拡大すると、見えている部分を画面の解像度で描く (倍率 ${view.scale.toFixed(2)}、${d ? `${d.width}×${d.height}` : 'なし'})`);
    setDetailThreshold(0);
    zoomTo(view.scale, 'width');
    await whenIdle();
    await sleep(400);
    check(!view.pages[0]?.div.querySelector('canvas.page-detail'), '元の大きさに戻すと、細かい画像はなくなる');
    // 6400%（PDF-XChange Editor と同じ上限）まで拡大でき、見えている部分は画素数の上限内で描かれる
    zoomTo(64);
    let d64 = null;
    for (let k = 0; k < 300; k++) {
      d64 = view.pages[0]?.div.querySelector('canvas.page-detail');
      if (d64 && d64.dataset.scale === String(view.scale)) break;
      await sleep(20);
    }
    const sel = document.getElementById('zoom-select');
    check(view.scale === MAX_SCALE && d64 && d64.width * d64.height <= 16 * 1024 * 1024 && sel?.value === '64',
      `6400% まで拡大でき、見えている部分だけを描く (倍率 ${view.scale}、${d64 ? `${d64.width}×${d64.height}` : 'なし'}、表示 ${sel?.value})`);
    zoomTo(0.01);
    check(Math.abs(view.scale - MIN_SCALE) < 1e-9, `縮小は 8.33% まで (${(view.scale * 100).toFixed(2)}%)`);
    zoomTo(1000);
    check(view.scale === MAX_SCALE, '6400% より大きくはならない');
    // ページを並べた高さが画面の部品の上限を超えない（ページが多いときは上限の倍率を下げる）
    const total = view.pages.reduce((a, q) => a + q.base.h + 16, 0);
    const fake = Math.ceil(30_000_000 / (total * 8));
    const saved = view.pages;
    view.pages = Array.from({ length: fake }, () => saved).flat();
    const capped = clampScale(64);
    view.pages = saved;
    check(capped < 64 && capped * total * fake <= 30_000_000 * 1.001 && capped >= 7.9, `ページが多いときは、並べた高さが上限を超えない倍率まで (${capped.toFixed(2)})`);
    // 見開き：高さが違うページが並ぶときは、行ごとに高い方で見積もる
    view.pages = Array.from({ length: 40000 }, (_, k) => ({ base: { w: 100, h: k % 2 ? 1000 : 10 } }));
    const prevLayout = view.layout;
    view.layout = 'two';
    const cap2 = clampScale(64);
    view.layout = prevLayout;
    view.pages = saved;
    check(cap2 * 20000 * 1016 <= 30_000_000 * 1.001, `見開きで高さが違うページでも、並べた高さが上限を超えない (${cap2.toFixed(3)})`);
    // 文字や図形の PDF（スキャン画像でない）でも、6400% で見えている部分を細かく描く
    await openBytes(await makeSample(), { name: 'vector.pdf', askPassword: async () => null });
    await ready();
    setDetailThreshold(1024 * 1024);
    zoomTo(64);
    // 見出しの文字（ページの左上から 50pt 付近）が見える位置へ動かす
    const vEl = document.getElementById('viewer');
    const pd = view.pages[0].div;
    vEl.scrollLeft = pd.offsetLeft + 50 * 64;
    vEl.scrollTop = pd.offsetTop + 45 * 64;
    await sleep(100);
    let dv = null;
    for (let k = 0; k < 300; k++) {
      dv = pd.querySelector('canvas.page-detail');
      if (dv && dv.dataset.scale === String(view.scale) && +dv.dataset.rect.split(',')[0] > 1000) break;
      await sleep(20);
    }
    let inked = false;
    if (dv) { const px = dv.getContext('2d').getImageData(0, 0, dv.width, dv.height).data; for (let q = 0; q < px.length; q += 4) if (px[q + 3] && px[q] < 250) { inked = true; break; } }
    check(view.scale === 64 && dv && inked && dv.width * dv.height <= 16 * 1024 * 1024, `文字・図形の PDF も 6400% で見えている部分を描く (${dv ? `${dv.width}×${dv.height}` : 'なし'}${inked ? '' : '、白紙の範囲'})`);
    setDetailThreshold(0);
    zoomTo(view.scale, 'width');
    await whenIdle();
  }
  // 回転（90/180/270）
  const lib = await PL.PDFDocument.create();
  await addTiffPages(lib, await fetchBytes('tiffvar/g4_single_white0.tif'), { passthruG4: true });
  lib.addPage(); // 比較用の白紙（速い表示の対象外）
  const bytes = await lib.save();
  const rots = [];
  for (const deg of [90, 180, 270]) {
    const l2 = await PL.PDFDocument.load(bytes);
    l2.getPage(0).setRotation(PL.degrees(deg));
    await openBytes(await l2.save(), { name: 'rot.pdf', askPassword: async () => null });
    await ready();
    const r = S.scanInfo(0) ? await compare(0, 0.8) : null;
    rots.push([deg, r]);
  }
  check(rots.every(([, r]) => near(r)), `回転したスキャン画像のページも一致 (${rots.map(([d, r]) => `${d}°: ${r ? r.mean.toFixed(1) : '対象外'}`).join(', ')})`);
  check(S.scanInfo(1) === null, '白紙のページは速い表示の対象外');
  // 中身を足したページ（透かし・墨消し・ヘッダーなど）は対象外になる
  state.lib.getPage(0).drawText('WATERMARK', { x: 20, y: 20, size: 30 });
  await refreshFromLib();
  check(S.scanInfo(0) === null, '文字を足したページは速い表示の対象外（pdf.js で描く）');
  // 中身の大きいページ（図面など）は、展開せずにすぐ対象外にする
  {
    const big = await PL.PDFDocument.create();
    const pg = big.addPage([595, 842]);
    for (let k = 0; k < 20000; k++) pg.drawLine({ start: { x: k % 500, y: (k * 7) % 800 }, end: { x: (k * 3) % 500, y: (k * 11) % 800 } });
    await openBytes(await big.save(), { name: 'big.pdf', askPassword: async () => null });
    await ready();
    const t0 = performance.now();
    const r = S.scanInfo(0);
    const ms = performance.now() - t0;
    check(r === null && ms < 20, `中身の大きいページは展開せずに対象外 (${ms.toFixed(1)}ms)`);
  }
  // 画面の表示が実際に速い表示を使っていること
  await openBytes(bytes, { name: 'scan2.pdf', askPassword: async () => null });
  await ready();
  await sleep(300);
  const st = renderStats();
  check(st.scan > 0, `画面の表示で速い表示を使う (速い ${st.scan} / pdf.js ${st.pdfjs})`);
}

async function i18nTests() {
  // 英語に切り替えると、表示中の画面もその場で英語になる
  setLang('en');
  await sleep(100);
  const btnTitle = (tool) => document.querySelector(`[data-tool="${tool}"]`)?.getAttribute('title') || '';
  const inspTool = () => document.getElementById('fb-title')?.textContent;
  setTool('measureArea');
  await sleep(50);
  check(/Measure Area/.test(inspTool()) && /Rectangle/.test(btnTitle('rect')), `英語に切り替え（ツール名: ${inspTool()} / ${btnTitle('rect')}）`);
  check(tr('縮尺を 1:100 にし、3 件の測定を更新しました') === 'Scale set to 1:100; 3 measurement(s) updated', '文中の数値を含む文も訳す');
  const ja = [...document.querySelectorAll('#toolbar, #sidebar .tabs, #formatbar')].map((n) => n.innerText).join('\n').match(/[\u3040-\u30ff\u4e00-\u9fff]+/g);
  check(!ja, `英語表示で画面に日本語が残っていない (${ja ? ja.slice(0, 5).join(', ') : 'なし'})`);
  await shot('15_english');
  // スタンプの選択画面（英語表示では英語のスタンプが先）
  const pending = chooseStamp();
  await sleep(500);
  const heads = [...document.querySelectorAll('.stamp-heading')].map((h) => h.textContent);
  check(heads[0] === 'English Stamps' && document.querySelectorAll('.stamp-grid .stamp-item img').length >= 24, `英語のスタンプ (${heads.join(' / ')})`);
  await shot('16_stamps_en');
  document.querySelector('.backdrop button.primary')?.click();
  await pending;
  // 英語からタイ語へ直接切り替える（英語が残らないこと）
  setLang('th');
  await sleep(100);
  check(/วัดพื้นที่/.test(inspTool()) && /สี่เหลี่ยม/.test(btnTitle('rect')), `タイ語に切り替え（ツール名: ${inspTool()} / ${btnTitle('rect').split('\n')[0]}）`);
  const leftover = [...document.querySelectorAll('#toolbar, #sidebar .tabs, #formatbar')].map((n) => n.innerText).join('\n').match(/[\u3040-\u30ff\u4e00-\u9fff]+|\b(?:Rectangle|Measure|Opacity|Line Color|Pages|Search)\b/g);
  check(!leftover, `タイ語表示で日本語・英語が残っていない (${leftover ? leftover.slice(0, 5).join(', ') : 'なし'})`);
  await shot('22_thai');
  setLang('en');
  await sleep(100);
  check(/Measure Area/.test(inspTool()), 'タイ語から英語に戻す');
  setLang(initialLang);
  await sleep(100);
  const back = { ja: [/面積の測定/, /矩形/], en: [/Measure Area/, /Rectangle/], th: [/วัดพื้นที่/, /สี่เหลี่ยม/] }[initialLang];
  check(back[0].test(inspTool()) && back[1].test(btnTitle('rect')), `始めたときの言語（${initialLang}）に戻す`);
  setTool('select');
}

async function linkTests() {
  // 手のひら（既定のツール）でのリンク：上からドラッグすると画面が動いてリンクは開かない、クリックで移動する
  const { PDFDocument, PDFName } = PL;
  const d = await PDFDocument.load(await makeSample());
  const annot = d.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [50, 400, 450, 520], Border: [0, 0, 0], Dest: [d.getPage(2).ref, PDFName.of('Fit')] });
  d.getPage(0).node.set(PDFName.of('Annots'), d.context.obj([d.context.register(annot)]));
  await openBytes(await d.save(), { name: 'link.pdf', askPassword: async () => null });
  await ready();
  setTool('hand');
  scrollToPage(0, false);
  await sleep(300);
  await whenIdle();
  const ln = document.querySelector('#pages .pdf-link');
  ln.scrollIntoView({ block: 'center' });
  await sleep(300);
  const viewerEl = document.getElementById('viewer');
  let r = ln.getBoundingClientRect();
  const st0 = viewerEl.scrollTop;
  await mouseDrag(r.left + r.width / 2, r.top + r.height / 2, r.left + r.width / 2, r.top + r.height / 2 - 120);
  await sleep(300);
  check(viewerEl.scrollTop > st0 + 60 && currentPage() === 0, `手のひらでリンクの上からドラッグすると画面が動き、リンクは開かない (スクロール ${Math.round(viewerEl.scrollTop - st0)}px、ページ ${currentPage() + 1})`);
  // リンクの外（何もない所）からのドラッグでも画面が動く
  r = ln.getBoundingClientRect();
  const st1 = viewerEl.scrollTop;
  await mouseDrag(r.left + r.width / 2, r.bottom + 40, r.left + r.width / 2, r.bottom - 60);
  await sleep(300);
  check(viewerEl.scrollTop > st1 + 50, `手のひらで何もない所をドラッグすると画面が動く (${Math.round(viewerEl.scrollTop - st1)}px)`);
  r = ln.getBoundingClientRect();
  await click(r.left + r.width / 2, r.top + r.height / 2);
  await sleep(800);
  check(currentPage() === 2, `手のひらでリンクをクリックするとページ 3 に移動 (ページ ${currentPage() + 1})`);
}

async function thaiPdfTests() {
  // タイ語のテキスト注釈・透かしを PDF に書き込む（タイ語フォントで、文字が取り出せること）
  await openBytes(await makeSample(), { name: 'thai.pdf', askPassword: async () => null });
  await ready();
  const text = 'ที่นี่ น้ำ ผู้ใหญ่ 2026';
  addObject(0, { type: 'text', text, fontSize: 18, fontColor: '#000000', rect: [60, 600, 360, 40] });
  await F.drawWatermark(state.lib, [1], { text: 'ความลับ', size: 60, color: '#e03131', opacity: 30, angle: 30 });
  const out = await buildOutput();
  const info = await textOf(out);
  // 母音「ำ」は PDF の中で「ํ」と「า」に分けて描かれ（声調記号の位置合わせのため）、取り出すと分かれた形になる。
  // 見た目は同じなので、比べるときは同じ形にそろえる
  const norm = (s) => s.replace(/\s+/g, '').replace(/([\u0E48-\u0E4B]?)\u0E33/g, '\u0E4D$1\u0E32');
  // 注釈の文字はページ本体には入らないので、フラット化（ページに焼き込み）してから取り出す
  const flat = await textOf(await buildOutput({ flatten: true, security: null }));
  check(norm(flat.text).includes(norm(text)), `タイ語のテキスト注釈の文字を取り出せる (${flat.text.match(/[\u0E00-\u0E7F][\u0E00-\u0E7F\s\d]*/g)?.join(' / ') || '見つからない'})`);
  check(norm(info.text).includes('ความลับ'), 'タイ語の透かしの文字を取り出せる');
  // タイ文字の接頭辞のベイツ番号（関数で作る欄）もタイ語フォントで書き込む
  await F.drawHeaderFooter(state.lib, [2], { fr: (n) => `เลขที่${String(n + 1).padStart(4, '0')}`, size: 10, margin: 28 });
  const bat = await textOf(await buildOutput());
  check(norm(bat.text).includes('เลขที่0001'), `タイ文字のベイツ番号を書き込める (${bat.text.match(/เลขที่\d+/)?.[0] || '見つからない'})`);
  const doc2 = await PL.PDFDocument.load(out, { updateMetadata: false });
  const fonts = [];
  for (const [, obj] of doc2.context.enumerateIndirectObjects()) {
    const bf = obj?.get?.(PL.PDFName.of('BaseFont'));
    if (bf) fonts.push(bf.asString());
  }
  check(fonts.some((f) => /NotoSansThai/.test(f)), `タイ語フォントを埋め込む (${[...new Set(fonts)].join(', ')})`);
  // 保存して開き直しても、注釈として編集できる
  await openBytes(out, { name: 'thai2.pdf', askPassword: async () => null });
  await ready();
  const back = objs().find((o) => o.type === 'text');
  check(back && back.text === text, '開き直してもタイ語のテキスト注釈を編集できる');
  await shot('23_thai_pdf');
}

async function errorLogTests() {
  const r = await api.selftest('errorlog', { record: 'Error: test failure at C:\\Users\\hanako\\Documents\\見積書.pdf', sanitize: 'open C:\\Users\\taro\\Desktop\\secret plan.pdf mail me@example.com' });
  check(r.log.includes('test failure') && !r.log.includes('hanako') && !r.log.includes('見積書'), 'エラーをログに記録し、ユーザー名・ファイル名を伏せる');
  check(!/taro|plan\.pdf|me@example/.test(r.sanitized), `報告前に個人情報を伏せる (${r.sanitized})`);
  check(r.body.includes('Environment') && r.body.includes('test failure') && r.body.length < 6000, `報告の本文（環境・ログ、URL に収まる長さ ${r.body.length}）`);
}

async function batchTests() {
  const { PDFDocument, rgb } = PL;
  const outDir = await api.selftest('outdir');
  const fetchBytes = async (n) => new Uint8Array(await (await fetch(`app://local/test/fixtures/${n}`)).arrayBuffer());
  const readOut = async (paths) => { await queue('open', paths); return (await api.openDialog({})).map((f) => new Uint8Array(f.bytes)); };
  const sample = await makeSample();
  // パスワード付き（開くパスワード）
  const pw = await PDFDocument.load(sample);
  pw.encrypt({ userPassword: 'pass1', ownerPassword: 'pass1', permissions: { printing: 'highResolution', modifying: true, copying: true, annotating: true, fillingForms: true, contentAccessibility: true, documentAssembly: true } });
  // 作成者による制限付き（開くパスワードなし・編集禁止）
  const rs = await PDFDocument.load(sample);
  rs.encrypt({ userPassword: '', ownerPassword: 'owner9', permissions: { printing: 'highResolution', modifying: false, copying: false } });
  // フォームと注釈（他のアプリで付けたもの）付き
  const fm = await PDFDocument.create();
  const pg = fm.addPage([400, 300]);
  const tf = fm.getForm().createTextField('name');
  tf.setText('FORMVALUE');
  tf.addToPage(pg, { x: 40, y: 200, width: 200, height: 24 });
  const ap = fm.context.formXObject([PL.PDFOperator.of('re', [10, 10, 80, 30].map((n) => PL.PDFNumber.of(n))), PL.PDFOperator.of('f')], { BBox: [0, 0, 100, 50] });
  const annot = fm.context.obj({ Type: 'Annot', Subtype: 'Square', Rect: [100, 50, 300, 150], AP: { N: fm.context.register(ap) }, F: 4 });
  pg.node.set(PL.PDFName.of('Annots'), fm.context.obj([fm.context.register(annot)]));
  const files = [
    { name: 'b1.pdf', path: 'b1.pdf', bytes: sample },
    { name: 'b2.tif', path: 'b2.tif', bytes: await fetchBytes('multipage.tif') },
    { name: 'b3_pw.pdf', path: 'b3_pw.pdf', bytes: await pw.save() },
    { name: 'b4_restricted.pdf', path: 'b4_restricted.pdf', bytes: await rs.save() },
    { name: 'b5_form.pdf', path: 'b5_form.pdf', bytes: await fm.save() }
  ];
  const o = {
    ocr: { on: false }, compress: { on: false }, protect: { on: false },
    watermark: { on: true, text: 'BATCHMARK', size: 40, color: '#ff0000', opacity: 30, angle: 30 },
    numbers: { on: true, text: 'P{page}/{total}', pos: 0, size: 10 },
    bates: { on: true, prefix: 'BT', start: 1, digits: 5, pos: 0, continuous: true },
    flatten: { on: true }, meta: { on: true, author: 'Batch Tester', titleFromName: true },
    output: { format: 'pdf', suffix: '_out', overwrite: true }
  };
  answer({ pw: 'pass1' });
  const res = await runBatch(files, o, outDir);
  const st = Object.fromEntries(res.map((r) => [r.name, r.status + (r.status === 'ok' ? '' : `: ${r.message}`)]));
  check(st['b1.pdf'] === 'ok' && st['b2.tif'] === 'ok' && st['b3_pw.pdf'] === 'ok' && st['b5_form.pdf'] === 'ok' && st['b4_restricted.pdf']?.startsWith('skipped'), `一括処理の結果（制限付きはスキップ） ${JSON.stringify(st)}`);
  const [o1, o2, o3, o5] = await readOut([res[0].outputs[0], res[1].outputs[0], res[2].outputs[0], res[4].outputs[0]]);
  const t1 = await textOf(o1), t2 = await textOf(o2), t5 = await textOf(o5);
  check(t1.text.includes('BATCHMARK') && t1.text.includes('P1/4') && t1.text.includes('BT00001') && t1.text.includes('BT00004'), '透かし・ページ番号・ベイツ番号を付ける');
  check(t2.text.includes('BT00005') && t2.text.includes('BT00007'), `ベイツ番号はファイルをまたいで通し番号 (${res[1].message})`);
  let needsPw = false;
  try { await textOf(o3); } catch { needsPw = true; }
  const t3 = await textOf(o3, 'pass1');
  check(needsPw && t3.text.includes('BT00008'), 'パスワード付きの PDF は同じパスワードで保存');
  check(t5.annots.length === 0 && t5.text.includes('FORMVALUE'), `フォームと他のアプリの注釈をフラット化 (注釈 ${t5.annots.length})`);
  const meta = await PDFDocument.load(o1, { updateMetadata: false });
  check(meta.getAuthor() === 'Batch Tester' && meta.getTitle() === 'b1', 'プロパティ（作成者・タイトル）を設定');
  // 2 回目：TIFF を OCR して強力圧縮・テキストで書き出し
  const o2nd = {
    ...o, watermark: { on: false }, numbers: { on: false }, bates: { on: false }, flatten: { on: false }, meta: { on: false },
    compress: { on: true, mode: 1, dpi: 100, quality: 60 }, ocr: { on: true, lang: 1, skip: true },
    output: { format: 'txt', suffix: '_ocr', overwrite: true }
  };
  const res2 = await runBatch([files[1]], o2nd, outDir);
  const [txt] = await readOut(res2[0].outputs);
  const text = new TextDecoder().decode(txt);
  // 設定画面（日本語・英語）
  for (const [l, name] of [['ja', '17_batch'], ['en', '18_batch_en']]) {
    setLang(l);
    const pending = batchProcess();
    await sleep(400);
    document.querySelectorAll('.batch-head input')[1]?.click();
    await sleep(100);
    await shot(name);
    document.querySelector('.backdrop .buttons button:not(.primary)')?.click();
    await pending;
  }
  setLang(initialLang);
  check(res2[0].status === 'ok' && /TIFF\s*PAGE\s*1/i.test(text), `OCR して テキストで書き出し (${text.replace(/\s+/g, ' ').slice(0, 40)})`);
}

/** 連続表示で縮小すると横に並ぶ／幅に合わせると 1 列／拡大すると横にスクロールできる／描いた画像を再利用する */
async function wrapTests() {
  const viewerEl = document.getElementById('viewer');
  const tops = () => view.pages.map((p) => p.div.offsetTop);
  zoomTo(0.25);
  await whenIdle();
  await sleep(100);
  const t = tops();
  check(t[0] === t[1] && t[1] === t[2], `縮小するとページが横に並ぶ (上端 ${t.join(', ')})`);
  viewerEl.scrollTop = 0;
  await sleep(100);
  check(currentPage() === 0, `横に並んでいるときの現在のページは行の先頭 (${currentPage() + 1})`);
  // 同じ行のページを指定して移動したら、それが現在のページ（サムネイルの選択がずれない）
  scrollToPage(2, false);
  await sleep(100);
  check(currentPage() === 2, `横に並んでいるとき、指定したページが現在のページ (${currentPage() + 1})`);
  await shot('24_wrap');
  zoomTo(view.scale, 'width');
  await whenIdle();
  await sleep(100);
  const t2 = tops();
  check(t2[0] < t2[1] && t2[1] < t2[2], `幅に合わせると 1 列 (上端 ${t2.join(', ')})`);
  // 見開きでも「次のページ」で次の行へ進む
  setLayout('two');
  await ready();
  scrollToPage(0, false);
  await sleep(150);
  stepPage(1);
  await sleep(400);
  const afterNext = currentPage();
  stepPage(-1);
  await sleep(400);
  check(afterNext === 2 && currentPage() === 0, `見開きで次・前のページが行ごとに動く (次 → ${afterNext + 1}、前 → ${currentPage() + 1})`);
  setLayout('single');
  await ready();
  zoomTo(3);
  await whenIdle();
  await sleep(100);
  check(viewerEl.scrollWidth > viewerEl.clientWidth + 50 && tops()[0] < tops()[1], `拡大すると横にスクロールでき、1 列のまま (幅 ${viewerEl.scrollWidth} / ${viewerEl.clientWidth})`);
  // 画面から外れたページの画像はキャッシュに残り、戻ると描き直さずに出る
  zoomTo(view.scale, 'width');
  await sleep(300); // ズーム後の描き直しは少し遅れて始まる
  await whenIdle();
  scrollToPage(0, false);
  await sleep(300);
  await whenIdle();
  const before = view.pages[0].canvas;
  scrollToPage(3, false);
  await whenIdle();
  await sleep(100);
  const wasUnmounted = !view.pages[0].mounted;
  scrollToPage(0, false);
  await whenIdle();
  await sleep(50);
  const again = view.pages[0].canvas;
  check(wasUnmounted && again && again === before, `戻ったページは描いた画像をそのまま使う (${again === before ? '再利用' : '描き直し'}、離れたときに解放: ${wasUnmounted})`);
  await whenIdle();
}

/** テンキーの拡大・縮小と、タブ・並べて表示 */
async function tabTests() {
  await openBytes(await makeSample(), { name: 'tabs.pdf', askPassword: async () => null });
  await ready();
  zoomTo(1);
  await sleep(50);
  await key('numadd');
  await sleep(50);
  const up = view.scale;
  await key('numsub');
  await sleep(50);
  check(up > 1.01 && Math.abs(view.scale - 1) < 0.01, `テンキーの ＋／－ で拡大・縮小 (${up.toFixed(2)} → ${view.scale.toFixed(2)})`);

  const info = () => api.selftest('tabs');
  const tab = (arg) => api.selftest('tab', arg);
  let s = await info();
  const self = s.self;
  check(s.tabs.length === 1 && s.active === self, `最初はタブ 1 つ (${s.tabs.length})`);
  // 2 つ目の文書は同じウィンドウの新しいタブ
  await api.openInNewWindow(await makeSample(), 'second.pdf', null);
  await sleep(300);
  s = await info();
  const other = s.tabs.find((x) => x.id !== self)?.id;
  check(s.tabs.length === 2 && s.windows === 1 && s.active === other, `2 つ目の文書は新しいタブで開く (タブ ${s.tabs.length}、ウィンドウ ${s.windows})`);
  check(!s.tabs.find((x) => x.id === self).visible, '切り替えると前のタブは隠れる');
  for (let k = 0; k < 50 && !(await info()).tabs.some((x) => x.title === 'second.pdf'); k++) await sleep(100);
  s = await info();
  check(s.tabs.some((x) => x.title === 'second.pdf'), `タブにファイル名が出る (${s.tabs.map((x) => x.title).join(' / ')})`);
  // あとから開いたタブも、すぐにページが描かれる（描画が止まったままにならない）
  const t0 = performance.now();
  let drawn = 0;
  while (performance.now() - t0 < 8000 && !(drawn = await tab({ do: 'eval', id: other, js: "document.querySelectorAll('canvas.page-canvas').length" }))) await sleep(100);
  check(drawn > 0 && performance.now() - t0 < 5000, `新しいタブのページがすぐ描かれる (${Math.round(performance.now() - t0)}ms)`);
  const third = await tab({ do: 'new' });
  await tab({ do: 'activate', id: self });
  await sleep(100);
  s = await info();
  check(s.tabs.length === 3 && s.active === self && s.tabs.find((x) => x.id === self).visible, `タブを切り替える (${s.tabs.length} タブ)`);
  const stripTabs = await tab({ do: 'strip', js: "document.querySelectorAll('.tab').length + ':' + document.querySelectorAll('.tab.active').length" });
  check(stripTabs === '3:1', `タブバーにタブが並ぶ (${stripTabs})`);

  // 左右に 2 画面
  await tab({ do: 'mode', mode: 'h' });
  await sleep(300);
  s = await info();
  const [pa, pb] = s.panes;
  check(s.panes.length === 2 && pa.id === self && pa.x < pb.x && Math.abs(pa.width - pb.width) <= 2 && pa.y === pb.y, `左右に 2 画面 (${JSON.stringify(s.panes)})`);
  check(Math.abs(window.innerWidth - pa.width) <= 1, `左右のとき、この画面の幅は半分 (${window.innerWidth})`);
  check(document.documentElement.scrollWidth <= window.innerWidth + 1, `半分の幅でも横にはみ出さない (${document.documentElement.scrollWidth} / ${window.innerWidth})`);
  const frames = await tab({ do: 'strip', js: "document.querySelectorAll('.frame').length + ':' + document.querySelectorAll('.frame.active').length" });
  check(frames === '2:1', `操作中の画面に枠が付く (${frames})`);
  await shot('40_split');
  await api.selftest('stripshot', '41');
  // メニューの操作は操作中の画面だけに効く
  const sc = view.scale;
  await tab({ do: 'activate', id: pb.id });
  await tab({ do: 'menu', action: 'zoom-in' });
  await sleep(200);
  check(view.scale === sc, `もう一方の画面のメニュー操作は、この画面に効かない (${sc} → ${view.scale})`);
  await tab({ do: 'activate', id: self });
  await tab({ do: 'menu', action: 'zoom-in' });
  await sleep(200);
  check(view.scale > sc, `操作中の画面にメニュー操作が効く (${sc.toFixed(2)} → ${view.scale.toFixed(2)})`);
  // 見えていないタブを選ぶと、操作中の画面と入れ替わる
  const hidden = s.tabs.find((x) => !s.panes.some((p) => p.id === x.id)).id;
  await tab({ do: 'activate', id: hidden });
  await sleep(100);
  s = await info();
  check(s.panes.length === 2 && s.panes.some((p) => p.id === hidden) && s.active === hidden, `見えていないタブを選ぶと画面が入れ替わる (${s.panes.map((p) => p.id).join(',')})`);
  await tab({ do: 'activate', id: self });

  // 上下に 2 画面
  await tab({ do: 'mode', mode: 'v' });
  await sleep(200);
  s = await info();
  check(s.panes.length === 2 && s.panes[0].x === s.panes[1].x && s.panes[0].y < s.panes[1].y, `上下に 2 画面 (${JSON.stringify(s.panes)})`);
  // すべて並べる
  await tab({ do: 'mode', mode: 'grid' });
  await sleep(200);
  s = await info();
  check(s.panes.length === 3 && s.tabs.every((x) => x.visible) && new Set(s.panes.map((p) => p.y)).size === 1, `すべて並べる (3 タブで 3 列: ${JSON.stringify(s.panes.map((p) => [p.x, p.width]))})`);
  const fourth = await tab({ do: 'new' });
  await sleep(200);
  s = await info();
  check(s.panes.length === 4 && new Set(s.panes.map((p) => p.y)).size === 2, `4 タブで 2×2 (${JSON.stringify(s.panes.map((p) => [p.x, p.y]))})`);
  await tab({ do: 'force-close', id: fourth });
  await sleep(100);
  s = await info();
  check(s.tabs.length === 3 && s.panes.length === 3, `タブを閉じると並べ方も直る (${s.panes.length} 画面)`);

  // 1 画面に戻す・タブを閉じる
  await tab({ do: 'mode', mode: 'single' });
  await tab({ do: 'activate', id: self });
  await sleep(200);
  s = await info();
  check(s.panes.length === 1 && s.panes[0].id === self && s.tabs.filter((x) => x.visible).length === 1, '1 画面に戻す');
  await tab({ do: 'move', id: self, index: 2 });
  s = await info();
  check(s.tabs[2].id === self, 'タブの順番を変える');
  // 保存していないタブを閉じるときの確認
  await tab({ do: 'eval', id: other, js: 'window.api.setDirty(true)' });
  await tab({ do: 'eval', id: third, js: 'window.api.setDirty(true)' });
  await sleep(100);
  await tab({ do: 'askSave', answers: [2] });
  const r1 = await tab({ do: 'close', id: other });
  check(r1 === false && (await tab({ do: 'state', id: other })).open, '保存していないタブは、キャンセルすると閉じない');
  // ウィンドウを閉じる：1 つ目「保存しない」→ 2 つ目「キャンセル」なら、1 つ目も確認が残る
  await tab({ do: 'askSave', answers: [1, 2] });
  const prevented = await tab({ do: 'window-close' });
  const st1 = await tab({ do: 'state', id: other });
  check(prevented && st1.open && !st1.forceClose && (await tab({ do: 'state', id: third })).open, `ウィンドウを閉じるのをキャンセルすると、「保存しない」を選んだタブも閉じずに確認が残る (${JSON.stringify(st1)})`);
  await tab({ do: 'askSave', answers: [1] });
  const r2 = await tab({ do: 'close', id: other });
  check(r2 === true && !(await tab({ do: 'state', id: other })).open, '「保存しない」でタブを閉じる');
  // 「今後は確認しない」：キャンセルは覚えない。「保存しない」を覚えると、次からは確かめずに閉じる
  await tab({ do: 'askSave', answers: [{ r: 2, remember: true }] });
  const r3 = await tab({ do: 'close', id: third });
  check(r3 === false && (await tab({ do: 'state', id: third })).open && (await tab({ do: 'save-prompt' })) === 'ask', '「今後は確認しない」に印を付けても、キャンセルは覚えない');
  await tab({ do: 'askSave', answers: [{ r: 1, remember: true }] });
  const r4 = await tab({ do: 'close', id: third });
  check(r4 === true && !(await tab({ do: 'state', id: third })).open && (await tab({ do: 'save-prompt' })) === 'discard' && (await tab({ do: 'menu-save-prompt' })) === 2,
    '「今後は確認しない」で「保存しない」を選ぶと覚え、メニューにも表示される');
  const fifth = await tab({ do: 'new' });
  await sleep(200);
  await tab({ do: 'eval', id: fifth, js: 'window.api.setDirty(true)' });
  await sleep(100);
  await tab({ do: 'askSave', answers: [2] });
  const r5 = await tab({ do: 'close', id: fifth });
  check(r5 === true && !(await tab({ do: 'state', id: fifth })).open && (await tab({ do: 'askSave-clear' })) === 1, '覚えたあとは、確かめずに保存しないで閉じる');
  await tab({ do: 'save-prompt', value: 'save' });
  await tab({ do: 'askSave', answers: [2] });
  check((await tab({ do: 'ask-save' })) === 0 && (await tab({ do: 'askSave-clear' })) === 1 && (await tab({ do: 'menu-save-prompt' })) === 1, '「確かめずに保存する」を選ぶと、確かめずに保存する');
  // 確かめずに保存する設定でも、保存できなかったとき（ここでは文書のないタブ）は、いつもの確認を出す（閉じられなくならない）
  const sixth = await tab({ do: 'new' });
  await sleep(200);
  await tab({ do: 'eval', id: sixth, js: 'window.api.setDirty(true)' });
  await sleep(100);
  await tab({ do: 'askSave', answers: [1] });
  const r6 = await tab({ do: 'close', id: sixth });
  let st6 = null;
  for (let k = 0; k < 100; k++) { st6 = await tab({ do: 'state', id: sixth }); if (!st6.open) break; await sleep(30); }
  check(r6 === 'pending' && !st6.open && (await tab({ do: 'askSave-clear' })) === 0 && (await tab({ do: 'save-prompt' })) === 'save',
    `確かめずに保存する設定で保存できなかったときは、確認を出して「保存しない」で閉じられる (${r6}, ${JSON.stringify(st6)})`);
  // 追加した文言が英語・タイ語に訳されている
  const untranslated = [];
  for (const lang of ['en', 'th']) {
    const dict = await (await fetch(`../i18n/${lang}.json`)).json();
    for (const k of ['今後は確認せず、次から同じ操作をする（「編集」メニューの「閉じるときの保存の確認」で戻せます）', '閉じるときの保存の確認', '毎回確かめる', '確かめずに保存する', '確かめずに保存しない（変更は失われます）']) if (!dict.strings?.[k]) untranslated.push(`${lang}: ${k}`);
  }
  check(!untranslated.length, `保存の確認の文言が英語・タイ語に訳されている${untranslated.length ? ` (${untranslated.join(' / ')})` : ''}`);
  await tab({ do: 'save-prompt', value: 'ask' });
  await tab({ do: 'askSave', answers: [{ r: 0, remember: false }] });
  check((await tab({ do: 'ask-save' })) === 0 && (await tab({ do: 'save-prompt' })) === 'ask' && (await tab({ do: 'menu-save-prompt' })) === 0, 'メニューで「毎回確かめる」に戻すと、また確かめる');
  // 確認を表示している間は、ほかの閉じる操作を受け付けない（確認が重ならない）
  check((await tab({ do: 'busy-close', id: self })) === false, '確認を表示している間は、ほかのタブを閉じる操作で確認が重ならない');
  await tab({ do: 'force-close', id: third });
  await sleep(200);
  s = await info();
  check(s.tabs.length === 1 && s.active === self && s.windows === 1, `ほかのタブを閉じる (${s.tabs.length} タブ)`);
  check(Math.abs(window.innerWidth - s.panes[0].width) <= 1, `1 画面に戻ると幅も戻る (${window.innerWidth})`);

  // 何枚かまとめて開く（先に開いたタブは、隠れたまま読み込む）
  const fetchBytes = async (n) => new Uint8Array(await (await fetch(`app://local/test/fixtures/${n}`)).arrayBuffer());
  const raf = "Promise.race([new Promise((r) => requestAnimationFrame(() => r('raf'))), new Promise((r) => setTimeout(() => r('timeout'), 2000))])";
  const tm = performance.now();
  await api.openInNewWindow(await makeSample(), 'm1.pdf', null);
  await api.openInNewWindow(await makeSample(), 'm2.pdf', null);
  await api.openInNewWindow(await fetchBytes('multipage.tif'), 'm3.tif', null);
  const want = ['m1.pdf', 'm2.pdf', 'm3.pdf'];
  let loaded = false;
  while (performance.now() - tm < 15000) {
    s = await info();
    if (want.every((n) => s.tabs.some((x) => x.title === n))) { loaded = true; break; }
    await sleep(100);
  }
  check(loaded, `まとめて開いた文書が、隠れたタブでも読み込まれる (${Math.round(performance.now() - tm)}ms: ${s.tabs.map((x) => x.title).join(' / ')})`);
  const idOf = (n) => s.tabs.find((x) => x.title === n)?.id;
  for (const n of ['m1.pdf', 'm3.pdf']) {
    const id = idOf(n);
    const ta = performance.now();
    await tab({ do: 'activate', id });
    let c = 0;
    while (performance.now() - ta < 3000 && !(c = await tab({ do: 'eval', id, js: "document.querySelectorAll('canvas.page-canvas').length" }))) await sleep(50);
    const fr = await tab({ do: 'eval', id, js: raf });
    check(c > 0 && fr === 'raf' && performance.now() - ta < 2000, `隠れていたタブを開くとすぐ描かれる ${n} (${Math.round(performance.now() - ta)}ms, ${fr})`);
  }

  // タブバーの実際の操作（クリック・新しいタブ・並べ替え・×）
  const strip = (js) => tab({ do: 'strip', js });
  await strip(`document.querySelector('.tab[data-id="${idOf('m2.pdf')}"]').dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }))`);
  await sleep(200);
  s = await info();
  check(s.active === idOf('m2.pdf'), 'タブバーのタブをクリックして切り替える');
  const nBefore = s.tabs.length;
  await strip('window.tabs.newTab()');
  await sleep(300);
  s = await info();
  const blank = s.tabs[s.tabs.length - 1].id;
  check(s.tabs.length === nBefore + 1 && s.active === blank, 'タブバーの ＋ で新しいタブ');
  await strip(`window.tabs.move(${blank}, 0)`);
  await sleep(200);
  s = await info();
  check(s.tabs[0].id === blank, 'タブバーでタブを並べ替える');
  await strip(`document.querySelector('.tab[data-id="${blank}"] .x').click()`);
  await sleep(300);
  s = await info();
  check(s.tabs.length === nBefore && !s.tabs.some((x) => x.id === blank), 'タブの × で閉じる');

  // 新しいウィンドウに移す（文書は開いたまま、描かれ続ける）
  const mv = idOf('m3.pdf');
  await tab({ do: 'move-window', id: mv });
  await sleep(1000);
  s = await info();
  // 移した先のウィンドウを前に出してから確かめる（後ろに隠れたウィンドウは Mac が描画を止める）
  await tab({ do: 'front-any', id: mv });
  await sleep(500);
  const infoMv = await tab({ do: 'info-any', id: mv });
  const visMv = await tab({ do: 'eval-any', id: mv, js: 'document.visibilityState' });
  const pagesMv = await tab({ do: 'eval-any', id: mv, js: "document.querySelectorAll('.page').length" });
  if (infoMv.focused === 'none' && !infoMv.ready) {
    // アプリが前面に出られない環境（この Mac を使っている最中など）では、新しいウィンドウの show の知らせが来ないので確かめられない
    await log(`⚠️ タブを新しいウィンドウに移す：この環境では確かめられない (${JSON.stringify(infoMv)})`);
  } else {
    check(s.windows === 2 && !s.tabs.some((x) => x.id === mv) && infoMv.ready && infoMv.inTabs && infoMv.active && infoMv.viewVisible && pagesMv === 3,
      `タブを新しいウィンドウに移す（アプリ側の状態） (ウィンドウ ${s.windows}, ${pagesMv} ページ, ${JSON.stringify(infoMv)})`);
  }
  if (visMv === 'visible') {
    const frMv = await tab({ do: 'eval-any', id: mv, js: raf });
    check(frMv === 'raf', `移したタブが描かれる (${frMv})`);
  } else {
    // アプリが前面にない（この Mac を使っている最中など）と、ウィンドウが見えないため描画を確かめられない
    await log(`⚠️ 移したタブの描画はこの環境では確かめられない (visibility=${visMv}, 前面のウィンドウ=${infoMv.focused})`);
  }
  if (infoMv.ready) {
    // 最後のタブを × で閉じても、ウィンドウは閉じずに空のタブが残る
    const rc = await tab({ do: 'request-close-any', id: mv });
    check(rc.windowOpen && rc.tabs.length === 1 && rc.tabs[0].empty, `最後のタブを閉じても空のタブが残りアプリは終わらない (${JSON.stringify(rc)})`);
    for (const x of rc.tabs) await tab({ do: 'close-any', id: x.id });
  } else {
    await log('⚠️ 最後のタブを閉じたときの動き：この環境では確かめられない（新しいウィンドウが表示されない）');
    await tab({ do: 'close-any', id: mv });
  }
  for (const n of ['m1.pdf', 'm2.pdf']) await tab({ do: 'force-close', id: idOf(n) });
  await tab({ do: 'activate', id: self });
  await sleep(300);
  s = await info();
  check(s.tabs.length === 1 && s.windows === 1, `移したタブを閉じるとそのウィンドウも閉じる (ウィンドウ ${s.windows}, タブ ${s.tabs.length})`);
  await tab({ do: 'focus-self' });
}

async function layoutTests() {
  await openBytes(await makeSample(), { name: 'layout.pdf', askPassword: async () => null });
  await ready();
  await wrapTests();
  // 既定のツールは手のひら：Esc で戻り、カーソルは十字ではなく手の形
  setTool('rect');
  await key('Escape');
  await sleep(100);
  const cap = view.pages[0].overlay.querySelector('.capture');
  check(view.tool === 'hand' && getComputedStyle(cap).cursor === 'grab', `既定のツールは手のひら（Esc で戻る、カーソル: ${getComputedStyle(cap).cursor}）`);
  // 右側のパネルは無く、選択中の注釈の操作は書式バーにある
  check(!document.getElementById('inspector') && !document.querySelector('.resizer-right'), '右側のパネルが無い');
  placeImage(0, [300, 500], textStamp('承認', '#d6191f', true), 120, 'スタンプ');
  await sleep(300);
  const st = objs().find((o) => o.type === 'image');
  const rotBox = document.querySelector('#formatbar [data-kinds="rot"]');
  const selBox = document.querySelector('#formatbar [data-kinds="sel"]');
  check(view.selected === st.id && rotBox?.style.display !== 'none' && selBox?.style.display !== 'none' && /スタンプ|画像|Image|Stamp|รูปภาพ|ตราประทับ/.test(document.getElementById('fb-title').textContent),
    `注釈を選ぶと書式バーに回転・編集・削除が出る (${document.getElementById('fb-title').textContent})`);
  await click(...centerOf(rotBox.querySelectorAll('button')[1]));
  check(objs().find((o) => o.id === st.id).angle === ((st.angle || 0) + 270) % 360 || selectedDisplayAngle() === 90, `書式バーのボタンで回転 (画面上 ${selectedDisplayAngle()}°)`);
  // 幅が狭くても回転・削除は「»」に隠れない（書式より前にある）
  await api.selftest('size', [1000, 800]);
  await sleep(500);
  check(!rotBox.classList.contains('ovf-hidden') && !selBox.classList.contains('ovf-hidden'), '幅 1000px でも回転・削除が書式バーに見える');
  await shot('21_formatbar_selected');
  await click(...centerOf(selBox.querySelectorAll('button')[1]));
  await sleep(150);
  check(!objs().some((o) => o.id === st.id) && view.selected === null, '書式バーの「削除」で注釈を消す');
  // 狭いウィンドウ：入りきらないツールは「»」メニューへ
  await sleep(500);
  const more = document.querySelector('#toolbar .ovf-more');
  const hiddenTools = [...document.querySelectorAll('#toolbar .tb.tool.ovf-hidden')];
  const tb = document.getElementById('toolbar');
  const right = document.querySelector('.tb-right').getBoundingClientRect();
  check(more && !more.classList.contains('ovf-hidden') && hiddenTools.length > 0 && right.right <= tb.getBoundingClientRect().right + 1,
    `狭いウィンドウでは入りきらないツールを「»」にまとめる（${hiddenTools.length} 個、右端の倍率も見える）`);
  await click(...centerOf(more));
  await sleep(150);
  const popup = document.querySelector('.ovf-popup');
  const target = hiddenTools[hiddenTools.length - 1].dataset.tool;
  await shot('19_overflow_menu');
  check(popup && popup.querySelector(`[data-tool="${target}"]`), 'メニューに隠れたツールが並ぶ');
  await click(...centerOf(popup.querySelector(`[data-tool="${target}"]`)));
  await sleep(150);
  check(view.tool === target && !document.querySelector('.ovf-popup') && document.querySelector(`#toolbar [data-tool="${target}"]`), `メニューからツールを選ぶ (${view.tool})`);
  setTool('select');
  await sleep(200);
  // 書式バーも同様
  const fbMore = document.querySelector('#formatbar .ovf-more');
  check(fbMore && !fbMore.classList.contains('ovf-hidden'), '書式バーも入りきらない項目を「»」にまとめる');
  await api.selftest('size', [1800, 900]);
  await sleep(600);
  check(document.querySelector('#toolbar .ovf-more').classList.contains('ovf-hidden') && !document.querySelector('#toolbar .tb.tool.ovf-hidden'), '広げると元どおりすべて表示');
  await api.selftest('size', [1400, 900]);
  await sleep(600);
  // サイドバーの幅をドラッグで変える → 幅に合わせた表示も追従
  zoomTo(view.scale, 'width');
  await sleep(400);
  const side = document.getElementById('sidebar');
  const w0 = side.offsetWidth, s0 = view.scale;
  const [rx, ry] = centerOf(document.querySelector('.resizer-left'));
  await mouseDrag(rx, ry, rx + 150, ry);
  await sleep(600);
  check(Math.abs(side.offsetWidth - (w0 + 150)) < 3 && view.scale < s0, `サイドバーの幅を変更 (${w0} → ${side.offsetWidth}px、倍率 ${s0.toFixed(2)} → ${view.scale.toFixed(2)})`);
  // サムネイルの大きさ
  const slider = document.querySelector('.thumb-bar input[type=range]');
  slider.value = 80;
  slider.dispatchEvent(new Event('input'));
  await sleep(900);
  await whenIdle();
  for (let k = 0; k < 50 && window.__thumbBusy(); k++) await sleep(50);
  await sleep(300);
  const c = document.querySelector('#thumbs .thumb canvas');
  const thumbsEl = document.getElementById('thumbs');
  const t0 = thumbsEl.children[0].getBoundingClientRect(), t1 = thumbsEl.children[1].getBoundingClientRect();
  check(c && Math.max(parseFloat(c.style.width), parseFloat(c.style.height)) <= 82 && Math.abs(t0.top - t1.top) < 2, `サムネイルを小さくすると横に並ぶ (${c && c.style.width})`);
  await shot('20_thumbs_small');
  slider.value = 150;
  slider.dispatchEvent(new Event('input'));
  const [rx2, ry2] = centerOf(document.querySelector('.resizer-left'));
  await input([{ type: 'mouseDown', x: Math.round(rx2), y: Math.round(ry2), button: 'left', clickCount: 2 }, { type: 'mouseUp', x: Math.round(rx2), y: Math.round(ry2), button: 'left', clickCount: 2 }]);
  await sleep(300);
  check(Math.abs(side.offsetWidth - 230) < 2, `ダブルクリックで元の幅に戻す (${side.offsetWidth}px)`);
}

// テストを始めたときの表示言語（途中で切り替えたあとは、これに戻す）
let initialLang = 'ja';

export async function run() {
  initialLang = getLang();
  window.__askLog = [];
  try {
    const out = await api.selftest('outdir');
    await log(`出力先: ${out}`);
    await uiTests();
    const only = new URLSearchParams(location.search).get('only');
    if (only === 'tabs') { await tabTests(); throw new Error('__only__'); }
    if (only === 'scan') { await scanFastTests(); throw new Error('__only__'); }
    await layoutTests();
    await tabTests();
    await rotationTests();
    await measureTests();
    await tiffTests();
    await tiffPixelTests();
    await scanFastTests();
    await i18nTests();
    await thaiPdfTests();
    await linkTests();
    await errorLogTests();
    await batchTests();

    // 1. 開く
    await openBytes(await makeSample(), { name: 'sample.pdf', askPassword: async () => null });
    await ready();
    check(state.pageIds.length === 4, 'PDF を開く（4 ページ）');
    check((await pageText(0)).text.includes('日本語の本文'), '日本語テキストの抽出');
    await shot('01_open');

    // 2. 注釈
    const items = (await pageText(0)).items;
    const fox = items.find((i) => i.str.includes('quick brown'));
    addObject(0, { type: 'highlight', quads: [fox.rect], rect: fox.rect, color: '#ffd43b', opacity: 0.45 });
    addObject(0, { type: 'rect', rect: [60, 560, 160, 80], color: '#e03131', fill: '#fff3bf', width: 3, opacity: 1 });
    addObject(0, { type: 'ellipse', rect: [250, 560, 120, 80], color: '#1971c2', width: 2, opacity: 1 });
    addObject(0, { type: 'arrow', points: [[400, 560], [520, 640]], rect: [400, 560, 120, 80], color: '#2f9e44', width: 3, opacity: 1 });
    addObject(0, { type: 'ink', strokes: [[[60, 480], [100, 520], [140, 470], [180, 520], [220, 480]]], rect: [57, 467, 166, 56], color: '#9c36b5', width: 3, opacity: 1 });
    addObject(0, { type: 'text', text: 'テキストボックスの注釈です。\n2 行目', fontSize: 16, fontColor: '#c92a2a', bold: true, fill: '#e7f5ff', rect: [260, 440, 260, 60], opacity: 1 });
    addObject(0, { type: 'note', rect: [540, 700, 20, 20], color: '#ffd43b', contents: '付箋のコメント' });
    addObject(0, { type: 'image', src: textStamp('承認', '#d6191f', true), ratio: 66 / 106, rect: [430, 300, 110, 68], opacity: 1 });
    addObject(0, { type: 'image', src: hanko('山田'), ratio: 1, rect: [470, 220, 50, 50], opacity: 1 });
    const line3 = items.find((i) => i.str.includes('fox 3 '));
    addObject(0, { type: 'edit', text: '★ 編集後の文字列です ★', original: line3.str, fontSize: line3.fontSize, fontColor: '#000000', rect: [line3.rect[0] - 1, line3.rect[1], line3.rect[2] + 2, line3.rect[3]] });
    addObject(0, { type: 'link', rect: [50, 770, 250, 30], url: 'https://example.com', page: null });
    check(state.objects[state.pageIds[0]].length === 11, '注釈 11 個を追加');
    await shot('02_annotations');

    // 2b. ドラッグ移動（ジェスチャー）と取り消し
    const rectObj = state.objects[state.pageIds[0]][1];
    const before = [...rectObj.rect];
    const g = beginGesture(rectObj.id);
    g.obj.rect = [g.obj.rect[0] + 30, g.obj.rect[1] - 20, g.obj.rect[2], g.obj.rect[3]];
    endGesture(g, true);
    check(findObject(rectObj.id).obj.rect[0] === before[0] + 30 && rectObj.rect[0] === before[0], 'ドラッグ移動（元のオブジェクトは書き換えない）');
    await undo();
    check(findObject(rectObj.id).obj.rect[0] === before[0], 'ドラッグ移動の取り消し');

    // 3. 保存→再読み込みで注釈が編集可能なまま復元される
    const saved = await buildOutput();
    const t1 = await textOf(saved);
    check(t1.annots.filter((a) => a.subtype !== 'Popup').length === 11, `保存した PDF の注釈数 (${t1.annots.length})`);
    check(t1.annots.some((a) => a.subtype === 'FreeText' && (a.contentsObj?.str || '').includes('編集後の文字列')), 'テキスト編集の結果が保存される');
    check(t1.annots.some((a) => a.subtype === 'Link' && a.url === 'https://example.com/'), 'リンクの保存');
    await api.writeFile(`${out}/02_annotations.pdf`, saved);
    await openBytes(saved, { name: 'reopen.pdf', askPassword: async () => null });
    check(state.objects[state.pageIds[0]].length === 11, '再度開いたとき注釈がオブジェクトとして復元される');
    const sizeBeforeMoves = (await buildOutput()).length;

    // 4. ページ操作と取り消し
    await changeStructure((lib) => rotatePages(lib, [1], 90));
    check(state.lib.getPage(1).getRotation().angle === 90, 'ページ回転');
    await F.movePagesTo([3], 0);
    check((await pageText(0)).text.includes('第4章') && state.objects[state.pageIds[1]].length === 11, 'ページの並べ替え（注釈も一緒に移動）');
    await undo();
    check((await pageText(0)).text.includes('第1章') && state.objects[state.pageIds[0]].length === 11, '取り消し（並べ替えを戻す・注釈も維持）');
    await redo();
    check((await pageText(0)).text.includes('第4章'), 'やり直し');
    for (let k = 0; k < 5; k++) await F.movePagesTo([0], 4);
    const sizeAfterMoves = (await buildOutput()).length;
    check(sizeAfterMoves < sizeBeforeMoves * 1.05, `並べ替えを繰り返してもファイルが肥大化しない (${sizeBeforeMoves} → ${sizeAfterMoves} bytes)`);
    await undo(); await undo(); await undo(); await undo(); await undo(); await undo();
    check((await pageText(0)).text.includes('第1章'), '並べ替えをすべて取り消し');

    // 4b. 構造変更の途中で失敗したら元に戻る
    const count0 = state.lib.getPageCount();
    try {
      await changeStructure((lib) => { lib.removePage(0); throw new Error('テスト用の失敗'); });
    } catch { /* 想定どおり */ }
    check(state.lib.getPageCount() === count0 && state.pageIds.length === count0, '処理が途中で失敗しても文書が壊れない');

    await changeStructure((lib) => insertBlank(lib, 4, [595.28, 841.89]));
    check(state.pageIds.length === 5, '空白ページの挿入');
    const dupBefore = (await buildOutput()).length;
    await changeStructure((lib) => duplicatePages(lib, [0]));
    const dupAfter = (await buildOutput()).length;
    check(state.pageIds.length === 6 && state.objects[state.pageIds[1]].length === 11, 'ページ複製（注釈も複製）');
    check(dupAfter < dupBefore * 1.6, `複製でフォント・画像を二重に持たない (${dupBefore} → ${dupAfter} bytes)`);
    answer({});
    await F.deleteSelectedPages();
    check(state.pageIds.length === 5, 'ページ削除');

    // 5. 透かし・ヘッダー/フッター・ベイツ
    answer({ text: '社外秘', size: 72, color: '#e03131', opacity: 25, angle: 45, range: '' });
    await F.watermark();
    answer({ hl: 'PDF Studio テスト', hr: '{date}', fc: '{page} / {total}', size: 10, margin: 28, start: 1, color: '#000000', range: '' });
    await F.headerFooter();
    answer({ prefix: 'ABC', start: 1, digits: 6, pos: 0, range: '' });
    await F.bates();
    const t2 = (await pageText(1)).text;
    check(/2\s*\/\s*5/.test(t2) && t2.includes('ABC000002') && t2.includes('PDF Studio テスト'), 'ヘッダー・ページ番号・ベイツ番号');
    check((await pageText(0)).text.includes('社外秘'), '透かし');
    await buildPages(0);
    await shot('03_watermark');

    // 6. 墨消し（検索した語を確実に削除）
    const target = (await pageText(2)).items.find((i) => i.str.includes('SECRET'));
    const pos = target.str.indexOf('SECRET');
    const sr = subRange(target, pos, 10);
    const word = target.str.slice(pos, pos + 10);
    addObject(2, { type: 'redact', rect: [sr[0] - 1, sr[1], sr[2] + 2, sr[3]] });
    answer({});
    await F.applyRedactions();
    check(!(await pageText(2)).text.includes(word), `墨消し後に「${word}」が抽出できない`);
    scrollToPage(2, false);
    await shot('04_redacted');

    // 7. OCR（墨消しで画像化されたページを認識。ブラウザ内の Worker で実行）
    answer({ lang: 0, skip: true, range: '3' }, {});
    const tOcr = performance.now();
    await F.ocr();
    const ocrText = (await pageText(2)).text;
    check(ocrText.includes('日本語') || ocrText.includes('本文'), `OCR で日本語を認識 (${Math.round(performance.now() - tOcr)} ms)`);
    check(/quick\s*brown/i.test(ocrText), 'OCR で英語を認識（検索可能）');

    // 8. フォーム作成と入力（日本語）
    answer({ name: '氏名', multi: false });
    await F.createFormField({ page: 0, rect: [300, 160, 200, 24], at: [300, 184], kind: 'formText' });
    answer({ name: '同意' });
    await F.createFormField({ page: 0, rect: null, at: [300, 140], kind: 'formCheck' });
    answer({ name: '区分', options: '社内,社外,その他' });
    await F.createFormField({ page: 0, rect: [300, 100, 160, 22], at: [300, 122], kind: 'formChoice' });
    state.lib.getForm().getTextField('氏名').setText('山田 太郎');
    state.lib.getForm().getCheckBox('同意').check();
    state.lib.getForm().getDropdown('区分').select('社外');
    state.formDirty = true;
    const formOut = await textOf(await buildOutput());
    const fv = Object.fromEntries(formOut.annots.filter((a) => a.fieldName).map((a) => [a.fieldName, a.fieldValue]));
    check(fv['氏名'] === '山田 太郎' && String(fv['区分']).includes('社外') && fv['同意'] !== 'Off', `フォーム作成と日本語入力 ${JSON.stringify(fv)}`);
    await buildPages(0);
    scrollToPage(0, false);
    await shot('05_forms');
    // 既定の手のひらツールでも、フォームの入力欄をクリックできる（入力欄の外は画面を動かす層）
    setTool('hand');
    await sleep(300);
    await whenIdle();
    const inp = document.querySelector('#pages .pdf-input');
    inp?.scrollIntoView({ block: 'center' });
    await sleep(300);
    const ir = inp?.getBoundingClientRect();
    const hitIn = ir && document.elementFromPoint(ir.left + ir.width / 2, ir.top + ir.height / 2);
    const hitOut = ir && document.elementFromPoint(ir.left - 30, ir.top + ir.height / 2); // 入力欄のすぐ左（ページの中）
    const z = (sel) => Number(getComputedStyle(document.querySelector(sel)).zIndex);
    check(hitIn === inp && hitOut && hitOut !== inp && !hitOut.closest('.form-layer') && z('#pages .form-layer') < z('#pages .overlay'),
      `手のひらツールでもフォームに入力でき、入力欄は注釈の下のまま（入力欄: ${hitIn?.className}、外: ${hitOut?.getAttribute?.('class') || hitOut?.tagName}）`);
    // 入力欄に注釈が重なっていても、手のひらでは入力欄にクリックが届く（注釈は上に見えたまま）
    if (inp && ir) {
      const [ax, ay] = view.pages[0].vp1.convertToPdfPoint((ir.left + ir.width / 2 - view.pages[0].div.getBoundingClientRect().left) / view.scale, (ir.top + ir.height / 2 - view.pages[0].div.getBoundingClientRect().top) / view.scale);
      const ov = addObject(0, { type: 'rect', rect: [ax - 20, ay - 8, 40, 16], color: '#e03131', width: 2, opacity: 1, fill: '#ffd43b' });
      await sleep(200);
      const hit = document.elementFromPoint(ir.left + ir.width / 2, ir.top + ir.height / 2);
      check(hit === inp && document.querySelector(`#pages .obj[data-id="${ov.id}"]`), `注釈が重なった入力欄にも手のひらでクリックが届く (${hit?.className || hit?.tagName})`);
      removeObject(ov.id);
      await sleep(100);
    }
    // 手のひらのまま実際に入力し、ページの空いた所を押すと値が確定する（フォーカスが外れる）
    if (inp && ir) {
      inp.value = '';
      await click(ir.left + ir.width / 2, ir.top + ir.height / 2);
      for (const c of 'XYZ') await key(c);
      await click(ir.left - 30, ir.top + ir.height / 2);
      await sleep(200);
      const saved = state.lib.getForm().getTextField(inp.title).getText();
      check(document.activeElement !== inp && saved === 'XYZ', `手のひらのまま入力した値が確定する（フォーカス: ${document.activeElement === inp ? '入力欄のまま' : '外れた'}、値: ${saved}）`);
    }
    setTool('select');

    // 9. パスワード保護
    answer({ user: 'pass123', user2: 'pass123', owner: 'owner456', print: true, copy: false, edit: true });
    await F.protect();
    const enc = await buildOutput();
    let locked = false;
    try { await textOf(enc); } catch (e) { locked = e.name === 'PasswordException'; }
    check(locked, '暗号化（パスワードなしでは開けない）');
    const encInfo = await textOf(enc, 'pass123');
    check(encInfo.text.includes('日本語'), '正しいパスワードで開ける');
    check(encInfo.perms && !encInfo.perms.includes(pdfjsLib.PermissionFlag.COPY), 'コピー禁止の権限が設定される');
    await api.writeFile(`${out}/06_protected.pdf`, enc);
    await openBytes(enc, { name: 'enc.pdf', askPassword: async () => 'pass123' });
    check(state.pageIds.length === 5 && state.security?.user === 'pass123', '暗号化 PDF を開ける（保護を引き継ぐ）');
    check(!can('copy') && can('annotate'), '元の権限（コピー禁止・注釈可）を守る');
    const resaved = await textOf(await buildOutput(), 'pass123');
    check(resaved.perms && !resaved.perms.includes(pdfjsLib.PermissionFlag.COPY), '保存し直しても権限の制限が外れない');
    answer({});
    await F.unprotect();
    check(state.security?.restricted, '制限付きの文書は保護を解除できない');

    // 10. 権限の制限がない状態に戻して書き出し
    await openBytes(await buildOutput({ security: null }), { name: 'plain.pdf', askPassword: async () => null });
    queue('save', `${out}/07_export.docx`);
    await F.exportDocx();
    queue('save', `${out}/07_export.txt`);
    await F.exportText();
    queue('folder', out);
    answer({ fmt: 1, dpi: 72, range: '1-2' });
    await F.exportImages();
    check(true, 'Word / テキスト / 画像の書き出し（ファイルを確認）');

    // 11. 分割・圧縮
    queue('folder', out);
    answer({ mode: 0, n: 2, ranges: '' });
    await F.split();
    queue('save', `${out}/08_small.pdf`);
    answer({ mode: 1, dpi: 80, quality: 60 }, {});
    await F.saveOptimized();
    check(true, '分割・圧縮保存（ファイルを確認）');

    // 12. 画像からページ挿入
    const c = document.createElement('canvas');
    c.width = 400; c.height = 300;
    const g2 = c.getContext('2d');
    g2.fillStyle = '#4dabf7'; g2.fillRect(0, 0, 400, 300); g2.fillStyle = '#fff'; g2.font = '40px "Noto Sans JP"'; g2.fillText('画像ページ', 90, 160);
    const before12 = state.pageIds.length;
    const png = await canvasToBytes(c, 'image/png');
    await changeStructure((lib) => insertFromSources(lib, before12, [{ name: 'x.png', bytes: png }]));
    check(state.pageIds.length === before12 + 1, '画像をページとして挿入');

    // 12b. ファイルから作成：拡張子でなく中身で見分ける。対応していない形式（PowerPoint・Excel）は文字化けさせずに知らせる
    {
      const jpg = await canvasToBytes(c, 'image/jpeg');
      const webp = await canvasToBytes(c, 'image/webp');
      const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 20, 0, 0, 0, 8, 0, 1, 2, 3, 4, 5, 6, 7, 8]);
      const enc = (x) => new TextEncoder().encode(x);
      const skipped = [];
      const d = await F.sourcesToPdf([
        { name: 'photo.png', bytes: jpg },           // 中身は JPEG（以前は「The input is not a PNG file!」）
        { name: 'image.png', bytes: webp },          // 中身は WebP
        { name: 'real.png', bytes: png },
        { name: 'slides.pptx', bytes: zip },
        { name: 'sheet.xlsx', bytes: zip },
        { name: 'broken.pdf', bytes: enc('%PDF-1.7 broken') }
      ], skipped);
      check(d.getPageCount() === 3, `ファイルから作成：拡張子と中身が違う画像も読み込む (${d.getPageCount()} ページ)`);
      check(skipped.length === 3 && skipped.map((x) => x.name).join() === 'slides.pptx,sheet.xlsx,broken.pdf' && !skipped.some((x) => x.cancelled),
        `ファイルから作成：PowerPoint・Excel・壊れた PDF は読み込まずに知らせる (${skipped.map((x) => `${x.name}: ${x.reason}`).join(' / ')})`);
      const k = (name, bytes) => F.sniffKind(name, bytes);
      const bmpHead = new Uint8Array(30); bmpHead.set([0x42, 0x4d], 0); bmpHead[14] = 40;
      const cases = [
        [k('a.txt', enc('hello')), 'text'], [k('memo.txt', enc('BMI,height,weight\n22,170,64')), 'text'],
        [k('notes.md', enc('# PDF のメモ\n%PDF-1.7 という見出しで始まる')), 'text'], [k('app.log', enc('started\nok')), 'text'],
        [k('data.json', enc('{"a":1}')), 'text'], [k('a.docx', zip), 'docx'], [k('a.exe', new Uint8Array([0x4d, 0x5a, 0, 0])), null],
        [k('old.xls', new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])), null], [k('x.bmp', bmpHead), 'image'],
        [k('junk.pdf', enc('garbage\n%PDF-1.4\n')), 'pdf'], [k('scan.png', new Uint8Array([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0])), 'tiff'],
        [k('empty.png', new Uint8Array(0)), null], [k('a.bin', new Uint8Array([1, 2, 0, 4, 5])), null],
        [k('codes.csv', enc('MZ001,abc\nMZ002,def')), 'text'], [k('unicode.txt', new Uint8Array([0xff, 0xfe, 0x42, 0x30, 0x0a, 0x00])), 'text'],
        [k('doc.rtf', enc('{\\rtf1\\ansi hello}')), null], [k('sjis.txt', new Uint8Array([0x82, 0xa0, 0x82, 0xa2, 0x0d, 0x0a, 0x82, 0xa4])), 'text'],
        [k('long.log', enc('\x1b[32m処理が完了しました\x1b[0m\n'.repeat(300).slice(1))), 'text']
      ];
      const bad = cases.map(([got, want], i) => (got === want ? null : `${i}:${got}≠${want}`)).filter(Boolean);
      check(!bad.length, `ファイルから作成：中身で形式を見分ける (${bad.join(', ') || 'OK'})`);
      // Shift_JIS・UTF-16 のテキストも文字化けせずに PDF になる
      for (const [nm, bytes] of [['sjis.txt', new Uint8Array([0x82, 0xa0, 0x82, 0xa2, 0x82, 0xa4, 0x82, 0xa6, 0x82, 0xa8])], ['u16.txt', new Uint8Array([0xff, 0xfe, 0x42, 0x30, 0x44, 0x30, 0x46, 0x30, 0x48, 0x30, 0x4a, 0x30])]]) {
        await api.writeFile(`${out}/${nm}`, bytes);
        const sk = [];
        const td = await F.sourcesToPdf([{ name: nm, path: `${out}/${nm}`, bytes }], sk);
        const tx = td.getPageCount() ? (await textOf(await td.save())).text : '';
        check(tx.replace(/\s/g, '').includes('あいうえお'), `ファイルから作成：${nm} の日本語が文字化けしない (${tx.slice(0, 20)} ${sk.map((x) => x.reason).join()})`);
      }
      // ページの挿入も、中身が JPEG の .png を読み込める
      const beforeIns = state.pageIds.length;
      await changeStructure((lib) => insertFromSources(lib, beforeIns, [{ name: 'photo.png', bytes: jpg }]));
      check(state.pageIds.length === beforeIns + 1, 'ページの挿入：中身が JPEG の .png も挿入できる');
    }

    // 13. フラット化
    answer({});
    await F.flatten();
    const flat = await textOf(await buildOutput());
    check(flat.annots.filter((a) => a.subtype !== 'Link').length === 0 && flat.text.includes('編集後の文字列'), 'フラット化');
    await api.writeFile(`${out}/09_final.pdf`, await buildOutput());

    // 14. 墨消しした文字が保存ファイルの中身にも残らない（以前は差し替え前のページが残っていた）
    {
      const { PDFDocument, StandardFonts } = PL;
      const d = await PDFDocument.create();
      const f = await d.embedFont(StandardFonts.Helvetica);
      d.addPage([400, 300]).drawText('TOPSECRET-XYZ is here', { x: 40, y: 150, size: 18, font: f });
      d.addPage([400, 300]).drawText('Other page', { x: 40, y: 150, size: 18, font: f });
      const src = await d.save();
      check(await rawContains(src, 'TOPSECRET-XYZ'), '（前提）元ファイルには文字が含まれる');
      await openBytes(src, { name: 'leak.pdf', askPassword: async () => null });
      const it = (await pageText(0)).items.find((x) => x.str.includes('TOPSECRET'));
      addObject(0, { type: 'redact', rect: [it.rect[0] - 2, it.rect[1] - 2, it.rect[2] + 4, it.rect[3] + 4] });
      answer({});
      await F.applyRedactions();
      const red = await buildOutput();
      check(!(await rawContains(red, 'TOPSECRET-XYZ')), '墨消しした文字が保存ファイルのどこにも残らない');
      check((await rawContains(red, 'Other page')), '（確認）他のページの文字は残る');
    }

    // 15. ズーム後に表示中のページが描かれている（以前は白紙になることがあった）
    await openBytes(await makeSample(), { name: 'zoom.pdf', askPassword: async () => null });
    await ready();
    for (const s of [1.6, 2.2, 0.8]) { zoomTo(s); await sleep(30); }
    await sleep(400);
    await whenIdle();
    const viewerEl = document.getElementById('viewer');
    const vr = viewerEl.getBoundingClientRect();
    const blank = view.pages.filter((p) => {
      const r = p.div.getBoundingClientRect();
      return r.bottom > vr.top && r.top < vr.bottom && !(p.canvas && p.canvasScale === view.scale);
    }).length;
    check(blank === 0, `ズーム後も表示中のページが正しい倍率で描かれる (${JSON.stringify(renderStats())})`);

    // 16. 画面（ツール・選択状態）
    zoomTo(view.scale, 'width');
    setTool('rect');
    await shot('10_tools');
  } catch (e) {
    if (e?.message !== '__only__') {
      failures++;
      await log(`❌ 例外: ${e.stack || e}`);
    }
  }
  if (missing.size) await log(`\n未翻訳 ${missing.size} 件:\n${[...missing].join('\n')}`);
  await log(failures ? `\n${failures} 件失敗` : '\nすべてのテストに合格しました');
  await api.selftest('done', failures);
}
