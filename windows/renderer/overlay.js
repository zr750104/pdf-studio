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
  const pts = [];
  // 多すぎるときは、決まった乱数で間引く（走査の順に一定間隔で取ると、太い線の同じ側だけが残って位置がずれるため）
  const keep = Math.min(1, max / Math.max(1, n));
  let seed = 12345;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    // Math.imul で 32 ビットのまま掛ける（普通の掛け算だと桁あふれで下位のビットが落ち、すぐ同じ並びをくり返す）
    if (keep < 1) { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; if (seed / 4294967296 >= keep) continue; }
    pts.push(i % w, (i / w) | 0);
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
  const better = (s, x, y, bs, bx, by) => s > bs || (s === bs && (Math.abs(x) + Math.abs(y) < Math.abs(bx) + Math.abs(by) ||
    (Math.abs(x) + Math.abs(y) === Math.abs(bx) + Math.abs(by) && (y < by || (y === by && x < bx)))));
  // 同じ間隔で並ぶ線（通り芯・格子など）では、粗い画像だと線 1 本ぶんずれた位置も同じくらい重なる。
  // そこで粗い段では候補を上位いくつか残し、細かい段でそれぞれを詰めて、いちばん重なるものを選ぶ
  const KEEP = 8;
  let cands = [{ dx: 0, dy: 0 }];
  let prevF = null, last = null;
  for (const f of levels) {
    const A = f > 1 ? shrink(a, aw, ah, f) : { mask: a, w: aw, h: ah };
    const B = f > 1 ? shrink(b, bw, bh, f) : { mask: b, w: bw, h: bh };
    const pts = samplePoints(A.mask, A.w, A.h);
    if (!pts.length) return { dx: 0, dy: 0, fx: 0, fy: 0 };
    const next = [];
    if (prevF == null) {
      // 最初の段は広く探し、山（まわり 1 画素より高い所）を点数の順に上位 KEEP 個残す。
      // 正しいずれが粗い画素の境目にかかると、点数が隣どうしに半分ずつ割れて、格子の 1 本ずれた位置（境目にかからない）に負ける。
      // そこで山は「その位置から右・下の 2×2 の合計」で比べ、その 2×2 の中でいちばん点数の高い位置を候補にする
      const R = Math.ceil((maxDim * maxFrac) / f) + 1;
      const side = 2 * R + 1;
      const raw = new Int32Array(side * side);
      for (let sy = -R; sy <= R; sy++) for (let sx = -R; sx <= R; sx++) raw[(sy + R) * side + (sx + R)] = score(pts, B.mask, B.w, B.h, sx, sy);
      const at = (x, y) => (x < -R || x > R || y < -R || y > R ? 0 : raw[(y + R) * side + (x + R)]);
      const sc = new Int32Array(side * side);
      for (let sy = -R; sy <= R; sy++) for (let sx = -R; sx <= R; sx++) sc[(sy + R) * side + (sx + R)] = at(sx, sy) + at(sx + 1, sy) + at(sx, sy + 1) + at(sx + 1, sy + 1);
      const peaks = [];
      for (let sy = -R; sy <= R; sy++) {
        for (let sx = -R; sx <= R; sx++) {
          const v = sc[(sy + R) * side + (sx + R)];
          let top = true;
          for (let ky = -1; ky <= 1 && top; ky++) for (let kx = -1; kx <= 1; kx++) {
            if (!kx && !ky) continue;
            const yy = sy + ky, xx = sx + kx;
            if (yy < -R || yy > R || xx < -R || xx > R) continue;
            const w = sc[(yy + R) * side + (xx + R)];
            // 同点の山は、動かない方に近いものだけを残す
            if (w > v || (w === v && Math.abs(xx) + Math.abs(yy) < Math.abs(sx) + Math.abs(sy))) { top = false; break; }
          }
          if (!top) continue;
          // 2×2 の中で、いちばん点数の高い位置（同点なら動かない方）
          let bx = sx, by = sy;
          for (const [qx, qy] of [[sx + 1, sy], [sx, sy + 1], [sx + 1, sy + 1]]) if (better(at(qx, qy), qx, qy, at(bx, by), bx, by)) { bx = qx; by = qy; }
          // s：その位置そのものの点数（次の段・放物線の当てはめで使う）。sum：2×2 の合計（山を比べるため）
          if (!peaks.some((p) => p.x === bx && p.y === by)) peaks.push({ s: at(bx, by), sum: v, x: bx, y: by });
        }
      }
      // 次に細かい段があれば 2×2 の合計で並べる。この段が最後（小さな画像で段が 1 つだけ）なら、その位置そのものの点数で並べる
      const key = f === 1 ? 's' : 'sum';
      peaks.sort((p, q) => (better(p[key], p.x, p.y, q[key], q.x, q.y) ? -1 : 1));
      // 点数で足切りはしない（境目にかかった正しい山が低く出ることがあるため）
      for (const p of peaks.slice(0, KEEP)) next.push({ dx: p.x * f, dy: p.y * f, s: p.s, bx: p.x, by: p.y });
    } else {
      // 次からは、候補ごとに前の段の 1 画素ぶん（＋1）の範囲だけ
      const R = Math.ceil(prevF / f) + 1;
      for (const c of cands) {
        const cx = Math.round(c.dx / f), cy = Math.round(c.dy / f);
        let best = -1, bx = cx, by = cy;
        for (let sy = cy - R; sy <= cy + R; sy++) {
          for (let sx = cx - R; sx <= cx + R; sx++) {
            const v = score(pts, B.mask, B.w, B.h, sx, sy);
            // 同点なら動かない方を選ぶ（白紙同士などで勝手にずらさない）
            if (better(v, sx, sy, best, bx, by)) { best = v; bx = sx; by = sy; }
          }
        }
        if (!next.some((n) => n.bx === bx && n.by === by)) next.push({ dx: bx * f, dy: by * f, s: best, bx, by });
      }
      next.sort((p, q) => (better(p.s, p.bx, p.by, q.s, q.bx, q.by) ? -1 : 1));
    }
    cands = next.slice(0, KEEP);
    prevF = f;
    last = { pts, B };
  }
  const top = cands[0];
  // 1 画素より細かいずれ：重なりの点数の山を、前後の点数で放物線に当てはめて頂点を推定する（線のまま重ねるときに使う）
  const { pts, B } = last;
  const vertex = (m, c, p) => { const den = m - 2 * c + p; return den < 0 ? Math.max(-0.5, Math.min(0.5, (m - p) / (2 * den))) : 0; };
  const fx = vertex(score(pts, B.mask, B.w, B.h, top.bx - 1, top.by), top.s, score(pts, B.mask, B.w, B.h, top.bx + 1, top.by));
  const fy = vertex(score(pts, B.mask, B.w, B.h, top.bx, top.by - 1), top.s, score(pts, B.mask, B.w, B.h, top.bx, top.by + 1));
  return { dx: top.dx, dy: top.dy, fx, fy };
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
