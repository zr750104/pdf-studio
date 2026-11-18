// エラーログの記録と、不具合報告（GitHub Issues への下書き）
// ログは PC 内（ユーザーデータの logs/errors.log）に保存し、送るときは必ず内容を確認してもらう。
// 報告に入れる前に、ユーザー名・ファイル名などの個人情報は伏せる。
const { app, dialog, shell, clipboard, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { t: T, getLang } = require('./i18n');

const ISSUES_URL = 'https://github.com/zr750104/pdf-studio/issues/new';
const MAX_LOG = 256 * 1024;      // ログファイルの上限（超えたら古い半分を捨てる）
const MAX_URL_BODY = 5500;       // ブラウザに渡す本文の上限（URL の長さ制限のため）

let logFile = null;
let settingsFile = null;
let promptedThisSession = false;
let selftest = false;

function init(userData, { isSelftest = false } = {}) {
  selftest = isSelftest;
  const dir = path.join(userData, 'logs');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 無視 */ }
  logFile = path.join(dir, 'errors.log');
  settingsFile = path.join(userData, 'settings.json');
  process.on('uncaughtException', (e) => record('main', e));
  process.on('unhandledRejection', (e) => record('main', e));
  app.on('render-process-gone', (e, wc, d) => record('renderer-gone', { message: `${d.reason} (exit ${d.exitCode})` }));
  app.on('child-process-gone', (e, d) => { if (d.reason !== 'clean-exit' && d.reason !== 'killed') record('child-gone', { message: `${d.type}: ${d.reason} (exit ${d.exitCode})` }); });
}

const readSettings = () => { try { return JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch { return {}; } };
function writeSettings(patch) {
  try { fs.writeFileSync(settingsFile, JSON.stringify({ ...readSettings(), ...patch })); } catch { /* 無視 */ }
}
/** エラーが起きたときに報告をすすめるか */
const promptEnabled = () => readSettings().errorPrompt !== false;
const setPromptEnabled = (v) => writeSettings({ errorPrompt: !!v });

/** 個人情報を伏せる（ユーザー名を含むパス・PDF などのファイル名・メールアドレス） */
function sanitize(s) {
  let out = String(s ?? '');
  // ドライブ名やフォルダから始まるパスは、空白を含むファイル名ごと伏せる
  const EXT = '(pdf|tiff?|png|jpe?g|docx?|xlsx?|txt|csv|html?)';
  out = out.replace(new RegExp(`(?:\\b[A-Za-z]:\\\\|(?<![\\w:/])[~]?/)[^\\n"'<>|*?:]*?\\.${EXT}\\b`, 'gi'), '<path>.$1');
  out = out.replace(new RegExp(`[^\\\\/\\s"'()<>]+\\.${EXT}\\b`, 'gi'), '<file>.$1');
  const home = os.homedir();
  if (home) out = out.split(home).join('~');
  const user = os.userInfo?.().username;
  if (user && user.length > 2) out = out.replace(new RegExp(user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '<user>');
  out = out.replace(/[A-Za-z]:\\Users\\[^\\\s]+/gi, 'C:\\Users\\<user>');
  out = out.replace(/\/Users\/[^/\s]+/g, '/Users/<user>');
  out = out.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>');
  return out;
}

/** エラーを 1 件記録する。source: main / renderer など */
function record(source, err) {
  const msg = err?.stack || err?.message || String(err);
  const line = `[${new Date().toISOString()}] (${source}) ${sanitize(msg)}\n`;
  try {
    if (logFile) {
      fs.appendFileSync(logFile, line);
      if (fs.statSync(logFile).size > MAX_LOG) {
        const text = fs.readFileSync(logFile, 'utf8');
        fs.writeFileSync(logFile, text.slice(text.length / 2));
      }
    }
  } catch { /* ログが書けなくても動作は続ける */ }
  if (source !== 'renderer-handled') maybePrompt();
}

function readLog() {
  try { return fs.readFileSync(logFile, 'utf8'); } catch { return ''; }
}

/** 最近のエラー（新しいものから最大 n 件） */
function recentEntries(n = 10) {
  const entries = readLog().split(/\n(?=\[\d{4}-)/).filter((x) => x.trim());
  return entries.slice(-n);
}

function environment() {
  return [
    `- PDF Studio: ${app.getVersion()}`,
    `- OS: ${process.platform === 'win32' ? 'Windows' : process.platform} ${os.release()} (${process.arch})`,
    `- Electron: ${process.versions.electron}`,
    `- 言語 / Language: ${getLang()}`
  ].join('\n');
}

function buildBody(userNote) {
  const head = `## 状況 / What happened\n${userNote || '（どの操作で起きたか書いてください / Please describe what you were doing）'}\n\n## 環境 / Environment\n${environment()}\n\n## エラーログ / Error log\n`;
  let entries = recentEntries(10);
  const fence = (list) => `\`\`\`\n${list.join('\n').trim() || '(no errors recorded)'}\n\`\`\`\n`;
  // URL に収まるよう、古いものから減らす
  while (entries.length > 1 && (head + fence(entries)).length > MAX_URL_BODY) entries = entries.slice(1);
  let log = fence(entries);
  if ((head + log).length > MAX_URL_BODY) log = fence([entries[0].slice(-(MAX_URL_BODY - head.length - 20))]);
  // 自動アップデートの記録（最後の数行）も、入る分だけ付ける
  let upd = '';
  try {
    const lines = fs.readFileSync(path.join(path.dirname(logFile), 'updater.log'), 'utf8').trim().split('\n').map(sanitize);
    for (let n = Math.min(15, lines.length); n > 0; n--) {
      upd = `\n## アップデートの記録 / Update log\n\`\`\`\n${lines.slice(-n).join('\n')}\n\`\`\`\n`;
      if ((head + log + upd).length <= MAX_URL_BODY) break;
      upd = '';
    }
  } catch { /* 記録がなければ付けない */ }
  return head + log + upd;
}

const parent = () => BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];

/** 不具合を報告：内容を見せてから、GitHub の報告ページを下書き入りで開く */
async function report() {
  const body = buildBody('');
  const preview = body.length > 1800 ? `${body.slice(0, 1800)}\n…` : body;
  const { response } = await dialog.showMessageBox(parent(), {
    type: 'info',
    buttons: [T('ブラウザで報告ページを開く'), T('内容をコピー'), T('ログのフォルダを開く'), T('キャンセル')],
    defaultId: 0,
    cancelId: 3,
    noLink: true,
    message: T('不具合を開発者に報告します'),
    detail: `${T('次の内容を GitHub の報告ページ（公開）に下書きとして入れます。送信前にブラウザで内容を確認・編集でき、送信には GitHub のアカウントが必要です。ユーザー名やファイル名は伏せてあり、PDF の中身は送りません。')}\n\n${preview}`
  });
  if (response === 0) {
    const title = recentEntries(1)[0]?.replace(/^\[[^\]]+\]\s*\([^)]+\)\s*/, '').split('\n')[0].slice(0, 80) || T('不具合の報告');
    const url = `${ISSUES_URL}?${new URLSearchParams({ title: `[${app.getVersion()}] ${title}`, body, labels: 'bug' })}`;
    if (!selftest) shell.openExternal(url);
    return url;
  }
  if (response === 1) clipboard.writeText(body);
  if (response === 2 && !selftest) shell.openPath(path.dirname(logFile));
  return null;
}

/** エラーが起きたら（1 回の起動につき 1 度だけ）報告をすすめる */
let promptTimer = null;
function maybePrompt() {
  if (promptedThisSession || selftest || !promptEnabled() || !app.isReady()) return;
  promptedThisSession = true;
  clearTimeout(promptTimer);
  // 連続して起きたエラーをまとめるため少し待つ
  promptTimer = setTimeout(async () => {
    const { response, checkboxChecked } = await dialog.showMessageBox(parent(), {
      type: 'warning',
      buttons: [T('報告する...'), T('今回は報告しない')],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      message: T('問題が発生しました'),
      detail: T('エラーの内容は PC 内のログに記録しました。開発者に報告すると改善に役立ちます。報告する内容は送信前に確認できます。'),
      checkboxLabel: T('今後はこの確認を表示しない（ヘルプ メニューからいつでも報告できます）')
    });
    if (checkboxChecked) setPromptEnabled(false);
    if (response === 0) report();
  }, 1500);
}

module.exports = { init, record, report, readLog, sanitize, buildBody, promptEnabled, setPromptEnabled, logPath: () => logFile };
