// スタンプ・印鑑・署名の画像を canvas で作る
import { el, ask, today, toast } from './util.js';
import { t, getLang } from './i18n.js';

const RED = '#d6191f';
const BLUE = '#1a4dbf';
const SCALE = 4;
const GOTHIC = '"Noto Sans JP","Yu Gothic","Meiryo",sans-serif';
const MINCHO = '"Yu Mincho","YuMincho","Hiragino Mincho ProN","MS Mincho",serif';

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.round(w * SCALE);
  c.height = Math.round(h * SCALE);
  const ctx = c.getContext('2d');
  ctx.scale(SCALE, SCALE);
  return { c, ctx };
}

function centerText(ctx, text, x, y, font, color) {
  ctx.font = font;
  ctx.fillStyle = color;
  const m = ctx.measureText(text);
  const asc = m.actualBoundingBoxAscent, desc = m.actualBoundingBoxDescent;
  ctx.fillText(text, x - m.width / 2, y + (asc - desc) / 2);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/** 枠付きの文字スタンプ。withDate が文字列なら、日付の代わりにその文字を下段に入れる */
export function textStamp(text, color, withDate) {
  const sub = typeof withDate === 'string' ? withDate : withDate ? today() : '';
  const { ctx: m } = canvas(1, 1);
  m.font = `700 28px ${GOTHIC}`;
  const tw = m.measureText(text).width;
  m.font = `700 11px ${GOTHIC}`;
  const w = Math.max(tw, m.measureText(sub).width, 70) + 36;
  const h = sub ? 66 : 50;
  const { c, ctx } = canvas(w, h);
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  roundRect(ctx, 3, 3, w - 6, h - 6, 8);
  ctx.stroke();
  ctx.lineWidth = 1;
  roundRect(ctx, 7, 7, w - 14, h - 14, 5);
  ctx.stroke();
  if (sub) {
    centerText(ctx, text, w / 2, 26, `700 28px ${GOTHIC}`, color);
    centerText(ctx, sub, w / 2, h - 18, `700 11px ${GOTHIC}`, color);
  } else {
    centerText(ctx, text, w / 2, h / 2, `700 28px ${GOTHIC}`, color);
  }
  return c.toDataURL('image/png');
}

/** 丸印（氏名を縦書き） */
export function hanko(name) {
  const chars = Array.from(name).slice(0, 4);
  const size = 80;
  const fs = { 1: 40, 2: 27, 3: 19, 4: 15 }[Math.max(1, chars.length)];
  const { c, ctx } = canvas(size, size);
  ctx.strokeStyle = RED;
  ctx.lineWidth = 3.5;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 3, 0, Math.PI * 2);
  ctx.stroke();
  const lineH = fs * 1.08;
  const total = lineH * chars.length;
  chars.forEach((ch, k) => centerText(ctx, ch, size / 2, size / 2 - total / 2 + lineH * (k + 0.5), `700 ${fs}px ${MINCHO}`, RED));
  return c.toDataURL('image/png');
}

/** 日付印（上段: 部署、中段: 日付、下段: 氏名） */
export function dateHanko(top, name) {
  const size = 90;
  const { c, ctx } = canvas(size, size);
  const cx = size / 2, cy = size / 2, r = size / 2 - 3;
  ctx.strokeStyle = RED;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  const band = 12;
  ctx.lineWidth = 1.5;
  for (const dy of [-band, band]) {
    const half = Math.sqrt(r * r - dy * dy);
    ctx.beginPath();
    ctx.moveTo(cx - half, cy + dy);
    ctx.lineTo(cx + half, cy + dy);
    ctx.stroke();
  }
  centerText(ctx, top, cx, cy - band - 13, `700 12px ${GOTHIC}`, RED);
  centerText(ctx, today(), cx, cy, `700 11px ${GOTHIC}`, RED);
  centerText(ctx, name, cx, cy + band + 14, `700 15px ${GOTHIC}`, RED);
  return c.toDataURL('image/png');
}

const GREEN = '#2b8a3e';

/** 日本語のスタンプ */
const STAMPS_JA = [
  { label: '承認', make: () => textStamp('承認', RED, true) },
  { label: '確認済', make: () => textStamp('確認済', BLUE, true) },
  { label: '機密', make: () => textStamp('機密', RED, false) },
  { label: '下書き', make: () => textStamp('下書き', BLUE, false) },
  { label: '却下', make: () => textStamp('却下', RED, true) },
  { label: '社外秘', make: () => textStamp('社外秘', RED, false) },
  { label: '受領', make: () => textStamp('受領', BLUE, true) },
  { label: '至急', make: () => textStamp('至急', RED, false) }
];

/** 英語のスタンプ（label は表示しないので訳さない） */
const STAMPS_EN = [
  ['APPROVED', RED, true], ['REVIEWED', BLUE, true], ['RECEIVED', BLUE, true], ['COMPLETED', GREEN, true],
  ['CONFIDENTIAL', RED, false], ['DRAFT', BLUE, false], ['FINAL', GREEN, false], ['FOR REVIEW', BLUE, false],
  ['REJECTED', RED, true], ['NOT APPROVED', RED, true], ['URGENT', RED, false], ['VOID', RED, false],
  ['PAID', GREEN, true], ['COPY', BLUE, false], ['SIGN HERE', RED, false], ['AS IS', BLUE, false]
].map(([text, color, date]) => ({ label: text, make: () => textStamp(text, color, date) }));

// ---------------------------------------------------------------- カスタムスタンプ

const loadCustom = () => { try { return JSON.parse(localStorage.getItem('customStamps') || '[]'); } catch { return []; } };
function saveCustom(list) {
  try {
    localStorage.setItem('customStamps', JSON.stringify(list));
    return true;
  } catch {
    toast('保存できるスタンプの容量を超えました。不要なスタンプを削除してください。', 4000);
    return false;
  }
}

/** 下段の文字（押すたびに日付・時刻を入れ直す動的スタンプ） */
function expandSub(t) {
  const d = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return String(t || '').replaceAll('{date}', today()).replaceAll('{time}', hm).replaceAll('{name}', localStorage.getItem('hankoName') || '');
}

/** 保存したカスタムスタンプの画像を作る（文字スタンプは押すときに作り直す） */
const renderCustom = (c) => (c.kind === 'image' ? c.src : textStamp(c.text, c.color, expandSub(c.sub)));

async function createTextStamp() {
  const r = await ask({ title: '文字スタンプを作成', fields: [
    { key: 'text', label: '文字', value: '' },
    { key: 'color', label: '色', type: 'color', value: RED },
    { key: 'sub', label: '下段', value: '{date}', placeholder: '空欄で 1 段' },
    { type: 'note', label: '下段には {date}（押した日）・{time}（時刻）・{name}（印鑑の氏名）が使えます。押すたびに最新の値になります。' }] });
  if (!r || !r.text.trim()) return null;
  return { kind: 'text', text: r.text.trim(), color: r.color, sub: r.sub };
}

/** 画像（PNG / JPEG）からスタンプを作る。大きすぎる画像は縮小して保存する */
async function createImageStamp() {
  const files = await window.api.openDialog({ title: 'スタンプにする画像', filters: [{ name: '画像', extensions: ['png', 'jpg', 'jpeg'] }] });
  if (!files.length) return null;
  const f = files[0];
  const blob = new Blob([f.bytes], { type: /\.png$/i.test(f.name) ? 'image/png' : 'image/jpeg' });
  try {
    const bmp = await createImageBitmap(blob);
    const k = Math.min(1, 600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * k));
    c.height = Math.max(1, Math.round(bmp.height * k));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();
    return { kind: 'image', src: c.toDataURL('image/png'), name: f.name };
  } catch (e) {
    toast(`画像を読み込めませんでした: ${e.message}`);
    return null;
  }
}

/** スタンプ選択ダイアログ。選んだ画像の dataURL を返す */
export async function chooseStamp() {
  await document.fonts.load(`700 28px "Noto Sans JP"`);
  let chosen = null;
  const grid = el('div', { class: 'stamp-grid' });
  const gridEn = el('div', { class: 'stamp-grid' });
  const pick = (src) => { chosen = src; grid.closest('.backdrop')?.querySelector('button.primary')?.click(); };
  const fill = (g, list) => {
    for (const s of list) {
      const src = s.make();
      g.append(el('button', { type: 'button', class: 'stamp-item', title: s.label, translate: 'no', onclick: () => pick(src) }, el('img', { src })));
    }
  };
  fill(grid, STAMPS_JA);
  fill(gridEn, STAMPS_EN);
  grid.append(el('button', { type: 'button', class: 'stamp-item text', onclick: async () => { chosen = 'hanko'; pick('hanko'); } }, '印鑑（氏名）…'));
  grid.append(el('button', { type: 'button', class: 'stamp-item text', onclick: () => { chosen = 'date'; pick('date'); } }, '日付印…'));

  // カスタムスタンプ
  const custom = loadCustom();
  const cgrid = el('div', { class: 'stamp-grid' });
  const renderGrid = () => {
    cgrid.replaceChildren(...custom.map((c, k) => el('div', { class: 'stamp-cell' },
      el('button', { type: 'button', class: 'stamp-item', title: c.text || c.name || '', onclick: () => pick(renderCustom(c)) }, el('img', { src: renderCustom(c) })),
      el('button', { type: 'button', class: 'small stamp-del', title: '削除', onclick: () => { custom.splice(k, 1); saveCustom(custom); renderGrid(); } }, '×'))));
    if (!custom.length) cgrid.append(el('p', { class: 'note', style: 'grid-column:1/-1' }, 'よく使う文字や社印の画像をスタンプとして登録できます。'));
  };
  renderGrid();
  const addWith = (make) => async () => {
    const c = await make();
    if (!c) return;
    custom.push(c);
    if (!saveCustom(custom)) { custom.pop(); return; }
    renderGrid();
  };
  // 英語表示のときは英語のスタンプを先に並べる
  const sections = [[el('h4', { class: 'stamp-heading first' }, '日本語のスタンプ'), grid], [el('h4', { class: 'stamp-heading' }, '英語のスタンプ'), gridEn]];
  if (getLang() !== 'ja') sections.reverse();
  sections[0][0].classList.add('first');
  sections[1][0].classList.remove('first');
  const box = el('div', {}, ...sections.flat(),
    el('h4', { class: 'stamp-heading' }, 'カスタムスタンプ'), cgrid,
    el('div', { class: 'row-inline' },
      el('button', { type: 'button', onclick: addWith(createTextStamp) }, '＋ 文字スタンプ…'),
      el('button', { type: 'button', onclick: addWith(createImageStamp) }, '＋ 画像から…')));
  const r = await ask({ title: 'スタンプ・印鑑', message: 'クリックして選んでください。', custom: box, ok: '閉じる', width: 540 });
  if (!r || !chosen) return null;
  if (chosen === 'hanko') {
    const v = await ask({ title: '印鑑', fields: [{ key: 'name', label: '氏名（1〜4文字）', value: localStorage.getItem('hankoName') || '' }] });
    if (!v || !v.name.trim()) return null;
    localStorage.setItem('hankoName', v.name.trim());
    return hanko(v.name.trim());
  }
  if (chosen === 'date') {
    const v = await ask({ title: '日付印', fields: [
      { key: 'top', label: '上段（部署など）', value: localStorage.getItem('dateTop') || t('総務部') },
      { key: 'name', label: '下段（氏名）', value: localStorage.getItem('hankoName') || '' }] });
    if (!v) return null;
    localStorage.setItem('dateTop', v.top);
    return dateHanko(v.top, v.name);
  }
  return chosen;
}

// ---------------------------------------------------------------- 署名

const loadSignatures = () => { try { return JSON.parse(localStorage.getItem('signatures') || '[]'); } catch { return []; } };
function saveSignatures(list) {
  try {
    localStorage.setItem('signatures', JSON.stringify(list));
    return true;
  } catch {
    toast('保存できる署名の数を超えました。不要な署名を削除してください。', 4000);
    return false;
  }
}

export async function chooseSignature() {
  let chosen = null;
  const list = loadSignatures();
  const wrap = el('div', { class: 'sig-list' });
  const render = () => {
    wrap.innerHTML = '';
    list.forEach((src, k) => {
      wrap.append(el('div', { class: 'sig-item' },
        el('img', { src, onclick: () => { chosen = src; wrap.closest('.backdrop').querySelector('button.primary').click(); } }),
        el('button', { type: 'button', class: 'small', title: '削除', onclick: () => { list.splice(k, 1); saveSignatures(list); render(); } }, '×')));
    });
    if (!list.length) wrap.append(el('p', { class: 'note' }, '保存された署名はありません。'));
  };
  render();
  const create = el('button', { type: 'button', onclick: async () => {
    const src = await createSignature();
    if (src) { list.unshift(src); saveSignatures(list); chosen = src; wrap.closest('.backdrop').querySelector('button.primary').click(); }
  } }, '＋ 新しい署名を作成…');
  const r = await ask({ title: '署名', message: '使う署名をクリックしてください。', custom: el('div', {}, wrap, create), ok: '閉じる', width: 480 });
  return r ? chosen : null;
}

/** 手書き（マウス/ペン）または文字入力で署名を作る */
async function createSignature() {
  const W = 440, H = 170;
  const pad = el('canvas', { class: 'sig-pad', width: W * 2, height: H * 2, style: `width:${W}px;height:${H}px` });
  const ctx = pad.getContext('2d');
  ctx.scale(2, 2);
  const strokes = [];
  const drawAll = () => {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#ccc';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(20, H - 40); ctx.lineTo(W - 20, H - 40); ctx.stroke();
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 2.6;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const s of strokes) {
      ctx.beginPath();
      s.forEach((p, k) => (k ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
      if (s.length === 1) ctx.lineTo(s[0][0] + 0.1, s[0][1]);
      ctx.stroke();
    }
  };
  drawAll();
  pad.addEventListener('pointerdown', (e) => {
    pad.setPointerCapture(e.pointerId);
    strokes.push([[e.offsetX, e.offsetY]]);
    drawAll();
  });
  pad.addEventListener('pointermove', (e) => {
    if (!(e.buttons & 1) || !strokes.length) return;
    strokes[strokes.length - 1].push([e.offsetX, e.offsetY]);
    drawAll();
  });
  const typed = el('input', { type: 'text', placeholder: 'または文字で入力（例: 山田 太郎）', style: 'flex:1' });
  const font = el('select', {}, ...[['筆記体', '"Segoe Script","Brush Script MT",cursive'], ['明朝', MINCHO], ['ゴシック', GOTHIC]].map(([l, v]) => el('option', { value: v }, l)));
  const custom = el('div', {}, pad, el('div', { class: 'row-inline' }, typed, font, el('button', { type: 'button', onclick: () => { strokes.length = 0; drawAll(); } }, 'クリア')));
  const r = await ask({ title: '署名を作成', message: 'マウス・ペン・タッチで署名してください。作成した署名は保存され、次回から選べます。', custom, ok: '保存して使う', width: 500 });
  if (!r) return null;
  if (strokes.length) {
    const pts = strokes.flat();
    const minX = Math.min(...pts.map((p) => p[0])) - 4, maxX = Math.max(...pts.map((p) => p[0])) + 4;
    const minY = Math.min(...pts.map((p) => p[1])) - 4, maxY = Math.max(...pts.map((p) => p[1])) + 4;
    const { c, ctx: o } = canvas(maxX - minX, maxY - minY);
    o.translate(-minX, -minY);
    o.strokeStyle = '#111';
    o.lineWidth = 2.6;
    o.lineCap = 'round';
    o.lineJoin = 'round';
    for (const s of strokes) {
      o.beginPath();
      s.forEach((p, k) => (k ? o.lineTo(p[0], p[1]) : o.moveTo(p[0], p[1])));
      if (s.length === 1) o.lineTo(s[0][0] + 0.1, s[0][1]);
      o.stroke();
    }
    return c.toDataURL('image/png');
  }
  if (typed.value.trim()) {
    const f = `44px ${font.value}`;
    const { ctx: m } = canvas(1, 1);
    m.font = f;
    const mt = m.measureText(typed.value);
    const w = mt.width + 12, h = 64;
    const { c, ctx: o } = canvas(w, h);
    o.font = f;
    o.fillStyle = '#111';
    o.fillText(typed.value, 6, 46);
    return c.toDataURL('image/png');
  }
  return null;
}
