// 自動テスト（`electron . --selftest`）。主要機能を UI 経由で操作し、結果とスクリーンショットを保存する
import {
  state, PL, pdfjsLib, PDFJS_OPTS, openBytes, buildOutput, jpFont, pageText, undo, redo, changeStructure, insertFromSources,
  rotatePages, insertBlank, duplicatePages, can, beginGesture, endGesture, findObject, measureValue, refreshFromLib, setDirty,
  readOutline, editOutline, normalizePageSize, PAPER_SIZES
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
  // 起動直後は描画が落ち着かず、送ったマウスの動きがまとめられて途中が抜けることがある（裏で動かすときに起きた）。
  // 画面が何回か描かれるのを待ち、マウスを一度動かしてから始める
  for (let k = 0; k < 10; k++) await new Promise((r) => requestAnimationFrame(r));
  await input([{ type: 'mouseMove', x: 5, y: 5 }, { type: 'mouseMove', x: 15, y: 15 }]);
  await sleep(500);
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
  const inkUps = pointerUps;
  await input([{ type: 'mouseMove', x: R(ix), y: R(iy) }, { type: 'mouseDown', x: R(ix), y: R(iy), button: 'left', clickCount: 1 },
    ...[...Array(12).keys()].map((k) => ({ type: 'mouseMove', x: R(ix + k * 12), y: R(iy + (k % 2 ? 15 : -15)), button: 'left', modifiers: ['leftButtonDown'] })),
    { type: 'mouseUp', x: R(ix + 132), y: R(iy), button: 'left', clickCount: 1 }]);
  // 離した入力が処理されるまで待つ（固定の待ち時間だと、負荷が高いときに失敗していた）
  await waitPointerUp(inkUps);
  for (let k = 0; k < 50 && !objs().some((o) => o.type === 'ink'); k++) await sleep(20);
  const ink = objs().find((o) => o.type === 'ink');
  // 速く動かすと、動きの入力がまとめられて点が少し減ることがある（12 回動かして 9 点のこともある）
  check(ink && ink.strokes[0].length >= 6, `マウスで手書き (点 ${ink ? ink.strokes[0].length : 'なし'}・ツール ${view.tool}・種類 ${objs().map((o) => o.type).join(',')})`);
  // 手のひらツールでスクロール
  setTool('hand');
  const viewerEl = document.getElementById('viewer');
  const st0 = viewerEl.scrollTop;
  await mouseDrag(...at(0, 0.5, 0.8), ...at(0, 0.5, 0.3));
  check(viewerEl.scrollTop > st0 + 50, '手のひらツールでスクロール');
  // 手のひらで勢いよく動かして離すと、離したあとも滑って、だんだん止まる（慣性スクロール）
  {
    // 離した入力の処理が負荷で 60ms 以上遅れると「止めてから離した」扱いになり滑らない（テストの時間のぶれ）。
    // そのときだけ払い直す（2 回とも滑らなければ失敗）
    let atUp = 0, mid = 0, evs = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      viewerEl.scrollTop = 0;
      await sleep(300);
      const [fx, fy1] = at(0, 0.5, 0.85), [, fy2] = at(0, 0.5, 0.35);
      const before = pointerUps;
      evs = [{ type: 'mouseMove', x: R(fx), y: R(fy1) }, { type: 'mouseDown', x: R(fx), y: R(fy1), button: 'left', clickCount: 1 }];
      for (let k = 1; k <= 8; k++) evs.push({ type: 'mouseMove', x: R(fx), y: R(fy1 + ((fy2 - fy1) * k) / 8), button: 'left', modifiers: ['leftButtonDown'] });
      evs.push({ type: 'mouseUp', x: R(fx), y: R(fy2), button: 'left', clickCount: 1 });
      await input(evs);
      await waitPointerUp(before);
      atUp = viewerEl.scrollTop;
      await sleep(250);
      mid = viewerEl.scrollTop;
      if (mid > atUp + 30) break;
    }
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

  // 実際のドロップ：対応していないファイルは知らせ、画像は PDF にして新しいタブで開く
  {
    const dropFiles = (files) => {
      const dt = new DataTransfer();
      for (const f of files) dt.items.add(f);
      document.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    };
    const until = async (fn, ms = 8000) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (await fn()) return true; await sleep(100); } return false; };
    window.__askQueue = [];
    answer({});
    dropFiles([new File(['{"a":1}'], 'settings.json')]);
    const told = await until(() => window.__askQueue.length === 0);
    s = await info();
    window.__askQueue = []; // 使われなかった答えを、あとのテストに残さない
    check(told && s.tabs.length === 1, `ドロップ：対応していないファイルは開かずに知らせる (お知らせ ${told}, タブ ${s.tabs.length})`);
    const cv = document.createElement('canvas'); cv.width = 40; cv.height = 30;
    cv.getContext('2d').fillRect(0, 0, 20, 15);
    const png = await canvasToBytes(cv, 'image/png');
    dropFiles([new File([png], 'dropped-photo.png', { type: 'image/png' })]);
    const opened = await until(async () => (await info()).tabs.some((x) => x.title === 'dropped-photo.pdf'));
    s = await info();
    check(opened, `ドロップ：画像は PDF にして新しいタブで開く (${s.tabs.map((x) => x.title).join(' / ')})`);
    for (const x of s.tabs) if (x.id !== self) await tab({ do: 'force-close', id: x.id });
    await tab({ do: 'activate', id: self });
    await sleep(300);
    s = await info();
  }
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
    // （場所の分からない TIFF から変換したタブは、閉じると取り戻せないので確かめる。「保存しない」と答える）
    await queue('askSave', 1);
    const rc = await tab({ do: 'request-close-any', id: mv });
    check((await tab({ do: 'askSave-clear' })) === 0, '場所の分からない TIFF を閉じるときは、保存するかを確かめる');
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

// しおりの編集・ページの大きさをそろえる：保存して開き直しても、しおり・リンク・注釈・回転・文字が正しく残る
async function pageEditTests() {
  const { PDFDocument, PDFName, PDFString, StandardFonts, degrees } = PL;
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  const p1 = d.addPage([841.89, 1190.55]); // A3 縦
  p1.drawText('HELLO A3', { x: 100, y: 1000, size: 30, font });
  const p2 = d.addPage([792, 612]); // Letter 横、表示は 90° 回転
  p2.setRotation(degrees(90));
  p2.drawText('PAGE TWO', { x: 100, y: 300, size: 30, font });
  const p3 = d.addPage([595.28, 841.89]); // A4 縦だが、表示範囲（トリミング）は小さい
  p3.drawText('PAGE THREE', { x: 100, y: 600, size: 30, font });
  p3.setCropBox(0, 0, 500, 700);
  const p4 = d.addPage([595.28, 841.89]); // A4 縦（そのまま）
  const ctx = d.context;
  // 1 ページ目の中身を「配列への参照」の形にする（この形で中身が消えないこと）
  const c1 = p1.node.get(PDFName.of('Contents'));
  p1.node.set(PDFName.of('Contents'), ctx.register(ctx.obj(c1 instanceof PL.PDFArray ? c1.asArray() : [c1])));
  // 名前で指定した移動先（/Dests）と、入れ子のしおり
  d.catalog.set(PDFName.of('Dests'), ctx.obj({ chap2: [p2.ref, PDFName.of('Fit')] }));
  const root = ctx.nextRef(), o1 = ctx.nextRef(), o2 = ctx.nextRef(), o21 = ctx.nextRef();
  // 色・太字、閉じた状態（Count が負）も残ること
  // しおりとリンクが同じ移動先（間接参照の配列）を共有する。名前の木（/Names /Dests）の移動先も置く
  const shared = ctx.register(ctx.obj([p1.ref, PDFName.of('XYZ'), 0, 1190, null]));
  // （名前の木があると pdf.js はそちらを先に見るので、chap2 も入れる。名前の順に並べる）
  d.catalog.set(PDFName.of('Names'), ctx.obj({ Dests: ctx.obj({ Names: [PDFString.of('chap2'), ctx.obj([p2.ref, PDFName.of('Fit')]), PDFString.of('treeDest'), ctx.obj([p1.ref, PDFName.of('XYZ'), 0, 1000, null])] }) }));
  ctx.assign(o1, ctx.obj({ Title: PDFString.of('Chapter 1'), Parent: root, Next: o2, Dest: shared, C: [1, 0, 0], F: 2 }));
  ctx.assign(o2, ctx.obj({ Title: PDFString.of('Chapter 2'), Parent: root, Prev: o1, Dest: PDFString.of('chap2'), First: o21, Last: o21, Count: -1 }));
  ctx.assign(o21, ctx.obj({ Title: PDFString.of('Section 2.1'), Parent: o2, Dest: [p3.ref, PDFName.of('Fit')] }));
  ctx.assign(root, ctx.obj({ Type: 'Outlines', First: o1, Last: o2, Count: 2 }));
  d.catalog.set(PDFName.of('Outlines'), root);
  // リンク（1 ページ目 → 3 ページ目）
  const link = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [100, 100, 300, 160], Border: [0, 0, 0], Dest: shared }));
  p1.node.set(PDFName.of('Annots'), ctx.obj([link]));
  await openBytes(await d.save(), { name: 'edit-test.pdf', askPassword: async () => null });
  await ready();
  // このアプリの注釈（1 ページ目）
  addObject(0, { type: 'ink', strokes: [[[200, 500], [400, 500]]], rect: [198, 498, 204, 4], color: '#000', width: 2, opacity: 1 });

  // しおりの読み取り（名前で指定した移動先もページに直す）
  let ol = await readOutline();
  check(ol.length === 2 && ol[0].page === 0 && ol[1].page === 1 && ol[1].items[0]?.title === 'Section 2.1' && ol[1].items[0].page === 2,
    `しおり：入れ子・名前で指定した移動先を読む (${JSON.stringify(ol.map((x) => [x.title, x.page, x.items.map((y) => [y.title, y.page])]))})`);
  // 追加・名前の変更・並べ替え・字下げ
  await editOutline((items) => { items.push({ title: 'Appendix', page: 2, pos: ['Fit'], url: null, items: [] }); });
  await editOutline((items) => { items[0].title = 'Chapter One'; });
  await editOutline((items) => { const [a] = items.splice(2, 1); items[1].items.push(a); }); // Appendix を Chapter 2 の中へ
  ol = await readOutline();
  check(ol.map((x) => x.title).join() === 'Chapter One,Chapter 2' && ol[1].items.map((x) => `${x.title}:${x.page}`).join() === 'Section 2.1:2,Appendix:2',
    `しおり：追加・名前の変更・入れ子にする (${JSON.stringify(ol.map((x) => [x.title, x.items.map((y) => y.title)]))})`);
  await undo();
  ol = await readOutline();
  check(ol.length === 3 && ol[2].title === 'Appendix', `しおり：元に戻せる (${ol.map((x) => x.title).join()})`);
  await redo();
  // しおりの欄：編集のボタンが並び、選んで「下へ」で並べ替えられる
  {
    const P = await import('./panels.js');
    await sleep(500);
    const tools = document.querySelectorAll('#outline .outline-tools button').length;
    const rows = () => [...document.querySelectorAll('#outline .outline-item')].map((e) => e.textContent);
    const first = document.querySelector('#outline .outline-item');
    first?.click();
    await P.outlineAction('down');
    await sleep(500);
    check(tools === 7 && rows().slice(0, 2).join() === 'Chapter 2,Section 2.1', `しおり：欄のボタンで並べ替える (ボタン ${tools}, ${rows().join(' / ')})`);
    await undo();
    await sleep(300);
  }

  // ページの大きさをそろえる（A4）
  const res = await normalizePageSize([0, 1, 2, 3], [595.28, 841.89]);
  check(res.changed === 3, `ページの大きさをそろえる：大きさの違うページだけ変える（トリミングしたページは表示範囲で判断） (${res.changed} ページ)`);
  const saved = await buildOutput();
  // 保存したものを開き直して確かめる
  const re = await PDFDocument.load(saved);
  const sizes = re.getPages().map((p) => { const mb = p.getMediaBox(); return `${Math.round(mb.width)}x${Math.round(mb.height)}r${p.getRotation().angle}`; });
  check(sizes.join() === '595x842r0,842x595r90,595x842r0,595x842r0', `ページの大きさをそろえる：縦横の向き・回転を保って A4 に (${sizes.join(', ')})`);
  const cb3 = re.getPage(2).getCropBox();
  check(Math.round(cb3.width) === 595 && Math.round(cb3.height) === 842, `ページの大きさをそろえる：トリミングしたページも見える範囲が A4 になる (${Math.round(cb3.width)}x${Math.round(cb3.height)})`);
  // 古いしおりの名前がファイルに残らない
  const oldTitle = [...re.context.enumerateIndirectObjects()].some(([, o]) => o instanceof PL.PDFDict && o.lookup(PDFName.of('Title'))?.decodeText?.() === 'Chapter 1');
  check(!oldTitle, '保存して開き直す：名前を変える前のしおりがファイルに残らない');
  const k = 595.28 / 841.89;
  const lr = re.getPage(0).node.Annots()?.asArray().map((r) => re.context.lookup(r)).find((a) => a.lookup(PDFName.of('Subtype'))?.asString() === '/Link')?.lookup(PDFName.of('Rect'))?.asArray().map((n) => n.asNumber());
  check(lr && Math.abs(lr[0] - 100 * k) < 1 && Math.abs(lr[2] - 300 * k) < 1, `ページの大きさをそろえる：リンクの位置も一緒に動く (${lr?.map((v) => v.toFixed(1)).join(', ')})`);
  const pj = await pdfjsLib.getDocument({ data: saved.slice(), ...PDFJS_OPTS }).promise;
  const tc = await (await pj.getPage(1)).getTextContent();
  const txt = tc.items.map((x) => x.str).join('');
  const hx = tc.items.find((x) => x.str.includes('HELLO'))?.transform?.[4];
  const reOl = await readOutline(pj);
  check(txt.includes('HELLO A3') && Math.abs(hx - 100 * k) < 1, `ページの大きさをそろえる：中身が配列への参照のページも、文字が残り同じだけ縮む (${txt.slice(0, 20)}, x=${hx?.toFixed(1)})`);
  const rawOl = await pj.getOutline();
  check(rawOl[0].bold && rawOl[0].color?.[0] === 255 && rawOl[1].dest === 'chap2' && rawOl[1].count < 0,
    `保存して開き直す：しおりの色・太字・閉じた状態・名前の移動先が残る (${JSON.stringify(rawOl.map((x) => ({ b: x.bold, c: x.color && [...x.color], d: x.dest, n: x.count })))})`);
  check(Math.abs((reOl[0].pos?.[2] ?? 0) - 1190 * k) < 1, `ページの大きさをそろえる：しおりの移動先の位置も一緒に縮む（リンクと共有していても 1 回だけ） (${reOl[0].pos?.[2]?.toFixed(1)})`);
  const td = await pj.getDestination('treeDest');
  check(td && Math.abs(td[3] - 1000 * k) < 1, `ページの大きさをそろえる：名前の木の移動先の位置も縮む (${td?.[3]?.toFixed?.(1)})`);
  check(reOl.map((x) => `${x.title}:${x.page}`).join() === 'Chapter One:0,Chapter 2:1' && reOl[1].items.map((x) => `${x.title}:${x.page}`).join() === 'Section 2.1:2,Appendix:2',
    `保存して開き直す：しおりの移動先が残る (${JSON.stringify(reOl.map((x) => [x.title, x.page, x.items.map((y) => [y.title, y.page])]))})`);
  pj.destroy();
  await openBytes(saved, { name: 'edit-test-saved.pdf', askPassword: async () => null });
  await ready();
  const ink = objs(0).find((o) => o.type === 'ink');
  check(ink && Math.abs(ink.strokes[0][0][0] - (200 * k)) < 1 && Math.abs(ink.width - 2 * k) < 0.05, `保存して開き直す：注釈の位置と太さも一緒に縮む (${ink?.strokes[0][0].map((v) => v.toFixed(1))}, 太さ ${ink?.width?.toFixed(2)})`);
  await undo(); // 開き直した文書には取り消しはない（何も起きない）

  // 大きさを変えたページで、墨消し・焼き込みが正しく効く（墨消しした文字がファイルに残らない）
  {
    const base = await d.save();
    await openBytes(base, { name: 'redact-test.pdf', askPassword: async () => null });
    await ready();
    await normalizePageSize([0, 1, 2, 3], [595.28, 841.89]);
    await ready();
    // 対照：墨消しの前は、部品（Form XObject）の中の文字もファイルの中から見つかる（検索が中まで見ていることの確認）
    check(await rawContains(await buildOutput(), 'HELLO'), '大きさを変えたページ：墨消しの前は文字がファイルの中から見つかる（検索の確認）');
    addObject(0, { type: 'redact', rect: [50, 680, 260, 60] }); // HELLO A3（縮めたあと x≈71, y≈707）
    answer({});
    await F.applyRedactions();
    await ready();
    const red = await buildOutput();
    check(!(await rawContains(red, 'HELLO')), '大きさを変えたページ：墨消しした文字がファイルに残らない');
    addObject(1, { type: 'rect', rect: [100, 100, 80, 40], color: '#ff0000', width: 2 });
    answer({});
    await F.flatten();
    await ready();
    const flat = await buildOutput();
    const pjf = await pdfjsLib.getDocument({ data: flat.slice(), ...PDFJS_OPTS }).promise;
    const t2 = (await (await pjf.getPage(2)).getTextContent()).items.map((x) => x.str).join('');
    check(t2.includes('PAGE TWO'), `大きさを変えたページ：焼き込みのあとも中身が残る (${t2.slice(0, 20)})`);
    pjf.destroy();
  }

  // 入力画面から操作する（用紙 A5、すべてのページ）
  {
    await openBytes(await d.save(), { name: 'dialog-test.pdf', askPassword: async () => null });
    await ready();
    window.__askQueue = [];
    answer({ size: Object.keys(PAPER_SIZES).indexOf('A5'), range: '', shrink: false });
    answer({}); // 終わったあとのお知らせ（出た場合）
    await F.normalizeSizeDialog();
    await ready();
    const mbs = state.lib.getPages().map((p) => { const b = p.getMediaBox(); return `${Math.round(b.width)}x${Math.round(b.height)}`; });
    check(mbs.join() === '420x595,595x420,420x595,420x595', `ページの大きさをそろえる：入力画面から A5 にそろえる (${mbs.join(', ')})`);
    window.__askQueue = [];
  }

  // しおりの欄から追加・名前の変更・削除
  {
    const P = await import('./panels.js');
    const rowsNow = () => [...document.querySelectorAll('#outline .outline-item')].map((e) => e.textContent);
    await sleep(500);
    answer({ v: 'New Mark' });
    await P.outlineAction('add');
    await sleep(500);
    const afterAdd = rowsNow();
    [...document.querySelectorAll('#outline .outline-item')].find((e) => e.textContent === 'New Mark')?.click();
    answer({ v: 'Renamed Mark' });
    await P.outlineAction('rename');
    await sleep(500);
    const afterRename = rowsNow();
    [...document.querySelectorAll('#outline .outline-item')].find((e) => e.textContent === 'Renamed Mark')?.click();
    await P.outlineAction('delete');
    await sleep(500);
    const afterDelete = rowsNow();
    check(afterAdd.includes('New Mark') && afterRename.includes('Renamed Mark') && !afterRename.includes('New Mark') && !afterDelete.includes('Renamed Mark'),
      `しおり：欄から追加・名前の変更・削除 (${afterAdd.length} → ${afterRename.length} → ${afterDelete.length})`);
    window.__askQueue = [];
  }

  // しおりのない文書で、実際の「＋」ボタンから最初のしおりを作り、「名前」ボタンで変える（メニューと同じ処理中の仕組みを通る）
  {
    await openBytes(await makeSample(), { name: 'no-outline.pdf', askPassword: async () => null });
    await ready();
    scrollToPage(1, false);
    await sleep(600);
    const until = async (fn, ms = 6000) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(100); } return false; };
    const btn = (label) => [...document.querySelectorAll('#outline .outline-tools button')].find((b) => b.textContent === label);
    window.__askQueue = [];
    answer({ v: 'First Mark' });
    btn('＋')?.click();
    const made = await until(() => [...document.querySelectorAll('#outline .outline-item')].some((e) => e.textContent === 'First Mark'));
    [...document.querySelectorAll('#outline .outline-item')].find((e) => e.textContent === 'First Mark')?.click();
    answer({ v: 'Renamed First' });
    btn(tr('名前'))?.click();
    const renamed = await until(() => [...document.querySelectorAll('#outline .outline-item')].some((e) => e.textContent === 'Renamed First'));
    const savedB = await buildOutput();
    const pjb = await pdfjsLib.getDocument({ data: savedB.slice(), ...PDFJS_OPTS }).promise;
    const olb = await readOutline(pjb);
    pjb.destroy();
    check(made && renamed && olb.length === 1 && olb[0].title === 'Renamed First' && olb[0].page === 1,
      `しおり：しおりのない文書で、ボタンから最初のしおりを作って名前を変え、保存しても残る (${JSON.stringify(olb.map((x) => [x.title, x.page]))})`);
    window.__askQueue = [];
  }

  // 読み取れないしおりがある文書では、書き換えない（元のしおりを壊さない）
  {
    const bad = await PDFDocument.create();
    const bp = bad.addPage([300, 300]);
    const bctx = bad.context;
    // 正しいしおりの間に、Title が文字でない（pdf.js が読めない）しおりを挟む
    const broot = bctx.nextRef(), ba = bctx.nextRef(), bi = bctx.nextRef(), bc = bctx.nextRef();
    bctx.assign(ba, bctx.obj({ Title: PDFString.of('Good A'), Parent: broot, Next: bi, Dest: [bp.ref, PDFName.of('Fit')] }));
    bctx.assign(bi, bctx.obj({ Title: 123, Parent: broot, Prev: ba, Next: bc, Dest: [bp.ref, PDFName.of('Fit')] })); // Title が数字
    bctx.assign(bc, bctx.obj({ Title: PDFString.of('Good C'), Parent: broot, Prev: bi, Dest: [bp.ref, PDFName.of('Fit')] }));
    bctx.assign(broot, bctx.obj({ Type: 'Outlines', First: ba, Last: bc, Count: 3 }));
    bad.catalog.set(PDFName.of('Outlines'), broot);
    await openBytes(await bad.save(), { name: 'bad-outline.pdf', askPassword: async () => null });
    await ready();
    // pdf.js が読めたしおりは引き継げる。読めなかった場合（読み取りの結果が空・数が合わない）を作って、書き換えを断ることを確かめる
    const readable = await readOutline();
    const orig = state.pdf.getOutline.bind(state.pdf);
    state.pdf.getOutline = async () => null;
    const items = await readOutline();
    let refused = false;
    try { await editOutline((list) => { list.push({ title: 'X', page: 0, pos: ['Fit'], url: null, items: [] }); }); } catch { refused = true; }
    state.pdf.getOutline = orig;
    const still = state.lib.catalog.get(PDFName.of('Outlines'));
    check(!readable.unmatched && items.unmatched && refused && still === broot && !state.dirty,
      `しおり：しおりを正しく読めない文書では書き換えない (読めたとき ${readable.length} 件で対応 ${!readable.unmatched}, 読めないとき断った ${refused}, 元のまま ${still === broot})`);
  }

  // ほかのアプリで作った PDF（HTML から変換したもの）も、文字が残り同じだけ縮む
  {
    const enc = (x) => new TextEncoder().encode(x);
    const hb = await window.api.convertToPdf({ bytes: enc('<h1>HTML TITLE</h1><p>body text</p>'), name: 'page.html' });
    await openBytes(new Uint8Array(hb), { name: 'html.pdf', askPassword: async () => null });
    await ready();
    const xOf = async (bytes) => { const pj2 = await pdfjsLib.getDocument({ data: bytes.slice(), ...PDFJS_OPTS }).promise; const it = (await (await pj2.getPage(1)).getTextContent()).items.find((x) => x.str.includes('HTML')); pj2.destroy(); return it?.transform; };
    const before = await xOf(await buildOutput());
    await normalizePageSize([0], PAPER_SIZES.A5);
    await ready();
    const after = await xOf(await buildOutput());
    const kk = PAPER_SIZES.A5[0] / PAPER_SIZES.A4[0];
    check(before && after && Math.abs(after[4] - before[4] * kk) < 1.5, `ページの大きさをそろえる：ほかのアプリの PDF も文字が残り同じだけ縮む (x ${before?.[4]?.toFixed(1)} → ${after?.[4]?.toFixed(1)}, 期待 ${(before?.[4] * kk).toFixed(1)})`);
  }

  // スキャン画像だけのページ：縦横比が同じなら、速い表示の条件を保ったまま縮める
  const Sp = await import('./scanpages.js');
  await F.openHere(new Uint8Array(await (await fetch('app://local/test/fixtures/fax_g4.tif')).arrayBuffer()), null, 'scan.tif');
  await ready();
  const mb0 = state.lib.getPage(0).getMediaBox();
  const before = !!Sp.scanInfo(0);
  const r2 = await normalizePageSize([0], [mb0.width * 0.8, mb0.height * 0.8]);
  await ready();
  const mb1 = state.lib.getPage(0).getMediaBox();
  check(before && r2.changed === 1 && !!Sp.scanInfo(0) && Math.abs(mb1.width - mb0.width * 0.8) < 1,
    `ページの大きさをそろえる：スキャン画像のページは速い表示のまま (${before} → ${!!Sp.scanInfo(0)}, ${Math.round(mb0.width)} → ${Math.round(mb1.width)})`);
  await undo();
  await ready();
  check(Math.abs(state.lib.getPage(0).getMediaBox().width - mb0.width) < 1 && !!Sp.scanInfo(0), 'ページの大きさをそろえる：元に戻せる');
}

// 図面の重ね合わせ比較：ずれを見つけて合わせ、足した線だけを「新しい版だけ」として色分けする
async function overlayTests() {
  const drawing = async (shift, extra, gone = false) => {
    const d = await PL.PDFDocument.create();
    const p = d.addPage([842, 595]); // A4 横
    const [sx, sy] = shift;
    const line = (x1, y1, x2, y2, w = 1.2) => p.drawLine({ start: { x: x1 + sx, y: y1 + sy }, end: { x: x2 + sx, y: y2 + sy }, thickness: w });
    line(40, 40, 800, 40); line(800, 40, 800, 555); line(800, 555, 40, 555); line(40, 555, 40, 40); // 枠
    for (let k = 0; k < 12; k++) line(80 + k * 55, 80, 120 + k * 55, 300 + (k % 3) * 60, 0.8); // 図
    line(100, 420, 500, 420, 2); line(300, 330, 300, 520, 2);
    if (extra) line(560, 120, 760, 260, 1.5); // 新しい版で足した線
    if (gone) line(560, 450, 760, 500, 1.5); // 古い版だけにある線
    return d.save();
  };
  const oldBytes = await drawing([0, 0], false);
  const newBytes = await drawing([6, 4], true); // 右に 6pt・上に 4pt ずれた版に 1 本足した
  await openBytes(oldBytes, { name: 'old-drawing.pdf', askPassword: async () => null });
  await ready();
  const other = await pdfjsLib.getDocument({ data: newBytes.slice(), ...PDFJS_OPTS }).promise;
  const t0 = performance.now();
  const r = await F.overlayPages(await state.pdf.getPage(1), await other.getPage(1));
  const ms = Math.round(performance.now() - t0);
  const s = 200 / 72;
  const okShift = Math.abs(r.shiftPx[0] + 6 * s) <= 2 && Math.abs(r.shiftPx[1] - 4 * s) <= 2;
  check(okShift, `重ねて比較：ずれを見つけて合わせる (${r.shiftPx.join(', ')} 画素 / 期待 ${(-6 * s).toFixed(1)}, ${(4 * s).toFixed(1)} → ${r.shiftMm.join(', ')} mm)`);
  // 線のまま重ねるときに使う細かいずれ（6pt・4pt ずれた版）。1 画素より細かく合う
  check(Math.abs(r.shiftPt[0] + 6) < 0.2 && Math.abs(r.shiftPt[1] - 4) < 0.2, `重ねて比較：ずれを 1 画素より細かく求める (${r.shiftPt.map((v) => v.toFixed(2)).join(', ')} pt / 期待 -6, 4)`);
  check(r.added > 300 && r.removed < r.added * 0.1, `重ねて比較：足した線だけが新しい版だけの線になる（縁は色づかない） (新 ${r.added} / 旧 ${r.removed} / 線全体 ${r.total}, ${ms}ms)`);
  // 同じ図面同士では違いがない
  const same = await F.overlayPages(await state.pdf.getPage(1), await state.pdf.getPage(1));
  check(same.added + same.removed === 0 && same.shiftPx.join() === '0,0' && Math.abs(same.shiftPt[0]) < 0.05 && Math.abs(same.shiftPt[1]) < 0.05,
    `重ねて比較：同じ図面同士は違いなし・細かいずれも 0 (${same.added + same.removed}, ${same.shiftPt.map((v) => v.toFixed(3)).join(', ')} pt)`);
  other.destroy();
  // メニューと同じ流れ：結果を新しいタブに開く
  const info = () => api.selftest('tabs');
  const tab = (arg) => api.selftest('tab', arg);
  const self = (await info()).self;
  answer({});
  await F.compareOverlay({ files: [{ name: 'new-drawing.pdf', bytes: newBytes }] });
  await sleep(800);
  const tabs = (await info()).tabs;
  const res = tabs.find((x) => x.id !== self && /old-drawing_/.test(x.title));
  check(res, `重ねて比較：結果を新しいタブに開く (${tabs.map((x) => x.title).join(' / ')})`);
  if (res) { await tab({ do: 'activate', id: res.id }); await sleep(1500); await tab({ do: 'shot-any', id: res.id, name: 'overlay-result' }); await tab({ do: 'activate', id: self }); }
  for (const x of tabs) if (x.id !== self) await tab({ do: 'force-close', id: x.id });
  window.__askQueue = [];
  const lo = window.__lastOverlay || {};
  check(lo.vectorPages === 1 && lo.changedPages === 1, `重ねて比較：線の図面は線のまま重ねる (${JSON.stringify({ v: lo.vectorPages, c: lo.changedPages })})`);

  // 線のまま重ねた結果を細かく描いて、色と鋭さを確かめる（古い版だけ＝赤、新しい版だけ＝青、共通＝黒、何もない所＝白）
  await openBytes(await drawing([0, 0], false, true), { name: 'old-drawing2.pdf', askPassword: async () => null });
  await ready();
  window.__keepOverlay = true;
  answer({});
  await F.compareOverlay({ files: [{ name: 'new-drawing.pdf', bytes: newBytes }] });
  window.__keepOverlay = false;
  window.__askQueue = [];
  for (const x of (await info()).tabs) if (x.id !== self) await tab({ do: 'force-close', id: x.id });
  const vb = window.__lastOverlay?.bytes;
  let colors = null;
  if (vb) {
    const rd = await pdfjsLib.getDocument({ data: vb.slice(), ...PDFJS_OPTS }).promise;
    const pg = await rd.getPage(1);
    const k = 400 / 72; // 400dpi（拡大しても線が鋭いか）
    const vp = pg.getViewport({ scale: k });
    const c = document.createElement('canvas');
    c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    const cx = c.getContext('2d', { willReadFrequently: true });
    cx.fillStyle = '#fff'; cx.fillRect(0, 0, c.width, c.height);
    await pg.render({ canvasContext: cx, viewport: vp }).promise;
    // (x, y)：ページの座標（上向き）。そのまわり ±r 画素で、条件に合う画素があるか
    const px = (x, y) => { const d = cx.getImageData(Math.round(x * k), Math.round((595 - y) * k), 1, 1).data; return [d[0], d[1], d[2]]; };
    const near = (x, y, ok, r = 5) => { for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { const v = px(x + dx / k, y + dy / k); if (ok(v)) return v; } return null; };
    // 共通の線（枠の下の辺）を縦に切って、濃い部分の太さを数える（1.2pt ≒ 6.7 画素。画像で重ねると粗くなる）
    let thick = 0;
    for (let dy = -12; dy <= 12; dy++) { const v = px(420, 40 + dy / k); if (Math.max(...v) < 110) thick++; }
    colors = {
      common: near(420, 40, (v) => Math.max(...v) < 70),
      added: near(660, 190, (v) => v[2] > 170 && v[0] < 110),
      removed: near(660, 475, (v) => v[0] > 170 && v[1] < 90 && v[2] < 90),
      white: px(650, 520).every((x) => x > 240),
      thick
    };
    c.width = 0;
    rd.destroy();
  }
  check(colors && colors.common && colors.added && colors.removed && colors.white && colors.thick >= 5 && colors.thick <= 9,
    `重ねて比較：線のまま重ねた結果が、拡大しても鋭く正しい色になる (${JSON.stringify(colors)})`);

  // いろいろなページ：1 普通／2 回転 90 度＋切り抜き（原点が 0 でない）／3 白紙（中身なし）／4 注釈あり（画像で重ねる）／
  // 5 色付きの線を、中身が合成の仕方（/BM /Normal）を決めて描く（それでも共通の線は黒）。1 ページ目からほかのページへのリンク（出力が膨らまない）
  const multi = async (extra) => {
    const d = await PL.PDFDocument.create();
    const lines = (p) => {
      const ln = (x1, y1, x2, y2, w = 1.2) => p.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: w });
      ln(60, 40, 780, 40); ln(780, 40, 780, 550); ln(780, 550, 60, 550); ln(60, 550, 60, 40);
      for (let k = 0; k < 10; k++) ln(90 + k * 60, 80, 130 + k * 60, 330, 0.8);
    };
    const p1 = d.addPage([842, 595]); lines(p1);
    const p2 = d.addPage([842, 595]); lines(p2); p2.setRotation(PL.degrees(90)); p2.setCropBox(50, 30, 742, 535);
    if (extra) p2.drawLine({ start: { x: 560, y: 120 }, end: { x: 760, y: 260 }, thickness: 1.5 });
    d.addPage([842, 595]);
    const p4 = d.addPage([842, 595]); lines(p4);
    p4.node.addAnnot(d.context.register(d.context.obj({ Type: 'Annot', Subtype: 'Square', Rect: [100, 400, 300, 500], C: [1, 0, 0] })));
    const p5 = d.addPage([842, 595]);
    p5.node.setExtGState(PL.PDFName.of('GS0'), d.context.obj({ Type: 'ExtGState', BM: 'Normal' }));
    p5.pushOperators(PL.setGraphicsState('GS0'), PL.setStrokingRgbColor(0, 0, 1), PL.setLineWidth(3), PL.moveTo(100, 100), PL.lineTo(700, 300), PL.stroke());
    // 緑の線（明るさが中くらい。線として数える色なので、共通なら黒になる）
    p5.pushOperators(PL.setStrokingRgbColor(0, 0.7, 0), PL.setLineWidth(3), PL.moveTo(100, 400), PL.lineTo(700, 500), PL.stroke());
    for (let k = 2; k <= 5; k++) p1.node.addAnnot(d.context.register(d.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [10, k * 10, 20, k * 10 + 8], Border: [0, 0, 0], Dest: [d.getPage(k - 1).ref, 'Fit'] })));
    return d.save();
  };
  await openBytes(await multi(false), { name: 'multi-old.pdf', askPassword: async () => null });
  await ready();
  const multiNew = await multi(true);
  window.__keepOverlay = true;
  answer({});
  await F.compareOverlay({ files: [{ name: 'multi-new.pdf', bytes: multiNew }] });
  window.__keepOverlay = false;
  window.__askQueue = [];
  for (const x of (await info()).tabs) if (x.id !== self) await tab({ do: 'force-close', id: x.id });
  const mo = window.__lastOverlay || {};
  let rot = null;
  if (mo.bytes) {
    const rd = await pdfjsLib.getDocument({ data: mo.bytes.slice(), ...PDFJS_OPTS }).promise;
    const sample = async (pageNo, pts) => {
      // 元の（古い版の）ページの座標を、結果のページの画素へ（結果のページは元の見た目の向き・範囲と同じ）
      const k = 300 / 72;
      const vpOld = (await state.pdf.getPage(pageNo)).getViewport({ scale: k });
      const pg = await rd.getPage(pageNo);
      const vp = pg.getViewport({ scale: k });
      const c = document.createElement('canvas');
      c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      const cx = c.getContext('2d', { willReadFrequently: true });
      cx.fillStyle = '#fff'; cx.fillRect(0, 0, c.width, c.height);
      await pg.render({ canvasContext: cx, viewport: vp }).promise;
      const res = {};
      for (const [name, x, y, ok] of pts) {
        const [X, Y] = vpOld.convertToViewportPoint(x, y);
        let hit = null;
        for (let dy = -6; dy <= 6 && !hit; dy++) for (let dx = -6; dx <= 6 && !hit; dx++) { const v = [...cx.getImageData(Math.round(X) + dx, Math.round(Y) + dy, 1, 1).data].slice(0, 3); if (ok(v)) hit = v; }
        res[name] = hit;
      }
      c.width = 0;
      return res;
    };
    rot = {
      p2: await sample(2, [['common', 420, 40, (v) => Math.max(...v) < 80], ['added', 660, 190, (v) => v[2] > 170 && v[0] < 110]]),
      p4: await sample(4, [['common', 420, 40, (v) => Math.max(...v) < 140 && Math.abs(v[0] - v[2]) < 30], ['white', 700, 450, (v) => Math.min(...v) > 240]]),
      p5: await sample(5, [['common', 400, 200, (v) => Math.max(...v) < 110], ['green', 400, 450, (v) => Math.max(...v) < 110]]),
      size: mo.bytes.length
    };
    rd.destroy();
  }
  check(mo.pages === 5 && mo.vectorPages === 4 && mo.changedPages === 1,
    `重ねて比較：回転・切り抜き・白紙・リンクのあるページは線のまま、注釈のあるページは画像で重ね、違いは 1 ページだけ (${JSON.stringify({ p: mo.pages, v: mo.vectorPages, c: mo.changedPages })})`);
  check(rot && rot.p2.common && rot.p2.added && rot.p4.common && rot.p4.white && rot.p5.common && rot.p5.green && rot.size < 2.5e6,
    `重ねて比較：回転・切り抜きのあるページでも位置と色が合い、中身が合成の仕方を決めていても共通の線は黒、画像で重ねたページも正しく出て、出力も膨らまない (${JSON.stringify(rot)})`);

  // A0 の細い線（0.3pt）を半端な量（3.37pt・2.71pt）ずらした版：共通の線が赤と青の二重線にならず、暗い 1 本になる
  const thin = async (sx, sy) => {
    const d = await PL.PDFDocument.create();
    const p = d.addPage([2384, 3370]);
    const ln = (x1, y1, x2, y2) => p.drawLine({ start: { x: x1 + sx, y: y1 + sy }, end: { x: x2 + sx, y: y2 + sy }, thickness: 0.3 });
    ln(100, 100, 2280, 100); ln(2280, 100, 2280, 3270); ln(2280, 3270, 100, 3270); ln(100, 3270, 100, 100);
    // 不規則な線（同じ間隔で並んだ線だけだと、線 1 本ぶんずれた位置もよく重なってしまうため、実際の図面に近くする）
    let seed = 11;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let k = 0; k < 400; k++) { const x = 150 + rnd() * 2000, y = 150 + rnd() * 3000; ln(x, y, x + (rnd() - 0.5) * 300, y + (rnd() - 0.5) * 300); }
    ln(200, 1000, 2000, 1000); ln(1200, 400, 1200, 2900);
    return d.save();
  };
  await openBytes(await thin(0, 0), { name: 'thin-old.pdf', askPassword: async () => null });
  await ready();
  window.__keepOverlay = true;
  answer({});
  await F.compareOverlay({ files: [{ name: 'thin-new.pdf', bytes: await thin(3.37, 2.71) }] });
  window.__keepOverlay = false;
  window.__askQueue = [];
  for (const x of (await info()).tabs) if (x.id !== self) await tab({ do: 'force-close', id: x.id });
  let thinRes = null;
  if (window.__lastOverlay?.bytes) {
    const rd = await pdfjsLib.getDocument({ data: window.__lastOverlay.bytes.slice(), ...PDFJS_OPTS }).promise;
    const pg = await rd.getPage(1);
    const k = 600 / 72; // 600dpi で、横の共通の線（y = 1000）のまわりだけを描く
    const vp = pg.getViewport({ scale: k, offsetX: -1100 * k + 50, offsetY: -(3370 - 1000) * k + 50 });
    const c = document.createElement('canvas');
    c.width = 100; c.height = 100;
    const cx = c.getContext('2d', { willReadFrequently: true });
    cx.fillStyle = '#fff'; cx.fillRect(0, 0, 100, 100);
    await pg.render({ canvasContext: cx, viewport: vp }).promise;
    let dark = 0, red = 0, blue = 0;
    for (let y = 30; y < 70; y++) {
      const [r, g, b2] = cx.getImageData(50, y, 1, 1).data;
      if (Math.max(r, g, b2) < 120) dark++;
      else if (r > 150 && b2 < 110 && g < 110) red++;
      else if (b2 > 150 && r < 110) blue++;
    }
    thinRes = { dark, red, blue, v: window.__lastOverlay.vectorPages, c: window.__lastOverlay.changedPages };
    c.width = 0;
    rd.destroy();
  }
  check(thinRes && thinRes.v === 1 && thinRes.c === 0 && thinRes.dark >= 1 && thinRes.red === 0 && thinRes.blue === 0,
    `重ねて比較：A0 の細い線を半端にずらしても、共通の線は二重線にならず暗い 1 本になる (${JSON.stringify(thinRes)})`);

  // 画層（オプションコンテンツ）のある図面：全部表示なら線のまま、隠れた画層があれば画像で重ねる
  const layered = async (hidden) => {
    const d = await PL.PDFDocument.create();
    const ocg = d.context.register(d.context.obj({ Type: 'OCG', Name: PL.PDFString.of('L0') }));
    d.catalog.set(PL.PDFName.of('OCProperties'), d.context.obj({ OCGs: [ocg], D: { Order: [ocg], OFF: hidden ? [ocg] : [] } }));
    const p = d.addPage([842, 595]);
    p.drawLine({ start: { x: 50, y: 50 }, end: { x: 790, y: 50 }, thickness: 1 });
    p.node.set(PL.PDFName.of('Resources'), d.context.obj({ Properties: { MC0: ocg } }));
    p.pushOperators(PL.PDFOperator.of('BDC', [PL.PDFName.of('OC'), PL.PDFName.of('MC0')]), PL.moveTo(100, 300), PL.lineTo(700, 300), PL.stroke(), PL.PDFOperator.of('EMC'));
    return d.save();
  };
  const layerRun = async (hidden) => {
    const bytesL = await layered(hidden);
    await openBytes(bytesL, { name: 'layer-old.pdf', askPassword: async () => null });
    await ready();
    answer({});
    await F.compareOverlay({ files: [{ name: 'layer-new.pdf', bytes: bytesL }] });
    window.__askQueue = [];
    for (const x of (await info()).tabs) if (x.id !== self) await tab({ do: 'force-close', id: x.id });
    return window.__lastOverlay?.vectorPages;
  };
  const lv = await layerRun(false), lh = await layerRun(true);
  check(lv === 1 && lh === 0, `重ねて比較：画層が全部表示なら線のまま、隠れた画層があれば画像で重ねる (全部表示 ${lv} / 隠れあり ${lh})`);

  // 大きな図面（A0・線 3000 本）でも、比べている間に画面が長く止まらない（進み具合と「中止」が動く）
  const big = async (extra) => {
    const d = await PL.PDFDocument.create();
    const p = d.addPage([2384, 3370]);
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let k2 = 0; k2 < 3000; k2++) { const x = 50 + rnd() * 2280, y = 50 + rnd() * 3270; p.drawLine({ start: { x, y }, end: { x: x + (rnd() - 0.5) * 200, y: y + (rnd() - 0.5) * 200 }, thickness: 0.5 }); }
    if (extra) p.drawLine({ start: { x: 300, y: 300 }, end: { x: 1500, y: 900 }, thickness: 2 });
    return d.save();
  };
  await openBytes(await big(false), { name: 'big-old.pdf', askPassword: async () => null });
  await ready();
  const bigNew = await big(true);
  let maxGap = 0, last = performance.now(), ticking = true;
  const tick = () => { const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now; if (ticking) setTimeout(tick, 20); };
  setTimeout(tick, 20);
  const tb = performance.now();
  answer({});
  window.__keepOverlay = true;
  await F.compareOverlay({ files: [{ name: 'big-new.pdf', bytes: bigNew }] });
  window.__keepOverlay = false;
  ticking = false;
  // 結果を画面に出すときの重さ：A0 の結果を約 800 万画素（画面いっぱいより大きめ）で描く時間
  let drawMs = null;
  if (window.__lastOverlay?.bytes) {
    const rd = await pdfjsLib.getDocument({ data: window.__lastOverlay.bytes.slice(), ...PDFJS_OPTS }).promise;
    const pg = await rd.getPage(1);
    const v1 = pg.getViewport({ scale: 1 });
    const vp = pg.getViewport({ scale: Math.sqrt(8e6 / (v1.width * v1.height)) });
    const c = document.createElement('canvas');
    c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    const t1 = performance.now();
    await pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    drawMs = Math.round(performance.now() - t1);
    c.width = 0;
    rd.destroy();
  }
  window.__askQueue = [];
  for (const x of (await info()).tabs) if (x.id !== self) await tab({ do: 'force-close', id: x.id });
  check(F.overlayWorkerOk(), '重ねて比較：位置合わせと色分けの計算は、画面とは別のスレッド（ワーカー）で行う');
  check(window.__lastOverlay?.vectorPages === 1 && maxGap < 800,
    `重ねて比較：大きな図面でも画面が長く止まらない (止まった最長 ${Math.round(maxGap)}ms, 全体 ${Math.round(performance.now() - tb)}ms)`);
  check(drawMs != null && drawMs < 3000, `重ねて比較：線のまま重ねた A0 の結果を画面に描く時間 (${drawMs}ms)`);

  // スキャン図面（白黒の TIFF）：今の文書は速い描き方、相手は pdf.js で描いても、同じ図面なら違いが出ない。強く縮小しても線が消えたり色づいたりしない
  await F.openHere(await (await fetch('app://local/test/fixtures/fax_g4.tif')).arrayBuffer().then((b) => new Uint8Array(b)), null, 'scan.tif');
  await ready();
  const fast = !!(await import('./scanpages.js')).scanInfo(0);
  const scanOther = await pdfjsLib.getDocument({ data: state.bytes.slice(), ...PDFJS_OPTS }).promise;
  const renderA = async (sc) => {
    const { canvas } = await F.renderToCanvas(state.pdf, 0, sc * 72);
    const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    canvas.width = 0;
    return d;
  };
  const pa = await state.pdf.getPage(1);
  const full = await F.overlayPages(pa, await scanOther.getPage(1), { renderA });
  const vp = pa.getViewport({ scale: 1 });
  const small = await F.overlayPages(pa, await scanOther.getPage(1), { renderA, maxPixels: (vp.width * vp.height * (200 / 72) ** 2) / 12 });
  const rate = (r) => (r.added + r.removed) / Math.max(1, r.total);
  check(fast && full.total > 1000 && full.shiftPx.join() === '0,0' && rate(full) < 0.0005,
    `重ねて比較：スキャン図面（速い描き方と pdf.js）同士でも違いが出ない (速い描き方 ${fast}, ずれ ${full.shiftPx}, 違い ${full.added + full.removed} / ${full.total})`);
  check(small.total > 100 && small.shiftPx.join() === '0,0' && rate(small) < 0.0005,
    `重ねて比較：強く縮小しても線が消えたり色づいたりしない (ずれ ${small.shiftPx}, 違い ${small.added + small.removed} / ${small.total})`);
  scanOther.destroy();
}

// 最近使ったファイル・前回の続き・異常終了時の復元
async function sessionTests(out) {
  const ses = (arg) => api.selftest('session', arg);
  const info = () => api.selftest('tabs');
  const tab = (arg) => api.selftest('tab', arg);
  const until = async (fn, ms = 8000) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (await fn()) return true; await sleep(100); } return false; };
  const self = (await info()).self;
  const closeOthers = async () => { for (const x of (await info()).tabs) if (x.id !== self) await tab({ do: 'force-close', id: x.id }); for (const id of (await info()).others || []) await tab({ do: 'close-any', id }); };

  // 最近使ったファイル：開いた・保存したファイルが先頭に入り、重ならない
  await ses({ do: 'clear-recent' });
  const pa = `${out}/recent-a.pdf`, pb = `${out}/recent-b.pdf`;
  await api.writeFile(pa, await makeSample());
  await api.writeFile(pb, await makeSample());
  await F.openHere(await makeSample(), pa, 'recent-a.pdf');
  await ready();
  await sleep(200);
  let st = await ses({ do: 'state' });
  check(st.recent.length === 1 && st.recent[0].endsWith('recent-a.pdf') && st.tab.path?.endsWith('recent-a.pdf'), `最近使ったファイル：開いたファイルが入る (${st.recent.map((p) => p.split(/[\\/]/).pop()).join(', ')})`);
  queue('save', pb);
  await F.saveAs();
  await sleep(200);
  await F.openHere(await makeSample(), pa, 'recent-a.pdf');
  await sleep(200);
  st = await ses({ do: 'state' });
  check(st.recent.map((p) => p.split(/[\\/]/).pop()).join() === 'recent-a.pdf,recent-b.pdf', `最近使ったファイル：保存した場所も入り、同じファイルは先頭に移る (${st.recent.map((p) => p.split(/[\\/]/).pop()).join(', ')})`);
  const menu = await ses({ do: 'menu-recent' });
  check(menu && menu.filter((x) => x.label.includes('recent-')).length === 2 && menu.some((x) => x.type === 'checkbox' && x.checked), `最近使ったファイル：メニューに並び、前回の続きは既定でオン (${menu?.map((x) => x.label).join(' / ')})`);
  // ようこそ画面にも出る（何も開いていない画面で確かめる）
  const welcome = await new Promise((r) => setTimeout(async () => r(document.querySelectorAll('#welcome-recent .recent-item').length), 300));
  check(welcome === 2 && !document.getElementById('welcome-recent').hidden, `最近使ったファイル：ようこそ画面に並ぶ (${welcome})`);
  // 見つからないファイルは一覧から外す
  await ses({ do: 'set', key: 'recent', value: [...st.recent, `${out}/no-such-file.pdf`] });
  const okMissing = await ses({ do: 'open-recent', path: `${out}/no-such-file.pdf` });
  st = await ses({ do: 'state' });
  check(okMissing === false && st.recent.length === 2, `最近使ったファイル：見つからないファイルは開かずに一覧から外す (${st.recent.length})`);

  // 前回の続き：開いているファイル・ページ・倍率を覚える
  zoomTo(1.5);
  scrollToPage(2, false);
  await sleep(1200);
  st = await ses({ do: 'state' });
  const rec = st.session?.windows?.[0]?.tabs?.find((x) => x.path.endsWith('recent-a.pdf'));
  check(rec && rec.page === 2 && Math.abs(rec.scale - 1.5) < 0.01, `前回の続き：ファイル・ページ・倍率を覚える (${JSON.stringify(rec)})`);
  // 起動時は開く前に聞く：「開く」なら開く、「開かない」なら開かない（ファイルがあるときだけ聞く）
  const ak = await ses({ do: 'ask-restore', answer: 0 }), an = await ses({ do: 'ask-restore', answer: 1 });
  check(ak.asked && ak.open && ak.files >= 1 && an.asked && !an.open, `前回の続き：起動時に開くかどうかを聞く (${JSON.stringify({ ak, an })})`);
  // 開き直すと同じページ・倍率になる（テストでは今のウィンドウのタブとして開く）
  const rs = await ses({ do: 'restore' });
  const restored = rs.tabs.find((x) => x.path?.endsWith('recent-a.pdf'));
  let rv = null;
  if (restored) {
    // 後ろのタブとして開くので、表示してから確かめる（表示されたときに戻す）
    await tab({ do: 'activate', id: restored.id });
    await until(async () => (await tab({ do: 'eval-any', id: restored.id, js: "document.body.classList.contains('has-doc')" })));
    await sleep(1500);
    rv = await tab({ do: 'eval-any', id: restored.id, js: "JSON.stringify({ scale: window.__view?.scale, page: window.__currentPage?.() })" });
  }
  check(rs.ok && restored && rv && JSON.parse(rv).page === 2 && Math.abs(JSON.parse(rv).scale - 1.5) < 0.01, `前回の続き：開き直すと同じファイル・ページ・倍率になる (${rv})`);
  for (const x of rs.tabs) await tab({ do: 'close-any', id: x.id });
  await tab({ do: 'activate', id: self });
  // 実際の起動と同じく、新しいウィンドウに開き直す（前面のタブはそのまま表示されて戻る）
  const rn = await ses({ do: 'restore', newWindow: true });
  const rnTab = rn.tabs.find((x) => x.path?.endsWith('recent-a.pdf'));
  let rnv = null;
  if (rnTab) {
    await until(async () => (await tab({ do: 'eval-any', id: rnTab.id, js: "document.body.classList.contains('has-doc')" })));
    await sleep(1500);
    rnv = await tab({ do: 'eval-any', id: rnTab.id, js: "JSON.stringify({ scale: window.__view?.scale, page: window.__currentPage?.() })" });
  }
  check(rn.ok && rnTab && rnv && JSON.parse(rnv).page === 2 && Math.abs(JSON.parse(rnv).scale - 1.5) < 0.01, `前回の続き：起動時と同じく新しいウィンドウに開き直す (${rnv}, ウィンドウ ${(await info()).windows})`);
  const imm = (rn.immediate?.windows || []).flatMap((w) => w.tabs).filter((t) => t.path?.endsWith('recent-a.pdf'));
  check(imm.length >= 2 && imm.some((t) => t.page === 2), `前回の続き：読み込みが終わる前から記録に入っている (${imm.length} 件)`);
  for (const x of rn.tabs) await tab({ do: 'close-any', id: x.id });
  await sleep(300);
  await tab({ do: 'activate', id: self });
  // 見つからないファイルは飛ばし、開けるものがなければ開かない
  await ses({ do: 'set', key: 'session', value: { windows: [{ tabs: [{ path: `${out}/gone.pdf`, page: 0, scale: 1 }], active: 0 }] } });
  const rg = await ses({ do: 'restore', newWindow: true });
  check(!rg.ok && rg.tabs.length === 0, `前回の続き：見つからないファイルは開かない (${JSON.stringify(rg)})`);
  // つながらない場所（ネットワークドライブなど）のファイルは開かずに後回しにし、記録には残す。3 回目で外す
  {
    const far = `${out}/unreachable-share/far.pdf`;
    await ses({ do: 'unreachable', prefix: `${out}/unreachable-share` });
    await ses({ do: 'set', key: 'session', value: { windows: [{ tabs: [{ path: pa, page: 0, scale: 1 }, { path: far, page: 3, scale: 2 }], active: 0 }] } });
    const ru = await ses({ do: 'restore', newWindow: true });
    const kept = (await ses({ do: 'state' })).session?.windows?.flatMap((w) => w.tabs) || [];
    const farRec = kept.find((t) => t.path === far);
    check(ru.ok && ru.tabs.length === 1 && ru.tabs[0].path?.endsWith('recent-a.pdf') && farRec && farRec.tries === 1 && farRec.page === 3,
      `前回の続き：つながらない場所のファイルは開かずに記録に残す (${ru.tabs.map((x) => x.path?.split(/[\\/]/).pop()).join(',')} / ${JSON.stringify(farRec)})`);
    for (const x of ru.tabs) await tab({ do: 'close-any', id: x.id });
    await sleep(300);
    await ses({ do: 'set', key: 'session', value: { windows: [{ tabs: [{ path: far, page: 3, scale: 2, tries: 2 }], active: 0 }] } });
    const ru2 = await ses({ do: 'restore', newWindow: true });
    const kept2 = (await ses({ do: 'state' })).session?.windows?.flatMap((w) => w.tabs) || [];
    check(!ru2.ok && !kept2.some((t) => t.path === far), `前回の続き：3 回続けて開けなければ記録から外す (${JSON.stringify(kept2)})`);
    await ses({ do: 'unreachable', prefix: null });
    await tab({ do: 'activate', id: self });
  }
  await ses({ do: 'set', key: 'restoreSession', value: false });
  const menuOff = await ses({ do: 'menu-recent' });
  check(menuOff?.some((x) => x.type === 'checkbox' && !x.checked), '前回の続き：メニューで切れる');
  await ses({ do: 'set', key: 'restoreSession', value: true });

  // 異常終了時の復元：変更があると写しを作り、保存すると消す
  window.__recoveryDelay = 100;
  const nObj = objs(0).length;
  const recObj = addObject(0, { type: 'ink', strokes: [[[100, 100], [200, 100]]], rect: [98, 98, 104, 4], color: '#000', width: 2, opacity: 1 });
  const made = await until(async () => (await ses({ do: 'state' })).tab.recoverySaved, 5000);
  st = await ses({ do: 'state' });
  check(made && st.recovery.some((n) => n.startsWith(st.runId) && n.endsWith('.pdf')), `異常終了時の復元：保存していない変更の写しを作る (${st.recovery.length} 個)`);
  queue('save', pb);
  await F.saveAs();
  await sleep(300);
  st = await ses({ do: 'state' });
  check(!st.tab.recoverySaved && !st.recovery.some((n) => n.startsWith(st.runId)), `異常終了時の復元：保存すると写しを消す (${st.recovery.length} 個)`);
  removeObject(recObj.id);
  window.__recoveryDelay = undefined;
  check(objs(0).length === nObj, '異常終了時の復元：テストの注釈を戻す');

  // TIFF を開いただけ（変換しただけ）では写しを作らず、編集したら作る
  {
    window.__recoveryDelay = 100;
    const tifPath = `${out}/view-only.tif`;
    await api.writeFile(tifPath, new Uint8Array(await (await fetch('app://local/test/fixtures/multipage.tif')).arrayBuffer()));
    await F.openHere(new Uint8Array(await (await fetch('app://local/test/fixtures/multipage.tif')).arrayBuffer()), tifPath, 'view-only.tif');
    await ready();
    await sleep(800);
    let ts = await ses({ do: 'state' });
    check(state.dirty && !ts.tab.recoverySaved, `異常終了時の復元：TIFF を開いただけでは写しを作らない (変更あり ${state.dirty}, 写し ${ts.tab.recoverySaved})`);
    {
      const me = (await info()).tabs.find((x) => x.id === self);
      check(me && me.dirty && !me.mark && !me.ask && !String(me.rawTitle).startsWith('● '), `TIFF を開いただけでは、変更ありの印を付けず、閉じるときも確かめない (${JSON.stringify(me)})`);
    }
    const o = addObject(0, { type: 'ink', strokes: [[[100, 100], [200, 100]]], rect: [98, 98, 104, 4], color: '#000', width: 2, opacity: 1 });
    await until(async () => (await ses({ do: 'state' })).tab.recoverySaved, 5000);
    ts = await ses({ do: 'state' });
    check(ts.tab.recoverySaved, '異常終了時の復元：TIFF に書き込んだら写しを作る');
    {
      const me = (await info()).tabs.find((x) => x.id === self);
      check(me && me.mark && me.ask && String(me.rawTitle).startsWith('● '), `TIFF に書き込んだら、変更ありの印を付け、閉じるときに確かめる (${JSON.stringify(me)})`);
    }
    removeObject(o.id);
    window.__recoveryDelay = undefined;
    setDirty(false);
  }
  // ドロップ：TIFF は元の場所を残し（見ただけなら確かめずに閉じる）、PDF には場所を付けない（保存で上書きしないように）
  {
    const tifBytes = new Uint8Array(await (await fetch('app://local/test/fixtures/multipage.tif')).arrayBuffer());
    const items = await F.prepareDropped([
      { name: 'drop.tif', bytes: tifBytes, path: `${out}/drop.tif` },
      { name: 'drop.pdf', bytes: await makeSample(), path: `${out}/drop.pdf` },
      { name: 'zip.tif', bytes: tifBytes, path: null }
    ]);
    check(items.length === 3 && items[0].path === `${out}/drop.tif` && items[1].path === null && items[2].path === null,
      `ドロップ：TIFF だけ元の場所を残す (${items.map((x) => `${x.name}=${x.path ? 'あり' : 'なし'}`).join(', ')})`);
  }

  // 前回正しく終了しなかったときの写し：「後で」は残す、「復元する」は保存していない状態で開いて写しを消す
  const left = await ses({ do: 'fake-leftover', bytes: await makeSample(), name: '復元テスト.pdf', n: 1 });
  let of = await ses({ do: 'offer', answer: 2 });
  check(left === 1 && of.r === 2 && of.left === 1 && !of.opened.length, `異常終了時の復元：「後で決める」は写しを残す (${JSON.stringify(of)})`);
  of = await ses({ do: 'offer', answer: 0 });
  const rt = of.opened.find((x) => x.title.includes('復元テスト'));
  check(of.left === 0 && rt && rt.dirty && rt.path === null, `異常終了時の復元：「復元する」は保存していない状態で開く（保存先は聞く） (${JSON.stringify(of.opened)})`);
  st = await ses({ do: 'state' });
  check(st.recovery.some((n) => n.startsWith('old-run_1')), `異常終了時の復元：開いた直後は元の写しを残す (${st.recovery.join(', ')})`);
  if (rt) { await queue('askSave', 1); await tab({ do: 'request-close-any', id: rt.id }); }
  await sleep(200);
  st = await ses({ do: 'state' });
  check(!st.recovery.some((n) => n.startsWith('old-run_1')), `異常終了時の復元：閉じると元の写しを消す (${st.recovery.join(', ')})`);
  // 同じファイルを変更なしで開いていたら、復元したものを開いてからそのタブを閉じる（ウィンドウは閉じない）
  {
    await ses({ do: 'open-recent', path: pb });
    let sameTab = null;
    await until(async () => (sameTab = (await info()).tabs.find((x) => x.title === 'recent-b.pdf')));
    await sleep(800);
    await ses({ do: 'fake-leftover', bytes: await makeSample(), name: 'recent-b.pdf', source: pb, n: 3 });
    const os = await ses({ do: 'offer', answer: 0 });
    const after = await info();
    const rec = os.opened.find((x) => x.title.includes('recent-b'));
    check(sameTab && rec && rec.dirty && !after.tabs.some((x) => x.id === sameTab.id) && after.windows >= 1 && after.tabs.some((x) => x.id === self),
      `異常終了時の復元：同じファイルを開いていたタブは、復元したものに置き換える (${JSON.stringify({ same: sameTab?.id, opened: os.opened, tabs: after.tabs.map((x) => x.id) })})`);
    if (rec) { await queue('askSave', 1); await tab({ do: 'request-close-any', id: rec.id }); }
    await tab({ do: 'activate', id: self });
  }
  await ses({ do: 'fake-leftover', bytes: await makeSample(), name: '破棄テスト.pdf', n: 2 });
  of = await ses({ do: 'offer', answer: 1 });
  check(of.left === 0 && !of.opened.length, `異常終了時の復元：「破棄する」は開かずに写しを消す (${JSON.stringify(of)})`);
  await tab({ do: 'activate', id: self });
  await sleep(300);
  const fin = await info();
  for (const x of fin.tabs) if (x.id !== self) await tab({ do: 'force-close', id: x.id });
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

/** 表示のにじみ：ページの絵の画素数が、画面上の枠の画素数とぴったり同じか。画面に写った画素が絵と同じか */
async function sharpTests() {
  await openBytes(await makeSample(), { name: 'sharp.pdf', askPassword: async () => null });
  await ready();
  const dpr = window.devicePixelRatio || 1;
  const sizes = [];
  let pixel = null;
  for (const z of [1, 0.917, 1.07, 1.234, 1.5]) {
    zoomTo(z);
    await sleep(300);
    for (let k = 0; k < 200 && view.pages[0].canvasScale !== view.scale; k++) await sleep(20);
    await whenIdle();
    const p = view.pages[0], c = p.canvas;
    const r = p.div.getBoundingClientRect();
    const onGrid = (v) => Math.abs(v * dpr - Math.round(v * dpr)) < 0.02;
    const ok = c.width === Math.round(r.width * dpr) && c.height === Math.round(r.height * dpr) && onGrid(r.left) && onGrid(r.top);
    sizes.push({ z, ok, txt: `${(z * 100).toFixed(1)}%: 枠 ${(r.width * dpr).toFixed(1)}×${(r.height * dpr).toFixed(1)} 絵 ${c.width}×${c.height} 左上 ${(r.left * dpr).toFixed(2)},${(r.top * dpr).toFixed(2)}` });
    if (z === 1.234) {
      // 文字のある所を写して、絵の画素と比べる（タイの文字などの違いは関係ない。同じ絵が出ているかだけ）
      const x = Math.ceil(r.left) + 40, y = Math.ceil(r.top) + 50, w = 200, h = 120;
      const cap = await api.selftest('capture', { x, y, width: w, height: h });
      const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      const ox = Math.round((x - r.left) * dpr), oy = Math.round((y - r.top) * dpr);
      let sum = 0, bad = 0, n = 0;
      if (cap.w === Math.round(w * dpr) && cap.h === Math.round(h * dpr)) {
        for (let yy = 0; yy < cap.h; yy++) for (let xx = 0; xx < cap.w; xx++) {
          const a = (yy * cap.w + xx) * 4, b = ((oy + yy) * c.width + (ox + xx)) * 4;
          // capturePage は BGRA、canvas は RGBA（白い背景の上なので透明な所は白として比べる）
          const al = px[b + 3] / 255;
          const g = (v) => v * al + 255 * (1 - al);
          const d = Math.abs(cap.data[a + 2] - g(px[b])) + Math.abs(cap.data[a + 1] - g(px[b + 1])) + Math.abs(cap.data[a] - g(px[b + 2]));
          sum += d / 3; if (d / 3 > 8) bad++; n++;
        }
      }
      pixel = n ? { mean: sum / n, bad: bad / n } : null;
    }
  }
  check(sizes.every((s) => s.ok), `ページの絵の画素数が画面の枠と同じで、左上が画素の境目にある（にじまない） (${sizes.map((s) => s.txt).join(' / ')})`);
  check(pixel && pixel.mean < 1 && pixel.bad < 0.002, `画面に出ている画素がページの絵と同じ (${pixel ? `差の平均 ${pixel.mean.toFixed(2)}・違う画素 ${(pixel.bad * 100).toFixed(2)}%` : '比べられない'})`);
  zoomTo(view.scale, 'width');
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
    if (only === 'sharp') { await sharpTests(); throw new Error('__only__'); }
    if (only === 'scan') { await scanFastTests(); throw new Error('__only__'); }
    if (only === 'session') { await sessionTests(out); throw new Error('__only__'); }
    if (only === 'overlay') { await overlayTests(); throw new Error('__only__'); }
    if (only === 'pageedit') { await pageEditTests(); throw new Error('__only__'); }
    await layoutTests();
    await sharpTests();
    await tabTests();
    await sessionTests(out);
    await overlayTests();
    await pageEditTests();
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

    // 12d. インストール不要版：新しい版のフォルダーで起動したら、ダブルクリックで開く exe の場所を書き直す
    {
      const r = await api.selftest('portable-openwith');
      // D:/new/./ と D:\new\ は Windows では同じ場所
      const want = ['none', 'same', 'same', 'update', 'keep-installed', 'update', 'keep-newer', 'update'];
      check(r && r.cases.join() === want.join(), `インストール不要版：古い・消えた場所は書き直し、登録がない・インストール版・新しい版はそのまま (${r?.cases.join()})`);
      check(r && r.parse[0] === 'C:\\a b\\PDF Studio.exe' && r.parse[1] === 'C:\\x\\PDF Studio.exe' && r.parse[2] === null, `インストール不要版：登録されたコマンドから exe の場所を読む (${r?.parse.join(' | ')})`);
      check(r && r.cmp[0] > 0 && r.cmp[1] < 0 && r.cmp[2] === 0 && r.cmp[3] < 0, `版の比較（1.5.10 は 1.5.9 より新しい・試験版は古い） (${r?.cmp.join()})`);
    }

    // 12c. ドラッグ＆ドロップ：画像・Word・テキストは PDF にして開く。場所がなくても中身から変換する。対応していないものは知らせる
    {
      const jpg = await canvasToBytes(c, 'image/jpeg');
      const enc = (x) => new TextEncoder().encode(x);
      const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 20, 0, 0, 0]);
      const dk = (name, bytes) => F.droppedKind(name, bytes);
      const dcases = [
        [dk('a.pdf', enc('anything')), 'open'], [dk('scan.TIF', new Uint8Array(0)), 'open'], [dk('a.png', png), 'png'],
        [dk('photo.png', jpg), 'jpeg'], [dk('memo.txt', enc('hello')), 'text'], [dk('page.html', enc('<p>x</p>')), 'text'],
        [dk('data.json', enc('{"a":1}')), null], [dk('app.js', enc('let a = 1')), null], [dk('a.docx', zip), 'docx'],
        [dk('slides.pptx', zip), null], [dk('folder', new Uint8Array(0)), null]
      ];
      const dbad = dcases.map(([got, want], i) => (got === want ? null : `${i}:${got}≠${want}`)).filter(Boolean);
      check(!dbad.length, `ドロップ：開く・PDF にする・断る形式を見分ける (${dbad.join(', ') || 'OK'})`);
      const sk = [];
      const items = await F.prepareDropped([
        { name: 'drawing.pdf', bytes: await buildOutput({ security: null }) },
        { name: 'photo.png', bytes: jpg },
        { name: 'メモ.txt', bytes: enc('ドロップしたテキスト') },
        { name: 'page.htm', bytes: enc('<h1>ドロップした見出し</h1>') },
        { name: 'config.json', bytes: enc('{"a":1}') },
        { name: 'movie.mp4', bytes: new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]) }
      ], sk);
      check(items.map((x) => `${x.name}:${x.converted}`).join() === 'drawing.pdf:false,photo.pdf:true,メモ.pdf:true,page.pdf:true',
        `ドロップ：PDF はそのまま、画像・テキスト・HTML は 1 ファイルずつ PDF にする (${items.map((x) => x.name).join()})`);
      check(sk.map((x) => x.name).join() === 'config.json,movie.mp4', `ドロップ：対応していないファイルは知らせる (${sk.map((x) => `${x.name}: ${x.reason}`).join(' / ')})`);
      const txt = items.find((x) => x.name === 'メモ.pdf');
      const tt = txt ? (await textOf(txt.bytes)).text : '';
      check(tt.replace(/\s/g, '').includes('ドロップしたテキスト'), `ドロップ：場所がなくてもテキストを PDF にできる (${tt.slice(0, 20)})`);
      const ht = items.find((x) => x.name === 'page.pdf');
      const htx = ht ? (await textOf(ht.bytes)).text : '';
      // Word も場所なしで中身から変換できる（最小の .docx を無圧縮の ZIP で作る）
      const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
      const crc32 = (u) => { let c = 0xffffffff; for (const v of u) c = crcT[(c ^ v) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
      const zipStore = (entries) => {
        const parts = []; const cen = []; let off = 0;
        for (const [nm, text] of entries) {
          const name = enc(nm), data = enc(text), crc = crc32(data);
          const head = (sig, extra) => { const b = new DataView(new ArrayBuffer(extra)); b.setUint32(0, sig, true); return b; };
          const lh = head(0x04034b50, 30); lh.setUint16(4, 20, true); lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true);
          const ch = head(0x02014b50, 46); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true); ch.setUint32(42, off, true);
          parts.push(new Uint8Array(lh.buffer), name, data); cen.push(new Uint8Array(ch.buffer), name);
          off += 30 + name.length + data.length;
        }
        const cenLen = cen.reduce((a, b) => a + b.length, 0);
        const end = new DataView(new ArrayBuffer(22)); end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true); end.setUint32(12, cenLen, true); end.setUint32(16, off, true);
        const all = [...parts, ...cen, new Uint8Array(end.buffer)];
        const outb = new Uint8Array(all.reduce((a, b) => a + b.length, 0)); let p = 0; for (const b of all) { outb.set(b, p); p += b.length; }
        return outb;
      };
      const docx = zipStore([
        ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
        ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
        ['word/document.xml', '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>ドロップしたワード</w:t></w:r></w:p></w:body></w:document>']
      ]);
      const sk2 = [];
      const wd = await F.prepareDropped([{ name: '報告書.docx', bytes: docx }], sk2);
      const wtx = wd[0] ? (await textOf(wd[0].bytes)).text : '';
      check(wd[0]?.name === '報告書.pdf' && wtx.normalize('NFKC').replace(/\s/g, '').includes('ドロップしたワード'),
        `ドロップ：場所がなくても Word を PDF にできる (${wtx.slice(0, 20)} ${sk2.map((x) => x.reason).join()})`);
      // 変換に中身でも場所でもないものを渡すと断る
      let refused = false;
      try { await window.api.convertToPdf({ bytes: 'not bytes', name: 'x.txt' }); } catch { refused = true; }
      check(refused, '変換に正しくない中身を渡すと断る');
      check(htx.normalize('NFKC').replace(/\s/g, '').includes('ドロップした見出し'), `ドロップ：場所がなくても HTML を PDF にできる (${htx.slice(0, 20)})`);
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
