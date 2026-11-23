// 自動アップデート（GitHub Releases から新しい版を取得する）
// インストーラー版でだけ動く。インストール不要版（zip）は配布ページを案内する。
const { app, dialog, BrowserWindow, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { t: T } = require('./i18n');

const RELEASES_URL = 'https://github.com/zr750104/pdf-studio/releases/latest';
const CHECK_INTERVAL = 6 * 60 * 60 * 1000;

let updater = null;
let busy = false;        // 確認中・ダウンロード中
let downloaded = null;   // ダウンロード済みの版
let manualCheck = false;
let installOnQuit = false; // 「次回の終了時に更新」を選んだ
let hasUnsaved = () => false;
let installing = false;    // インストーラーを起動しているところ（失敗の知らせは installFailed で出す）

/** 保存していない文書があるかを調べる関数（main.js から渡す） */
function setUnsavedChecker(fn) { hasUnsaved = fn; }

// 更新の経過をファイルに残す（うまくいかないときの原因調べ用）
const logPath = () => path.join(app.getPath('userData'), 'logs', 'updater.log');
function log(level, ...args) {
  const line = `[${new Date().toISOString()}] ${level} ${args.map((a) => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`;
  try {
    fs.mkdirSync(path.dirname(logPath()), { recursive: true });
    fs.appendFileSync(logPath(), line);
    if (fs.statSync(logPath()).size > 512 * 1024) fs.writeFileSync(logPath(), fs.readFileSync(logPath(), 'utf8').slice(-256 * 1024));
  } catch { /* 記録できなくても更新は続ける */ }
}
const logger = { info: (...a) => log('INFO', ...a), warn: (...a) => log('WARN', ...a), error: (...a) => log('ERROR', ...a), debug: () => {} };

const settingsPath = () => path.join(app.getPath('userData'), 'update-settings.json');
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')); } catch { return {}; }
}
function saveSettings(s) {
  try { fs.writeFileSync(settingsPath(), JSON.stringify(s)); } catch { /* 保存できなくても動作は続ける */ }
}

/** インストーラーで入れた版か（アンインストーラーがあるか） */
function isInstalled() {
  return app.isPackaged && process.platform === 'win32'
    && fs.existsSync(path.join(path.dirname(process.execPath), `Uninstall ${app.getName()}.exe`));
}

const parentWindow = () => BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
const setProgress = (v) => { for (const w of BrowserWindow.getAllWindows()) w.setProgressBar(v); };

/** リリースノート（HTML の場合あり）を短い文章にする */
function notesText(info) {
  let n = info.releaseNotes;
  if (Array.isArray(n)) n = n.map((x) => x.note).join('\n');
  if (!n) return '';
  n = String(n).replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|li|h\d)>/gi, '\n').replace(/<li>/gi, '・').replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\n{3,}/g, '\n\n').trim();
  return n.length > 700 ? `${n.slice(0, 700)}…` : n;
}

function getUpdater() {
  if (updater) return updater;
  const { autoUpdater } = require('electron-updater');
  autoUpdater.logger = logger;
  autoUpdater.autoDownload = false;
  // 終了時の自動インストールは無音（失敗しても何も表示されない）ため使わず、installAtQuit で画面付きで行う
  autoUpdater.autoInstallOnAppQuit = false;
  log('INFO', `PDF Studio ${app.getVersion()} (${isInstalled() ? 'installed' : 'portable'})`); // 場所（ユーザー名を含む）は書かない

  autoUpdater.on('update-available', async (info) => {
    const settings = loadSettings();
    if (!manualCheck && settings.skipVersion === info.version) { busy = false; return; }
    const notes = notesText(info);
    if (updateMode() === 'notify') { await notifyOnly(info, notes, settings); return; }
    const { response } = await dialog.showMessageBox(parentWindow(), {
      type: 'info',
      buttons: [T('ダウンロード'), T('後で'), T('このバージョンはスキップ')],
      defaultId: 0,
      cancelId: 1,
      message: T(`新しいバージョン ${info.version} があります`),
      detail: `${T(`現在のバージョン: ${app.getVersion()}`)}${notes ? `\n\n${notes}` : ''}\n\n${T('ダウンロードは裏で行い、終わったらお知らせします。')}`
    });
    if (response === 0) {
      autoUpdater.downloadUpdate().catch((e) => onError(e));
    } else {
      if (response === 2) saveSettings({ ...settings, skipVersion: info.version });
      busy = false;
    }
  });

  autoUpdater.on('update-not-available', () => {
    busy = false;
    if (manualCheck) dialog.showMessageBox(parentWindow(), { type: 'info', message: T('お使いのバージョンは最新です'), detail: T(`バージョン ${app.getVersion()}`) });
  });

  autoUpdater.on('download-progress', (p) => setProgress(Math.max(0.01, p.percent / 100)));

  autoUpdater.on('update-downloaded', async (info) => {
    busy = false;
    downloaded = info.version;
    setProgress(-1);
    const { response } = await dialog.showMessageBox(parentWindow(), {
      type: 'info',
      buttons: [T('今すぐ更新'), T('次回の終了時に更新')],
      defaultId: 0,
      cancelId: 1,
      message: T(`バージョン ${info.version} の準備ができました`),
      detail: installHint()
    });
    installOnQuit = true;
    if (response === 0) installNow();
  });

  autoUpdater.on('error', onError);
  updater = autoUpdater;
  return updater;
}

/**
 * 今すぐ更新する。インストーラーは画面付きで動かす（無音だと、失敗しても利用者に何も伝わらない）。
 * 保存していない文書があるときは、先に保存してもらう（インストーラーはアプリを強制終了するため）
 */
async function installNow() {
  const u = getUpdater();
  if (hasUnsaved()) {
    await dialog.showMessageBox(parentWindow(), {
      type: 'warning', message: T('保存していない文書があります'),
      detail: T('文書を保存してから、もう一度「ヘルプ > アップデートを確認」を選んでください。保存せずにアプリを閉じた場合も、終了時に更新します。')
    });
    return;
  }
  installOnQuit = false;
  const mode = updateMode();
  log('INFO', `install now (mode=${mode})`);
  if (mode === 'shell') { launchViaShell(); return; }
  if (mode === 'manual') { await showInstallerManually(); return; }
  let failed = null;
  const onErr = (e) => { failed = e; };
  u.once('error', onErr);
  installing = true;
  recordAttempt('silent');
  // 自分のユーザーだけに入れた版は無音でインストールし、終わったら自動で起動する。
  // すべてのユーザー向け（Program Files）に入れた版は管理者の許可が要るため、画面付きで動かす
  u.quitAndInstall(!perMachine(), true);
  // インストーラーを起動できなかったときは、すぐ error になる
  setTimeout(() => {
    installing = false;
    u.removeListener('error', onErr);
    if (failed) installFailed(failed);
  }, 1500);
}

/** 更新のしかたの説明（方式によって違う） */
function installHint() {
  const m = updateMode();
  if (m === 'silent') return T('PDF Studio を終了して更新し、自動で起動し直します。');
  if (m === 'manual') return T('インストーラーのあるフォルダーを開きます。PDF Studio を閉じてから、インストーラーをダブルクリックしてください。');
  return T('PDF Studio を終了してインストーラーを開きます。最後に「完了」を押すと PDF Studio が起動します。保存していない文書は、先に保存してください。');
}

/** すべてのユーザー向け（Program Files）にインストールされているか */
const perMachine = () => /\\Program Files( \(x86\))?\\/i.test(process.execPath);

/** 終了するときに更新する（「次回の終了時に更新」を選んだとき） */
function installAtQuit() {
  if (!installOnQuit || !downloaded || !updater) return;
  installOnQuit = false;
  const mode = updateMode();
  log('INFO', `install at quit (mode=${mode})`);
  try {
    if (mode === 'shell') launchViaShell(false);
    else if (mode === 'silent') { recordAttempt('silent'); updater.install(!perMachine(), false); }
  } catch (e) { log('ERROR', e); }
}

// ---------------------------------------------------------------- 更新の方式（PC に合わせて切り替える）
//  shell  … Windows（エクスプローラー）経由でインストーラーを開く（既定）。ダブルクリックしたときと同じ動きになる。
//           画面が出るので最後に「完了」を押してもらう。アプリから直接起動した画面なしのインストーラーは、
//           セキュリティソフトに止められる PC があるため（2026-10-22 に実際に起きた）
//  silent … 画面なしでインストールし、自動で起動し直す（使うのは管理者の許可が要る場合のみ）
//  manual … インストーラーのあるフォルダーを開き、ダブルクリックしてもらう
//  notify … ダウンロードもしない。新しい版があることだけ知らせ、ブラウザでダウンロードしてもらう。
//           一部のセキュリティソフトは、PDF エディタ（このアプリ）がダウンロードしたファイルの実行も止めるため（2026-10-22）
// 更新を試した版を記録し、次に起動したときにその版になっていなければ失敗とみなして、次の方式に切り替える

const MODES = ['shell', 'manual', 'notify'];
function updateMode() {
  if (portable() || restrictedPc()) return 'notify';
  if (perMachine()) return 'silent';
  const m = loadSettings().updateMode;
  return MODES.includes(m) ? m : 'shell';
}

/** アプリからのプログラム起動・ダウンロードしたファイルの実行を止めるセキュリティソフトが入っているか */
function restrictedPc() {
  if (process.platform !== 'win32') return false;
  const dirs = [process.env.ProgramFiles, process.env.ProgramW6432, process.env['ProgramFiles(x86)'], process.env.ProgramData].filter(Boolean);
  // フォルダー名はそのまま書かず、小文字にした名前のハッシュ値（SHA-256）で照らし合わせる
  const sha = (s) => require('crypto').createHash('sha256').update(s).digest('hex');
  // 64 ビットの Windows では ProgramFiles と ProgramW6432 が同じ場所なので、重なりを除く
  return [...new Set(dirs.map((d) => d.toLowerCase()))].some((d) => {
    try { return fs.readdirSync(d).some((n) => RESTRICTED_DIRS.includes(sha(n.toLowerCase()))); } catch { return false; }
  });
}
const RESTRICTED_DIRS = ['de882d5b65291a1b92677b2bcaa6840313236a51a8eefb8e1f6497a8adb0705a'];

const setupUrl = (v) => `https://github.com/zr750104/pdf-studio/releases/download/v${v}/PDF-Studio-Setup-${v}.exe`;
const zipUrl = (v) => `https://github.com/zr750104/pdf-studio/releases/download/v${v}/PDF-Studio-${v}-win.zip`;

/** インストールせずに使っている版（インストール不要版のフォルダーから起動）か */
const portable = () => app.isPackaged && process.platform === 'win32' && !isInstalled();

/** 新しい版があることだけを知らせ、ダウンロード用の URL を渡す */
async function notifyOnly(info, notes, settings) {
  const url = portable() ? zipUrl(info.version) : setupUrl(info.version);
  log('INFO', `notify only: ${url}`);
  const how = portable()
    ? T('インストール不要版の新しいフォルダー（zip）を次の URL からダウンロードして展開し、PDF Studio を閉じてから、今のフォルダーと置き換えてください。設定・署名・スタンプはそのまま使えます。')
    : T('この PC のセキュリティ設定により、PDF Studio の中からは更新をダウンロード・実行できません。次の URL をブラウザで開いてインストーラーをダウンロードし、PDF Studio を閉じてから実行してください。');
  const { response } = await dialog.showMessageBox(parentWindow(), {
    type: 'info',
    buttons: [T('ダウンロード用の URL をコピー'), T('ブラウザで開く'), T('後で'), T('このバージョンはスキップ')],
    defaultId: 0, cancelId: 2, noLink: true,
    message: T(`新しいバージョン ${info.version} があります`),
    detail: `${T(`現在のバージョン: ${app.getVersion()}`)}${notes ? `\n\n${notes}` : ''}\n\n${how}\n${url}`
  });
  busy = false;
  if (response === 3) saveSettings({ ...settings, skipVersion: info.version });
  if (response === 0) {
    clipboard.writeText(url);
    await dialog.showMessageBox(parentWindow(), {
      type: 'info', message: T('URL をコピーしました'),
      detail: portable()
        ? T('ブラウザのアドレス欄に貼り付けて Enter を押すと、zip のダウンロードが始まります。展開したら PDF Studio を閉じて、今のフォルダーと置き換えてください。')
        : T('ブラウザのアドレス欄に貼り付けて Enter を押すと、インストーラーのダウンロードが始まります。ダウンロードしたら PDF Studio を閉じて、インストーラーを実行してください。')
    });
  }
  if (response === 1) shell.openExternal(url).catch(() => {});
}

function recordAttempt(mode) {
  saveSettings({ ...loadSettings(), lastAttempt: { version: downloaded, mode, time: new Date().toISOString() } });
}

/** a が b より新しい版か（1.5.10 > 1.5.9 のように数字で比べる） */
function newer(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

/** 前回の更新が完了したかを確かめ、完了していなければ次の方式に切り替えて知らせる */
async function checkLastAttempt() {
  const s = loadSettings();
  const last = s.lastAttempt;
  if (!last) return;
  const { lastAttempt, ...rest } = s;
  if (!newer(last.version, app.getVersion())) {
    log('INFO', `previous update to ${last.version} succeeded (mode=${last.mode})`);
    saveSettings(rest);
    return;
  }
  const next = last.mode === 'manual' ? 'notify' : 'manual';
  log('WARN', `previous update to ${last.version} did not complete (mode=${last.mode}) → ${next}`);
  saveSettings({ ...rest, updateMode: next });
  await dialog.showMessageBox(parentWindow(), {
    type: 'info',
    message: T('前回の更新が完了しませんでした'),
    detail: next === 'manual'
      ? T('次からは、インストーラーのあるフォルダーを開きます。PDF Studio を閉じてから、インストーラーをダブルクリックしてください。')
      : T('この PC のセキュリティ設定により、PDF Studio の中からは更新をダウンロード・実行できないようです。次からは新しい版があることをお知らせし、ダウンロード用の URL をお渡しします。')
  });
}

/** Windows（エクスプローラー）経由でインストーラーを開き、アプリを終了する */
function launchViaShell(quit = true) {
  const p = updater?.installerPath;
  if (!p) { installFailed(new Error('installer not found')); return; }
  recordAttempt('shell');
  log('INFO', `open installer via explorer: ${p}`);
  try {
    // explorer.exe に渡すと、ダブルクリックしたときと同じように Windows がインストーラーを起動する
    const c = require('child_process').spawn('explorer.exe', [p], { detached: true, stdio: 'ignore' });
    c.on('error', (e) => log('ERROR', 'explorer', e));
    c.unref();
  } catch (e) {
    log('ERROR', e);
    installFailed(e);
    return;
  }
  // インストーラーが「PDF Studio が起動中」と言わないよう、すぐに終了する
  if (quit) setTimeout(() => app.quit(), 300);
}

/** インストーラーのあるフォルダーを開き、手で実行してもらう */
async function showInstallerManually() {
  const p = updater?.installerPath;
  if (!p) { installFailed(new Error('installer not found')); return; }
  recordAttempt('manual');
  shell.showItemInFolder(p);
  await dialog.showMessageBox(parentWindow(), {
    type: 'info',
    message: T('インストーラーのあるフォルダーを開きました'),
    detail: `${T('PDF Studio を閉じてから、選択されている次のファイルをダブルクリックしてください。')}\n${path.basename(p)}`
  });
}

async function installFailed(e) {
  log('ERROR', 'install failed', e);
  const { response } = await dialog.showMessageBox(parentWindow(), {
    type: 'warning', buttons: [T('配布ページを開く'), T('閉じる')], defaultId: 0,
    message: T('更新を開始できませんでした'),
    detail: `${T('配布ページからインストーラーをダウンロードして実行すると更新できます。')}\n\n${e?.message || e}`
  });
  if (response === 0) shell.openExternal(RELEASES_URL);
}

function onError(e) {
  busy = false;
  setProgress(-1);
  log('ERROR', e);
  try { require('./errorlog').record('renderer-handled', { message: `update: ${e?.message || e}`, stack: `update: ${e?.stack || e}` }); } catch { /* 無視 */ }
  if (installing) return;
  if (manualCheck) {
    dialog.showMessageBox(parentWindow(), {
      type: 'warning',
      message: T('アップデートを確認できませんでした'),
      detail: T(`インターネットに接続されているか確認してください。\n\n${e?.message || e}`)
    });
  }
}

/** 新しい版を確認する。manual = メニューから手動で確認したとき */
async function checkForUpdates(manual = false) {
  manualCheck = manual;
  // インストール不要版も新しい版の確認はする（お知らせだけ）。開発中の起動などは対象外
  if (!isInstalled() && !portable()) {
    if (manual) {
      const { response } = await dialog.showMessageBox(parentWindow(), {
        type: 'info',
        buttons: [T('配布ページを開く'), T('閉じる')],
        defaultId: 0,
        message: T('この版は自動で更新できません'),
        detail: T(`自動更新はインストーラー版（PDF-Studio-Setup-x.x.x.exe）で使えます。\n最新版は配布ページから入手できます。\n\n現在のバージョン: ${app.getVersion()}`)
      });
      if (response === 0) shell.openExternal(RELEASES_URL);
    }
    return;
  }
  if (downloaded) {
    if (manual) {
      const { response } = await dialog.showMessageBox(parentWindow(), {
        type: 'info', buttons: [T('今すぐ更新'), T('閉じる')], defaultId: 0,
        message: T(`バージョン ${downloaded} の準備ができています`), detail: installHint()
      });
      if (response === 0) installNow();
    }
    return;
  }
  if (busy) {
    if (manual) dialog.showMessageBox(parentWindow(), { type: 'info', message: T('アップデートを確認・ダウンロードしています'), detail: T('終わったらお知らせします。') });
    return;
  }
  busy = true;
  try {
    await getUpdater().checkForUpdates();
  } catch (e) {
    onError(e);
  }
}

/** 起動後と、その後一定間隔で自動確認する */
function startAutoCheck() {
  if (portable()) {
    setTimeout(() => checkForUpdates(false), 8000);
    setInterval(() => checkForUpdates(false), CHECK_INTERVAL);
    return;
  }
  if (!isInstalled()) return;
  setTimeout(() => checkLastAttempt().catch((e) => log('ERROR', e)), 2500);
  setTimeout(() => checkForUpdates(false), 8000);
  setInterval(() => checkForUpdates(false), CHECK_INTERVAL);
}

// ---------------------------------------------------------------- 二重インストールの確認

/**
 * PDF Studio が入りうる場所（このユーザーのみ・すべてのユーザー）を直接調べ、入っている場所と版を返す。
 * 外部のプログラム（PowerShell など）は起動しない。署名のないアプリが PowerShell を起動すると、
 * セキュリティソフトにアプリごと強制終了されることがあるため（1.5.3〜1.5.5 で起動直後に落ちた原因と考えられる）
 */
function findInstalls(env = process.env) {
  if (process.platform !== 'win32') return [];
  const local = env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Programs') : null;
  const bases = [local, env.ProgramFiles, env.ProgramW6432, env['ProgramFiles(x86)']].filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const base of bases) {
    for (const name of ['PDF Studio', 'pdf-studio']) {
      const dir = path.join(base, name);
      const key = dir.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (!fs.existsSync(path.join(dir, 'PDF Studio.exe'))) continue;
      let version = '?';
      // Electron の fs は app.asar の中のファイルも読める
      try { version = JSON.parse(fs.readFileSync(path.join(dir, 'resources', 'app.asar', 'package.json'), 'utf8')).version || '?'; } catch { /* 版が分からなくても場所は知らせる */ }
      out.push({ dir, version, allUsers: !(local && key.startsWith(local.toLowerCase())) });
    }
  }
  return out;
}

/** 別の場所にも PDF Studio が入っていたら知らせる（起動のたびに 1 回。「今後表示しない」で止める） */
async function checkDuplicateInstalls() {
  if (!isInstalled()) return;
  const here = path.dirname(process.execPath).toLowerCase();
  const all = findInstalls();
  const others = all.filter((x) => x.dir.toLowerCase() !== here);
  // 場所（ユーザー名を含む）は書かず、版と「すべてのユーザー」かどうかだけ
  log('INFO', `installs: ${JSON.stringify(all.map((x) => ({ version: x.version, allUsers: x.allUsers, here: x.dir.toLowerCase() === here })))}`);
  if (!others.length) return;
  const settings = loadSettings();
  const sig = others.map((x) => x.dir.toLowerCase()).sort().join('|');
  if (settings.ignoreDuplicate === sig) return;
  const where = (x) => `${x.dir}（${T(x.allUsers ? 'すべてのユーザー' : 'このユーザーのみ')}・${x.version}）`;
  const { response } = await dialog.showMessageBox(parentWindow(), {
    type: 'warning',
    buttons: [T('アプリの一覧を開く'), T('後で'), T('今後表示しない')],
    defaultId: 0, cancelId: 1, noLink: true,
    message: T('PDF Studio が複数の場所にインストールされています'),
    detail: `${T('いま起動している版')}: ${path.dirname(process.execPath)}（${app.getVersion()}）\n${T('ほかの場所')}: ${others.map(where).join('\n')}\n\n${T('ショートカットによって古い版が起動することがあります。Windows の「設定 > アプリ > インストールされているアプリ」で、古い版の PDF Studio をアンインストールしてください。新しい版を消してしまった場合は、インストーラーを実行し直せば元に戻ります。')}`
  });
  if (response === 0) shell.openExternal('ms-settings:appsfeatures');
  if (response === 2) saveSettings({ ...settings, ignoreDuplicate: sig });
}

/** 起動したことを記録する（起動直後に落ちるときの手がかり） */
// ログにはファイルの場所・ユーザー名を書かない（アプリの置き場所も、開いたファイルも）。
// 起動オプション（-- で始まるもの）と、ファイルの数だけを書く
const logStartup = () => {
  const args = process.argv.slice(1);
  const flags = args.filter((a) => a.startsWith('--')).map((a) => a.split('=')[0]);
  const files = args.filter((a) => !a.startsWith('-')).length;
  log('INFO', `start ${app.getVersion()} (${isInstalled() ? 'installed' : 'portable'}) flags=${JSON.stringify(flags)} files=${files}`);
};

module.exports = { log, isInstalled, logStartup, checkForUpdates, startAutoCheck, installAtQuit, setUnsavedChecker, checkDuplicateInstalls, findInstalls, RELEASES_URL, logPath };
