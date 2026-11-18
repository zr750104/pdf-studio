// 画面のレイアウト：入りきらないツールバーの項目を「»」メニューにまとめる・左右のパネルの幅を変える
import { el } from './util.js';
import { t } from './i18n.js';

const SETTINGS_KEY = 'layout';
const loadLayout = () => { try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch { return {}; } };
export function saveLayout(patch) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...loadLayout(), ...patch })); } catch { /* 保存できなくても動作は続ける */ }
}
export const layoutSetting = (k, def) => loadLayout()[k] ?? def;

// ---------------------------------------------------------------- 入りきらない項目のメニュー

const bars = [];

/**
 * bar の子要素のうち、幅に入りきらないものを隠し、末尾の「»」ボタンからメニューで出す。
 * fixed（右端に常に表示する要素）は対象外。メニューを開いている間は、隠した要素そのものをメニューへ移す
 * （ボタンや入力欄の動作をそのまま使うため）。閉じると元の位置に戻す
 */
export function overflowBar(bar, { fixed = null, menuClass = '' } = {}) {
  const more = el('button', { class: 'tb ovf-more', title: t('その他'), 'aria-haspopup': 'true' }, '»');
  if (fixed) bar.insertBefore(more, fixed);
  else bar.append(more);
  const state = { bar, fixed, more, hidden: [], popup: null, placeholders: [] };

  const items = () => [...bar.children].filter((c) => c !== more && c !== fixed);

  function close() {
    if (!state.popup) return;
    // 元の位置に戻す
    for (const [node, ph] of state.placeholders) { ph.replaceWith(node); }
    state.placeholders = [];
    state.popup.remove();
    state.popup = null;
    more.classList.remove('active');
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
  }
  const onOutside = (e) => { if (!state.popup?.contains(e.target) && e.target !== more) close(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };

  function open() {
    if (state.popup) { close(); return; }
    const popup = el('div', { class: `ovf-popup ${menuClass}` });
    for (const node of state.hidden) {
      const ph = document.createComment('ovf');
      node.replaceWith(ph);
      state.placeholders.push([node, ph]);
      node.classList.remove('ovf-hidden');
      popup.append(node);
    }
    // 先頭・末尾・連続した区切り線は出さない
    const kids = [...popup.children];
    kids.forEach((k, i) => {
      const isSep = k.classList.contains('sep');
      if (isSep && (i === 0 || i === kids.length - 1 || kids[i - 1]?.classList.contains('sep'))) k.classList.add('ovf-skip');
    });
    document.body.append(popup);
    const r = more.getBoundingClientRect();
    const pw = popup.offsetWidth;
    popup.style.top = `${r.bottom + 4}px`;
    popup.style.left = `${Math.max(4, Math.min(innerWidth - pw - 4, r.right - pw))}px`;
    state.popup = popup;
    more.classList.add('active');
    // ボタン（ツール・操作）を押したら閉じる。入力欄の操作では閉じない
    popup.addEventListener('click', (e) => { if (e.target.closest('button.tb')) setTimeout(close, 0); });
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
  }
  more.addEventListener('click', open);

  function layout() {
    close();
    const list = items();
    for (const c of list) c.classList.remove('ovf-hidden');
    more.classList.remove('ovf-hidden');
    const cs = getComputedStyle(bar);
    const gap = parseFloat(cs.columnGap) || 0;
    const avail = bar.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - (fixed ? fixed.getBoundingClientRect().width + gap : 0) - 2;
    // 幅は左右の余白（区切り線の margin など）も含める
    const outer = (c) => {
      const w = c.getBoundingClientRect().width;
      if (!w) return 0;
      const st = getComputedStyle(c);
      return w + (parseFloat(st.marginLeft) || 0) + (parseFloat(st.marginRight) || 0);
    };
    const widths = list.map(outer);
    const total = widths.reduce((s, w) => s + (w ? w + gap : 0), 0);
    state.hidden = [];
    if (total <= avail + 0.5) {
      more.classList.add('ovf-hidden');
      return;
    }
    const room = avail - (outer(more) + gap);
    let used = 0;
    let cut = list.length;
    for (let i = 0; i < list.length; i++) {
      const w = widths[i];
      if (!w) continue;
      if (used + w > room) { cut = i; break; }
      used += w + gap;
    }
    // 区切り線で終わらないようにする
    while (cut > 0 && list[cut - 1].classList.contains('sep')) cut--;
    state.hidden = list.slice(cut).filter((c, i) => widths[cut + i] > 0 || c.classList.contains('sep'));
    for (const c of list.slice(cut)) c.classList.add('ovf-hidden');
  }

  state.layout = layout;
  bars.push(state);
  new ResizeObserver(() => requestAnimationFrame(layout)).observe(bar);
  window.addEventListener('lang-changed', () => requestAnimationFrame(layout));
  requestAnimationFrame(layout);
  return { layout, close };
}

/** 中身が変わったとき（書式バーの項目の出し入れなど）に並べ直す */
export function relayoutBars() {
  requestAnimationFrame(() => { for (const b of bars) b.layout(); });
}

// ---------------------------------------------------------------- パネルの幅

/**
 * パネルの境目をドラッグして幅を変える。side: 'left'（サイドバー）| 'right'（右側のパネル。今は使っていない）
 * ダブルクリックで元の幅に戻す
 */
export function panelResizer(panel, side, { min, max, def, key }) {
  const handle = el('div', { class: `resizer resizer-${side}`, title: t('ドラッグで幅を変更（ダブルクリックで元に戻す）') });
  if (side === 'left') panel.after(handle);
  else panel.before(handle);
  const apply = (w) => {
    const v = Math.round(Math.min(max, Math.max(min, w)));
    panel.style.width = `${v}px`;
    return v;
  };
  apply(layoutSetting(key, def));
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX, startW = panel.getBoundingClientRect().width;
    document.body.classList.add('resizing');
    const move = (ev) => apply(side === 'left' ? startW + (ev.clientX - startX) : startW - (ev.clientX - startX));
    const up = (ev) => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      document.body.classList.remove('resizing');
      saveLayout({ [key]: apply(side === 'left' ? startW + (ev.clientX - startX) : startW - (ev.clientX - startX)) });
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
  handle.addEventListener('dblclick', () => saveLayout({ [key]: apply(def) }));
  return handle;
}
