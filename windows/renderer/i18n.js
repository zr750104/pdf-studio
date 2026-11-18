// 表示言語（日本語 / 英語 / タイ語）
// 訳は ../i18n/<言語>.json（メインプロセスと共通）。原文は日本語で、訳は日本語の文字列をキーにする。
// 画面の文字は表示されたときに自動で訳し、ダイアログなどは t() で訳す。
// ユーザーの文字（注釈の内容・検索結果など）は translate="no" の中に置く
const JP = /[\u3040-\u30ff\u3400-\u9fff\uff01-\uff5e]/;
/** 対応する言語（先頭が原文） */
export const LANGS = ['ja', 'en', 'th'];

const dicts = {};
for (const l of LANGS.slice(1)) {
  const data = await (await fetch(new URL(`../i18n/${l}.json`, import.meta.url))).json();
  dicts[l] = { strings: new Map(Object.entries(data.strings)), patterns: data.patterns.map(([re, rep]) => [new RegExp(re, 's'), rep]) };
}

const valid = (l) => LANGS.includes(l);
let lang = valid(window.api?.getLang?.()) ? window.api.getLang() : 'en';
/** 訳が見つからなかった文字列（自動テストで確認する） */
export const missing = new Set();

export const getLang = () => lang;

/** 日本語の文字列を、今の表示言語にする */
export const t = (s) => (lang === 'ja' ? s : tr(s, lang));

/** 言語 l の訳（見つからなければそのまま） */
function tr(s, l, record = true) {
  const d = dicts[l];
  if (!d || typeof s !== 'string' || !JP.test(s)) return s;
  const hit = d.strings.get(s);
  if (hit != null) return hit;
  const trimmed = s.trim();
  if (trimmed !== s) {
    const h = d.strings.get(trimmed);
    if (h != null) return s.replace(trimmed, h);
  }
  for (const [re, rep] of d.patterns) {
    const m = re.exec(s);
    if (m) return rep.replace(/\$(\d)/g, (_, k) => tr(m[k] ?? '', l, record));
  }
  if (s.includes('\n')) return s.split('\n').map((x) => tr(x, l, record)).join('\n');
  if (record && l === lang) missing.add(s);
  return s;
}

/** cur が orig そのものか、orig のどれかの言語の訳か（自分で訳して書き込んだ文字か） */
const isOurs = (cur, orig) => cur === orig || LANGS.slice(1).some((l) => tr(orig, l, false) === cur);

// ---------------------------------------------------------------- 画面の文字の自動翻訳

const ATTRS = ['title', 'placeholder', 'aria-label'];
const origText = new WeakMap();   // テキストノード -> 元の日本語
const origAttr = new WeakMap();   // 要素 -> { 属性名: 元の日本語 }
let applying = false;

/** 翻訳しない場所（PDF の中身・ユーザーの文字） */
const skip = (node) => {
  // すでに画面から外れた部品（描き直しで差し替えられたもの）は、ページの中かどうか判定できないので翻訳しない
  if (!node.isConnected) return true;
  const e = node.nodeType === 1 ? node : node.parentElement;
  return !e || !!e.closest('#pages, [translate="no"], textarea, script, style');
};

function translateText(node) {
  const cur = node.data;
  let orig = origText.get(node);
  // 画面側で書き換えられた（訳した結果と違う）ときは、新しい文字を元の文字とみなす
  if (orig == null || !isOurs(cur, orig)) {
    if (!JP.test(cur)) return;
    orig = cur;
    origText.set(node, orig);
  }
  const next = t(orig);
  if (next !== cur) node.data = next;
}

function translateAttrs(el) {
  for (const a of ATTRS) {
    if (!el.hasAttribute(a)) continue;
    const cur = el.getAttribute(a);
    const map = origAttr.get(el) || {};
    let orig = map[a];
    if (orig == null || !isOurs(cur, orig)) {
      if (!JP.test(cur)) continue;
      orig = cur;
      map[a] = orig;
      origAttr.set(el, map);
    }
    const next = t(orig);
    if (next !== cur) el.setAttribute(a, next);
  }
}

function translateTree(root) {
  if (skip(root)) return;
  if (root.nodeType === 3) { translateText(root); return; }
  if (root.nodeType !== 1) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.nodeType === 1 && (n.id === 'pages' || n.getAttribute('translate') === 'no' || n.tagName === 'TEXTAREA') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)
  });
  translateAttrs(root);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === 3) translateText(n);
    else translateAttrs(n);
  }
}

function run(fn) {
  if (applying) return;
  applying = true;
  try { fn(); } finally { applying = false; }
}

export function startAutoTranslate() {
  const obs = new MutationObserver((records) => run(() => {
    for (const r of records) {
      if (r.type === 'childList') r.addedNodes.forEach(translateTree);
      else if (r.type === 'characterData') { if (!skip(r.target)) translateText(r.target); }
      else if (r.type === 'attributes' && !skip(r.target)) translateAttrs(r.target);
    }
    // 自分で書き換えた分の通知は捨てる
    obs.takeRecords();
  }));
  obs.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  run(() => translateTree(document.body));
  document.documentElement.lang = lang;
}

/** 言語を切り替える（開いている画面もその場で切り替える） */
export function setLang(l) {
  lang = valid(l) ? l : 'en';
  document.documentElement.lang = lang;
  run(() => translateTree(document.body));
  window.dispatchEvent(new CustomEvent('lang-changed', { detail: lang }));
}
