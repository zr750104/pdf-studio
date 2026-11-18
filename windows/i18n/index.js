// 表示言語（メインプロセス用）。訳は言語ごとの <言語>.json（画面側の renderer/i18n.js と共通）
// 原文は日本語。英語（en.json）・タイ語（th.json）は日本語の文字列をキーにした訳
const fs = require('fs');
const path = require('path');

const JP = /[぀-ヿ㐀-鿿！-～]/;
/** 対応する言語（先頭が原文） */
const LANGS = ['ja', 'en', 'th'];

/** 言語ごとの訳 { strings: Map, patterns: [[RegExp, 置き換え]] } */
const dicts = {};
for (const l of LANGS.slice(1)) {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, `${l}.json`), 'utf8'));
  dicts[l] = { strings: new Map(Object.entries(data.strings)), patterns: data.patterns.map(([re, rep]) => [new RegExp(re, 's'), rep]) };
}

let lang = 'en'; // 初回（言語を選んでいないとき）は英語
let settingsFile = null;
let savedLang = null; // 設定に保存されていた言語（メニューで選んだもの）
const valid = (l) => LANGS.includes(l);

function init(userData) {
  settingsFile = path.join(userData, 'settings.json');
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8')).lang; } catch { /* 設定なし */ }
  savedLang = valid(saved) ? saved : null;
  if (valid(saved)) lang = saved;
  // 言語をまだ選んでいないときは英語（以前から使っている PC も。ユーザーの指示 2026-11-17）。
  // 保存はしない（メニューで選んだときだけ保存する）
  else lang = 'en';
  if (valid(process.env.PDFSTUDIO_LANG)) lang = process.env.PDFSTUDIO_LANG;
}

function setLang(l) {
  lang = valid(l) ? l : 'en';
  if (!settingsFile) return;
  let s = {};
  try { s = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch { /* 新規 */ }
  try { fs.writeFileSync(settingsFile, JSON.stringify({ ...s, lang })); } catch { /* 保存できなくても切り替えは続ける */ }
}

/** 日本語の文字列を、言語 l の訳にする（見つからなければそのまま） */
function tr(s, l) {
  const d = dicts[l];
  if (!d || typeof s !== 'string' || !JP.test(s)) return s;
  const hit = d.strings.get(s);
  if (hit != null) return hit;
  for (const [re, rep] of d.patterns) {
    const m = re.exec(s);
    if (m) return rep.replace(/\$(\d)/g, (_, k) => tr(m[k] ?? '', l));
  }
  if (s.includes('\n')) return s.split('\n').map((x) => tr(x, l)).join('\n');
  return s;
}

/** 日本語の文字列を、今の表示言語にする */
const t = (s) => (lang === 'ja' ? s : tr(s, lang));

module.exports = { init, t, tr, setLang, getLang: () => lang, savedLang: () => savedLang, LANGS };
