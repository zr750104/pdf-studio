// 性能計測（`electron . --perftest`）。旧版でも動くよう、DOM と共通の関数だけを使う
import * as doc from './doc.js';
import * as viewer from './viewer.js';

const api = window.api;
const log = (s) => api.selftest('log', s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 画面が描かれないままでも止まらないよう、1 秒で先へ進む
const frame = () => new Promise((r) => { requestAnimationFrame(() => r()); setTimeout(r, 1000); });

async function makeBigPdf(pages) {
  const { PDFDocument, rgb, StandardFonts } = doc.PL;
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  for (let p = 1; p <= pages; p++) {
    const page = d.addPage([595.28, 841.89]);
    page.drawText(`Chapter ${p}`, { x: 50, y: 780, size: 22, font, color: rgb(0.1, 0.1, 0.4) });
    for (let i = 0; i < 45; i++) {
      page.drawText(`Line ${i} of page ${p}. The quick brown fox jumps over the lazy dog 0123456789.`, { x: 50, y: 750 - i * 15, size: 10, font });
    }
    for (let k = 0; k < 30; k++) page.drawRectangle({ x: 40 + (k % 10) * 52, y: 40 + Math.floor(k / 10) * 25, width: 45, height: 18, color: rgb((k * 37 % 255) / 255, 0.6, 0.8), opacity: 0.6 });
  }
  return d.save();
}

const canvases = () => [...document.querySelectorAll('canvas.page-canvas')];
const canvasPixels = () => canvases().reduce((s, c) => s + c.width * c.height, 0);
const heapMB = () => (performance.memory ? performance.memory.usedJSHeapSize / 1048576 : 0);

/** 1 ページ目の画像とテキストレイヤーができるまで待つ */
async function waitFirstPage(timeout = 30000) {
  const t0 = performance.now();
  for (;;) {
    const p = document.querySelector('.page[data-index="0"]');
    const c = p?.querySelector('canvas.page-canvas');
    const tl = p?.querySelector('.textLayer');
    if (c && c.width > 10 && (window.__noText || (tl && tl.children.length > 5))) return;
    if (performance.now() - t0 > timeout) throw new Error('timeout');
    await frame();
  }
}

async function settle(ms = 400) {
  // 描画が落ち着くまで待つ（新版は whenIdle、旧版は一定時間）
  if (viewer.whenIdle) { await sleep(50); await viewer.whenIdle(); } else await sleep(ms);
}

/** TIFF の読み込み時間（`--perftest --pf-tiff`、PDFSTUDIO_BENCH_DIR の *.tif を順に開く） */
async function tiffBench() {
  await log(`VIS start=${document.visibilityState} focus=${document.hasFocus()}`);
  const F = await import('./features.js');
  const T = await import('./tiff.js');
  for (const f of await api.selftest('benchFiles')) {
    const bytes = new Uint8Array(await api.selftest('benchRead', f));
    window.__tiffPassthru = /_pass/.test(f);
    const t0 = performance.now();
    await F.openHere(bytes, null, f);
    const tOpen = performance.now() - t0;
    await waitFirstPage().catch(() => {});
    const tFirst = performance.now() - t0;
    await settle();
    // 拡大したときに鮮明になるまでの時間（大きな図面の TIFF 用。PDFSTUDIO_BENCH_ZOOM=1 のとき）
    if (await api.selftest('benchZoom')) {
      const zr = [];
      for (const z of [0.25, 0.5, 1, 2]) {
        const tz = performance.now();
        viewer.zoomTo(z);
        const pg = viewer.view.pages[0];
        // 新しい倍率で描き終わる（と、見えている部分の細かい画像ができる）まで
        let tCanvas = 0;
        for (;;) {
          if (!tCanvas && pg.canvasScale === viewer.view.scale) tCanvas = performance.now() - tz;
          const d = pg.div.querySelector('canvas.page-detail');
          if (tCanvas && (!viewer.detailWanted?.(0) || (d && d.dataset.scale === String(viewer.view.scale)))) break;
          if (performance.now() - tz > 60000) break;
          await sleep(10);
        }
        const tDone = performance.now() - tz;
        const c = pg?.canvas;
        const needW = pg ? pg.div.getBoundingClientRect().width * (window.devicePixelRatio || 1) : 0;
        const detail = pg?.div.querySelector('canvas.page-detail');
        zr.push(`${z}:canvas=${Math.round(tCanvas)}ms sharp=${Math.round(tDone)}ms px=${c ? Math.round((c.width / needW) * 100) : 0}%${detail ? ` detail=${detail.width}x${detail.height}` : ''}`);
      }
      // 細かい画像の中身を確かめる：下地の同じ範囲・縮小版を使わない描き方と比べる
      {
        const S = await import('./scanpages.js');
        const pg0 = viewer.view.pages[0];
        const d = pg0.div.querySelector('canvas.page-detail');
        const base = pg0.canvas;
        const dr = pg0.div.getBoundingClientRect();
        const stat = (a, b) => {
          let diff = 0, da = 0, db = 0;
          for (let k = 0; k < a.length; k += 4) { diff += Math.abs(a[k] - b[k]); if (a[k] < 128) da++; if (b[k] < 128) db++; }
          const n = a.length / 4;
          return `mean=${(diff / n).toFixed(1)} dark=${((da / n) * 100).toFixed(2)}%/${((db / n) * 100).toFixed(2)}%`;
        };
        if (d && base) {
          const [x, y, w, h] = d.dataset.rect.split(',').map(Number);
          const k = base.width / dr.width;
          const bw = Math.max(1, Math.round(w * k)), bh = Math.max(1, Math.round(h * k));
          const t = document.createElement('canvas'); t.width = bw; t.height = bh;
          const tc = t.getContext('2d'); tc.imageSmoothingQuality = 'high'; tc.drawImage(d, 0, 0, bw, bh);
          const a = tc.getImageData(0, 0, bw, bh).data;
          const b = base.getContext('2d').getImageData(Math.round(x * k), Math.round(y * k), bw, bh).data;
          // 縮小版を使わずに同じ範囲を描く
          const info = S.scanInfo(0);
          S.setScanTestOptions({ pyramidMin: 1e12 });
          await sleep(50);
          const region = { x: (x / dr.width) * info.w, y: (y / dr.height) * info.h, w: (w / dr.width) * info.w, h: (h / dr.height) * info.h };
          const bmp = await S.renderScan(info, d.width, d.height, region);
          S.setScanTestOptions({ pyramidMin: 80e6 });
          const e = document.createElement('canvas'); e.width = d.width; e.height = d.height;
          const ec = e.getContext('2d'); ec.drawImage(bmp, 0, 0, d.width, d.height); bmp.close();
          const dd = d.getContext('2d').getImageData(0, 0, d.width, d.height).data;
          const ee = ec.getImageData(0, 0, d.width, d.height).data;
          zr.push(`check2x: vsBase(${stat(a, b)}) vsNoPyramid(${stat(dd, ee)})`);
          await api.selftest('shot', 'zoom2x');
        }
      }
      // 2 倍のまま横に動かす（0.1 秒ごとに 300px を 10 回）。止めてから、見えている部分が鮮明になるまで
      const vEl = document.querySelector('#viewer');
      const pg0 = viewer.view.pages[0];
      let during = 0, samples = 0;
      const covered = () => {
        const d = pg0.div.querySelector('canvas.page-detail');
        if (!d || d.dataset.scale !== String(viewer.view.scale)) return false;
        const r = pg0.div.getBoundingClientRect(), vr = vEl.getBoundingClientRect();
        const [dx, dy, dw, dh] = d.dataset.rect.split(',').map(Number);
        const x0 = Math.max(0, vr.left - r.left), x1 = Math.min(r.width, vr.right - r.left), y0 = Math.max(0, vr.top - r.top), y1 = Math.min(r.height, vr.bottom - r.top);
        return dx <= x0 + 1 && dy <= y0 + 1 && dx + dw >= x1 - 1 && dy + dh >= y1 - 1;
      };
      for (let k = 0; k < 10; k++) { vEl.scrollLeft += 300; await sleep(100); samples++; if (covered()) during++; }
      const tp = performance.now();
      while (!covered() && performance.now() - tp < 10000) await sleep(10);
      zr.push(`pan@2x: sharpDuring=${during}/${samples} settle=${Math.round(performance.now() - tp)}ms`);
      await log(`ZOOMBENCH ${f}: ${zr.join(' ')}`);
      viewer.zoomTo(viewer.view.scale, 'width');
      await settle();
    }
    const st = Object.fromEntries(Object.entries(T.lastStats.stages).map(([k, v]) => [k, Math.round(v)]));
    // 1 ページの描画時間（幅に合わせた大きさ、10 ページ分）
    const { state } = await import('./doc.js');
    const rt = [];
    for (let i = 20; i < Math.min(30, state.pdf.numPages); i++) {
      const pg = await state.pdf.getPage(i + 1);
      const vp = pg.getViewport({ scale: 1100 / pg.getViewport({ scale: 1 }).width });
      const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
      const t1 = performance.now();
      await pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      rt.push(Math.round(performance.now() - t1));
      pg.cleanup(); c.width = 0;
    }
    T.lastStats.info.renderMs = rt.join(',');
    // 同じページを速い表示で
    const S = await import('./scanpages.js');
    const ft = [];
    for (let i = 20; i < Math.min(30, state.pdf.numPages); i++) {
      const info = S.scanInfo(i);
      if (!info) { ft.push('x'); continue; }
      const pg = await state.pdf.getPage(i + 1);
      const vp = pg.getViewport({ scale: 1100 / pg.getViewport({ scale: 1 }).width });
      const t1 = performance.now();
      const bmp = await S.renderScan(info, Math.floor(vp.width), Math.floor(vp.height));
      ft.push(Math.round(performance.now() - t1));
      bmp.close();
    }
    T.lastStats.info.fastMs = ft.join(',');
    // スクロール：1 フレームごとに 60px（速めのホイール相当）で 4 秒、フレームの最長と、止めてから表示中のページが描かれるまで
    const vEl = document.querySelector('#viewer');
    vEl.scrollTop = 0; await settle();
    let worst = 0, last = performance.now(), blankFrames = 0, frames = 0;
    const tEnd = performance.now() + 4000;
    while (performance.now() < tEnd) {
      vEl.scrollTop += 60;
      await frame();
      const now = performance.now(); worst = Math.max(worst, now - last); last = now; frames++;
      const vis = [...document.querySelectorAll('.page')].filter((pg) => { const r = pg.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; });
      if (vis.some((pg) => !pg.querySelector('canvas.page-canvas'))) blankFrames++;
    }
    const tStop = performance.now();
    for (;;) {
      const vis = [...document.querySelectorAll('.page')].filter((pg) => { const r = pg.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; });
      if (vis.every((pg) => pg.querySelector('canvas.page-canvas')) || performance.now() - tStop > 20000) break;
      await frame();
    }
    T.lastStats.info.scroll = { frames, maxFrameMs: Math.round(worst), blankFramePct: Math.round((blankFrames / frames) * 100), settleMs: Math.round(performance.now() - tStop) };
    await log(`TIFFBENCH ${f}: open=${Math.round(tOpen)}ms first=${Math.round(tFirst)}ms idle=${Math.round(performance.now() - t0)}ms ${JSON.stringify(st)} ${JSON.stringify(T.lastStats.info || {})}`);
  }
  await api.selftest('done', 0);
}

export async function run() {
  const results = {};
  const flags = new URLSearchParams(location.search);
  if (flags.has('tiff')) { window.__noText = true; return tiffBench(); }
  if (flags.has('notext')) window.__noText = true;
  if (flags.has('nothumbs')) document.body.classList.add('no-sidebar');
  results.flags = location.search;
  // 画面の読み込み開始から、操作できる状態になるまで
  results.uiReadyMs = Math.round(performance.now());
  try {
    await log(`版: ${viewer.whenIdle ? '新' : '旧'}`);
    // この画面（タブ）のプロセス。タブバーも Tab として数えられるので、自分のものを選ぶ
    const tab = async () => { const m = await api.selftest('metrics'); return m ? (m.byType[`Tab-${m.self}`] ?? 0) : 0; };
    const bytes = await makeBigPdf(300);
    await sleep(1500);
    results.tabMB_start = await tab();
    await log(`PDF ${(bytes.length / 1048576).toFixed(1)} MB / 300 ページ`);
    await sleep(500);
    const heap0 = heapMB();

    // 1) 開いてから 1 ページ目が表示されるまで
    let t = performance.now();
    await doc.openBytes(bytes, { name: 'big.pdf', askPassword: async () => null });
    await waitFirstPage();
    results.openMs = Math.round(performance.now() - t);
    await sleep(500);
    results.tabMB_afterOpen = await tab();

    // 2) 最後までスクロール（1 画面ずつ）しながら、保持している画像の量を測る
    const viewerEl = document.getElementById('viewer');
    let maxCanvases = 0, maxPixels = 0;
    t = performance.now();
    const step = viewerEl.clientHeight * 0.9;
    let jank = 0;
    while (viewerEl.scrollTop + viewerEl.clientHeight < viewerEl.scrollHeight - 2) {
      const f0 = performance.now();
      viewerEl.scrollTop += step;
      await frame();
      jank = Math.max(jank, performance.now() - f0);
      await sleep(30);
      maxCanvases = Math.max(maxCanvases, canvases().length);
      maxPixels = Math.max(maxPixels, canvasPixels());
    }
    await settle(1500);
    results.scrollMs = Math.round(performance.now() - t);
    results.maxFrameMs = Math.round(jank);
    results.canvasesAfterScroll = canvases().length;
    results.canvasMPixAfterScroll = +(canvasPixels() / 1e6).toFixed(1);
    results.maxCanvases = maxCanvases;
    results.maxCanvasMPix = +(maxPixels / 1e6).toFixed(1);
    results.canvasMemMB = Math.round((canvasPixels() * 4) / 1048576);
    results.heapMB = Math.round(heapMB() - heap0);
    results.tabMB_afterScroll = await tab();
    // もう 2 往復して、メモリが増え続けないか（上限があるか）を見る
    results.passes = [];
    for (let pass = 0; pass < 5; pass++) {
      for (const dir of [-1, 1]) {
        while (dir < 0 ? viewerEl.scrollTop > 0 : viewerEl.scrollTop + viewerEl.clientHeight < viewerEl.scrollHeight - 2) {
          viewerEl.scrollTop += dir * step * 2;
          await frame();
          await sleep(15);
        }
        await settle(1500);
      }
      await sleep(2000);
      results.passes.push([await tab(), Math.round(heapMB()), document.querySelectorAll('*').length]);
    }
    await sleep(2500);
    results.tabMB_after3Passes = await tab();

    // 3) 連続ズーム（Ctrl+ホイールを想定）。1 回ごとに画面が止まる時間
    viewer.scrollToPage(150, false);
    await settle(1500);
    let worst = 0, total = 0;
    for (let k = 0; k < 12; k++) {
      const f0 = performance.now();
      viewer.zoomTo(viewer.view.scale * (k < 6 ? 1.15 : 1 / 1.15));
      await frame();
      const dt = performance.now() - f0;
      worst = Math.max(worst, dt);
      total += dt;
      await sleep(16);
    }
    results.zoomWorstFrameMs = Math.round(worst);
    results.zoomAvgFrameMs = Math.round(total / 12);
    t = performance.now();
    await settle(1500);
    results.zoomSettleMs = Math.round(performance.now() - t);
    // ズーム後、表示中のページが描かれているか（旧版で白紙になる不具合の確認）
    await sleep(300);
    const visible = [...document.querySelectorAll('.page')].filter((p) => {
      const r = p.getBoundingClientRect(), v = viewerEl.getBoundingClientRect();
      return r.bottom > v.top && r.top < v.bottom;
    });
    results.visiblePagesBlank = visible.filter((p) => !p.querySelector('canvas.page-canvas')?.width).length;
    const m = await api.selftest('metrics');
    if (m) results.processMemMB = m;
  } catch (e) {
    await log(`例外: ${e.stack || e}`);
  }
  await log(JSON.stringify(results));
  await api.selftest('done', 0);
}
