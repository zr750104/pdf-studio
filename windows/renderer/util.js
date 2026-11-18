// ダイアログ・通知などの UI ヘルパー
import { t } from './i18n.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'html') e.innerHTML = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) e.append(c instanceof Node ? c : document.createTextNode(c));
  return e;
}

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * 入力フォーム付きモーダル
 * fields: [{ key, label, type: text|number|color|select|checkbox|textarea|password|note, value, options, placeholder }]
 * 戻り値: 入力値のオブジェクト（キャンセル時は null）
 */
export function ask({ title, message = '', fields = [], ok = 'OK', cancel = 'キャンセル', width = 440, custom = null }) {
  // 表示の文字を訳す（自動翻訳より先に、改行を含む文章ごと訳す）
  title = t(title); message = t(message); ok = t(ok); cancel = cancel && t(cancel);
  fields = fields.map((f) => ({ ...f, label: t(f.label), placeholder: t(f.placeholder), options: f.options?.map((o) => (typeof o === 'object' ? { ...o, label: t(o.label) } : t(o))) }));
  // 自動テスト時は用意された回答を使う
  if (window.__askQueue?.length) {
    const a = window.__askQueue.shift();
    window.__askLog?.push(title);
    if (a === null) return Promise.resolve(null);
    const out = {};
    for (const f of fields) if (f.key && f.type !== 'note') out[f.key] = f.value ?? (f.type === 'checkbox' ? false : '');
    return Promise.resolve({ ...out, ...a });
  }
  return new Promise((resolve) => {
    const inputs = {};
    const form = el('form', { class: 'modal-form', onsubmit: (e) => { e.preventDefault(); done(true); } });
    for (const f of fields) {
      if (f.type === 'note') { form.append(el('p', { class: 'note' }, f.label)); continue; }
      let input;
      if (f.type === 'select') {
        input = el('select', {}, ...f.options.map((o, i) => el('option', { value: typeof o === 'object' ? o.value : i, selected: (typeof o === 'object' ? o.value : i) == f.value }, typeof o === 'object' ? o.label : o)));
      } else if (f.type === 'textarea') {
        input = el('textarea', { rows: f.rows || 4, placeholder: f.placeholder });
        input.value = f.value ?? '';
      } else if (f.type === 'checkbox') {
        input = el('input', { type: 'checkbox', checked: !!f.value });
        form.append(el('label', { class: 'check' }, input, ' ', f.label));
        inputs[f.key] = input;
        continue;
      } else {
        input = el('input', { type: f.type || 'text', placeholder: f.placeholder, step: f.step || 'any', min: f.min, max: f.max });
        input.value = f.value ?? '';
      }
      inputs[f.key] = input;
      form.append(el('label', { class: 'row' }, el('span', {}, f.label), input));
    }
    if (custom) form.append(custom);
    const okBtn = el('button', { type: 'submit', class: 'primary' }, ok);
    const cancelBtn = el('button', { type: 'button', onclick: () => done(false) }, cancel);
    const box = el('div', { class: 'modal', style: `width:${width}px` },
      el('h2', {}, title),
      message ? el('p', { class: 'message', html: escapeHtml(message).replace(/\n/g, '<br>') }) : null,
      form,
      el('div', { class: 'buttons' }, cancel ? cancelBtn : null, okBtn));
    okBtn.addEventListener('click', (e) => { e.preventDefault(); done(true); });
    const backdrop = el('div', { class: 'backdrop' }, box);
    // Esc は後ろの画面に伝えない（ツールの選択が解除されないように）
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); } };
    let closed = false;
    function done(okd) {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      setInert(-1);
      if (!okd) return resolve(null);
      const out = {};
      for (const [k, i] of Object.entries(inputs)) {
        out[k] = i.type === 'checkbox' ? i.checked : i.type === 'number' ? Number(i.value) : i.value;
      }
      resolve(out);
    }
    document.addEventListener('keydown', onKey, true);
    document.body.append(backdrop);
    setInert(1);
    const first = form.querySelector('input,textarea,select');
    setTimeout(() => (first || okBtn).focus(), 30);
    if (first && first.select) setTimeout(() => first.select(), 40);
  });
}

/** ダイアログ表示中は後ろの画面をキーボードでも操作できないようにする */
let modalDepth = 0;
function setInert(delta) {
  modalDepth = Math.max(0, modalDepth + delta);
  for (const id of ['toolbar', 'main']) {
    const n = document.getElementById(id);
    if (n) n.inert = modalDepth > 0;
  }
}

export async function alertBox(title, message = '') {
  await ask({ title, message, cancel: null });
}

export async function confirmBox(title, message = '', ok = 'OK') {
  return (await ask({ title, message, ok })) !== null;
}

export async function promptText(title, value = '', { message = '', multiline = false, placeholder = '' } = {}) {
  const r = await ask({ title, message, fields: [{ key: 'v', label: '', type: multiline ? 'textarea' : 'text', value, placeholder }] });
  return r ? r.v : null;
}

export function toast(message, ms = 2600) {
  // 前の通知と重ならないように、表示中の通知は消す
  for (const old of document.querySelectorAll('.toast')) old.remove();
  const n = el('div', { class: 'toast' }, t(message));
  document.body.append(n);
  setTimeout(() => n.classList.add('show'), 10);
  setTimeout(() => { n.classList.remove('show'); setTimeout(() => n.remove(), 300); }, ms);
}

/** 進捗表示。update(done, text) / close() / cancelled */
export function progress(title, total) {
  const bar = el('div', { class: 'bar-fill' });
  const label = el('div', { class: 'message' }, '');
  const p = { cancelled: false };
  const box = el('div', { class: 'modal', style: 'width:420px' }, el('h2', {}, t(title)), el('div', { class: 'bar' }, bar), label,
    el('div', { class: 'buttons' }, el('button', { onclick: () => { p.cancelled = true; label.textContent = '中止しています…'; } }, '中止')));
  const backdrop = el('div', { class: 'backdrop' }, box);
  document.body.append(backdrop);
  setInert(1);
  p.update = (done, text = '') => { bar.style.width = `${Math.round((done / Math.max(1, total)) * 100)}%`; label.textContent = `${done} / ${total}  ${t(text)}`; };
  p.close = () => { if (backdrop.isConnected) { backdrop.remove(); setInert(-1); } };
  return p;
}

/** "1-3, 5, 8-" を 0 始まりの配列に。空欄は全ページ */
export function parseRange(text, count) {
  const t = String(text || '').trim();
  if (!t || t === '全て' || t.toLowerCase() === 'all') return [...Array(count).keys()];
  const out = [];
  for (const part of t.replace(/、/g, ',').split(',')) {
    const p = part.trim();
    if (!p) continue;
    const m = p.match(/^(\d*)\s*[-~〜]\s*(\d*)$/);
    if (m) {
      const a = m[1] ? +m[1] : 1, b = m[2] ? +m[2] : count;
      if (a < 1 || b > count || a > b) return null;
      for (let i = a; i <= b; i++) out.push(i - 1);
    } else if (/^\d+$/.test(p)) {
      const n = +p;
      if (n < 1 || n > count) return null;
      out.push(n - 1);
    } else {
      return null;
    }
  }
  return [...new Set(out)];
}

export function compactRange(idx) {
  const s = [...idx].sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < s.length; i++) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    parts.push(i === j ? `${s[i] + 1}` : `${s[i] + 1}-${s[j] + 1}`);
    i = j;
  }
  return parts.join(', ');
}

export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
};

export function dataUrlToBytes(url) {
  return Uint8Array.from(atob(url.split(',')[1]), (c) => c.charCodeAt(0));
}

export function canvasToBytes(canvas, type = 'image/jpeg', quality = 0.88) {
  return new Promise((res) => canvas.toBlob(async (b) => res(new Uint8Array(await b.arrayBuffer())), type, quality));
}

export function baseName(name) {
  return String(name || 'document').replace(/\.[^.]+$/, '');
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
