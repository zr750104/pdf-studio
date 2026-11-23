// 図面の重ね合わせ比較：2 つの版のページを同じ縮尺の画像にし、位置のずれを合わせて重ね、
// 古い版だけにある線を赤、新しい版だけにある線を青、共通の線を灰色で描く。
// 線の太さ・にじみの違いで縁が色づかないよう、相手の版に近く（1〜2 画素以内）に線があれば共通とみなす。
// 位置合わせは平行移動だけ（回転・拡大縮小の違いは扱わない）。

/** 画像の画素から「線（暗い画素）」を 1/0 で取り出す */
export function darkMask(imageData, threshold = 160) {
  const { data, width, height } = imageData;
  const out = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    // 透明な部分は白とみなす
    const a = data[p + 3] / 255;
    const lum = (0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]) * a + 255 * (1 - a);
    out[i] = lum < threshold ? 1 : 0;
  }
  return out;
}

/** f 画素四方のどれかに線があれば 1（縮小しても細い線が消えないように） */
export function shrink(mask, w, h, f) {
  const w2 = Math.ceil(w / f), h2 = Math.ceil(h / f);
  const out = new Uint8Array(w2 * h2);
  for (let y = 0; y < h; y++) {
    const row = y * w, row2 = ((y / f) | 0) * w2;
    for (let x = 0; x < w; x++) if (mask[row + x]) out[row2 + ((x / f) | 0)] = 1;
  }
  return { mask: out, w: w2, h: h2 };
}

/** 線の画素の位置の一覧（多すぎるときは間引く） */
function samplePoints(mask, w, h, max = 60000) {
  let n = 0;
  for (let i = 0; i < mask.length; i++) n += mask[i];
  const step = Math.max(1, Math.ceil(n / max));
  const pts = [];
  let k = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    if (k++ % step === 0) pts.push(i % w, (i / w) | 0);
  }
  return pts;
}

/** a の線が b のどれだけの線と重なるか（b を (dx, dy) ずらしたとき） */
function score(pts, b, bw, bh, dx, dy) {
  let s = 0;
  for (let i = 0; i < pts.length; i += 2) {
    const x = pts[i] - dx, y = pts[i + 1] - dy;
    if (x >= 0 && y >= 0 && x < bw && y < bh && b[y * bw + x]) s++;
  }
  return s;
}

/**
 * 新しい版（b）を何画素ずらすと古い版（a）にいちばん重なるかを探す（平行移動のみ）。
 * 粗い画像で広く探し、細かい画像で詰める。maxFrac：探す範囲（画像の大きい辺に対する割合）
 * 戻り値：{ dx, dy, fx, fy }（b の画素を a の画素の位置へ置くときのずれ。a[x, y] ↔ b[x - dx, y - dy]。
 * fx / fy：1 画素より細かい残り（-0.5〜0.5。画像で重ねるときは使わない）
 */
export function findShift(a, aw, ah, b, bw, bh, maxFrac = 0.05) {
  const maxDim = Math.max(aw, ah, bw, bh);
  // 粗い順に：大きい辺が約 200・約 1000 画素、そして実寸
  const levels = [...new Set([Math.ceil(maxDim / 200), Math.ceil(maxDim / 1000), 1])].sort((x, y) => y - x);
  let dx = 0, dy = 0, prevF = null, fx = 0, fy = 0;
  for (const f of levels) {
    const A = f > 1 ? shrink(a, aw, ah, f) : { mask: a, w: aw, h: ah };
    const B = f > 1 ? shrink(b, bw, bh, f) : { mask: b, w: bw, h: bh };
    const pts = samplePoints(A.mask, A.w, A.h);
    if (!pts.length) return { dx: 0, dy: 0 };
    // 最初は広く、次からは前の段の 1 画素ぶん（＋1）の範囲だけ
    const R = prevF == null ? Math.ceil((maxDim * maxFrac) / f) + 1 : Math.ceil(prevF / f) + 1;
    const cx = Math.round(dx / f), cy = Math.round(dy / f);
    let best = -1, bx = cx, by = cy;
    for (let sy = cy - R; sy <= cy + R; sy++) {
      for (let sx = cx - R; sx <= cx + R; sx++) {
        const s = score(pts, B.mask, B.w, B.h, sx, sy);
        // 同点なら動かない方を選ぶ（白紙同士などで勝手にずらさない）
        if (s > best || (s === best && Math.abs(sx) + Math.abs(sy) < Math.abs(bx) + Math.abs(by))) { best = s; bx = sx; by = sy; }
      }
    }
    dx = bx * f;
    dy = by * f;
    prevF = f;
    if (f === 1) {
      // 1 画素より細かいずれ：重なりの点数の山を、前後の点数で放物線に当てはめて頂点を推定する（線のまま重ねるときに使う）
      const vertex = (m, c, p) => { const den = m - 2 * c + p; return den < 0 ? Math.max(-0.5, Math.min(0.5, (m - p) / (2 * den))) : 0; };
      fx = vertex(score(pts, B.mask, B.w, B.h, bx - 1, by), best, score(pts, B.mask, B.w, B.h, bx + 1, by));
      fy = vertex(score(pts, B.mask, B.w, B.h, bx, by - 1), best, score(pts, B.mask, B.w, B.h, bx, by + 1));
    }
  }
  return { dx, dy, fx, fy };
}

/** r 画素ぶん太らせる（四角い範囲の最大値。横と縦に分けて速く） */
export function dilate(mask, w, h, r) {
  if (r <= 0) return mask;
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let run = 0; // 直前の r 画素以内に線があったか（左から）
    for (let x = 0; x < w; x++) { if (mask[row + x]) run = r + 1; if (run > 0) { tmp[row + x] = 1; run--; } }
    run = 0;
    for (let x = w - 1; x >= 0; x--) { if (mask[row + x]) run = r + 1; if (run > 0) { tmp[row + x] = 1; run--; } }
  }
  for (let x = 0; x < w; x++) {
    let run = 0;
    for (let y = 0; y < h; y++) { if (tmp[y * w + x]) run = r + 1; if (run > 0) { out[y * w + x] = 1; run--; } }
    run = 0;
    for (let y = h - 1; y >= 0; y--) { if (tmp[y * w + x]) run = r + 1; if (run > 0) { out[y * w + x] = 1; run--; } }
  }
  return out;
}

/** b を (dx, dy) ずらして a と同じ大きさの画像に置く（はみ出した所は白） */
export function placeShifted(b, bw, bh, w, h, dx, dy) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = y - dy;
    if (sy < 0 || sy >= bh) continue;
    for (let x = 0; x < w; x++) {
      const sx = x - dx;
      if (sx >= 0 && sx < bw && b[sy * bw + sx]) out[y * w + x] = 1;
    }
  }
  return out;
}

export const COLORS = { both: [90, 90, 90], removed: [220, 30, 30], added: [20, 90, 235] };

/**
 * 重ねた画像を作る。a：古い版の線、b：新しい版の線（ずれを合わせて a と同じ大きさにしたもの）。
 * tol：この画素数以内に相手の線があれば共通とみなす。戻り値：{ image: ImageData | null, removed, added, total }
 */
export function compose(a, b, w, h, tol = 2, { image = true } = {}) {
  const da = dilate(a, w, h, tol), db = dilate(b, w, h, tol);
  // image=false：画像は作らず、違いの数だけを数える（線のまま重ねるときは画像を使わない）
  const img = image ? new ImageData(w, h) : null;
  const d = img ? img.data : null;
  let removed = 0, added = 0, total = 0;
  for (let i = 0, p = 0; i < a.length; i++, p += 4) {
    let c = null;
    if (a[i] && !db[i]) { c = COLORS.removed; removed++; }
    else if (b[i] && !da[i]) { c = COLORS.added; added++; }
    else if (a[i] || b[i]) c = COLORS.both;
    if (a[i] || b[i]) total++;
    if (!d) continue;
    if (c) { d[p] = c[0]; d[p + 1] = c[1]; d[p + 2] = c[2]; } else { d[p] = d[p + 1] = d[p + 2] = 255; }
    d[p + 3] = 255;
  }
  return { image: img, removed, added, total };
}

/**
 * 位置合わせと色分け（重い計算）をまとめて行う。ワーカーでも画面のスレッドでも同じものを使う。
 * 戻り値：{ dx, dy, removed, added, total, pixels: Uint8ClampedArray | null }
 */
export function analyze({ a, w, h, b, bw, bh, image }) {
  const { dx, dy, fx, fy } = findShift(a, w, h, b, bw, bh);
  const placed = placeShifted(b, bw, bh, w, h, dx, dy);
  const r = compose(a, placed, w, h, 2, { image });
  return { dx, dy, fx, fy, removed: r.removed, added: r.added, total: r.total, pixels: r.image ? r.image.data : null };
}

/** RGBA の画素を RGB にして、Flate（zlib）で圧縮する（PDF の画像にそのまま使える） */
export async function deflateRGB(pixels) {
  const n = pixels.length / 4;
  const rgb = new Uint8Array(n * 3);
  for (let i = 0, p = 0, q = 0; i < n; i++, p += 4, q += 3) { rgb[q] = pixels[p]; rgb[q + 1] = pixels[p + 1]; rgb[q + 2] = pixels[p + 2]; }
  const stream = new Blob([rgb]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** analyze に加えて、色分けした画像を圧縮するところまで行う。戻り値：{ dx, dy, removed, added, total, rgbz: Uint8Array | null } */
export async function analyzeFull(job) {
  const r = analyze(job);
  const rgbz = r.pixels ? await deflateRGB(r.pixels) : null;
  return { dx: r.dx, dy: r.dy, fx: r.fx, fy: r.fy, removed: r.removed, added: r.added, total: r.total, rgbz };
}
