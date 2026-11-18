// TIFF（.tif / .tiff）を開く既定のアプリが PDF Studio かを調べ、違えば設定の手順を案内する。
// Windows 10 以降は、アプリが自分で既定のアプリになることはできない（利用者が選ぶ決まり）ので、案内だけを行う。
// レジストリは native-reg でアプリの中から直接読む。reg.exe や PowerShell などの外部プログラムは起動しない
// （一部のセキュリティソフトに、PDF エディタからのプログラム起動として止められるため）。
const { app, dialog, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { t: T } = require('./i18n');

const EXTS = ['.tif', '.tiff'];
const EXE = 'pdf studio.exe';
const REMIND_DAYS = 7;

let reg = null;
let regTried = false;
/** native-reg を読み込む（使う直前に。失敗しても落ちない） */
function loadReg(log) {
  if (regTried) return reg;
  regTried = true;
  // 読み込みでアプリごと止められた場合に原因が分かるよう、先に記録しておく
  log('INFO', 'loading native-reg');
  try {
    reg = require('native-reg');
  } catch (e) {
    log('WARN', `native-reg を読み込めません: ${e.message}`);
    reg = null;
  }
  return reg;
}

/**
 * 拡張子の既定のアプリを調べる。
 * 戻り値: { progId, command, ours }。読めないときは null（そのときは案内しない）
 */
function inspect(ext, log) {
  const r = loadReg(log);
  if (!r) return null;
  try {
    // 利用者が「常にこのアプリを使う」で選んだもの（あればこれが優先される）。
    // 新しい Windows 11 では UserChoiceLatest に記録されることがあるので、そちらを先に見る
    const base = `Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\${ext}`;
    let progId = r.getValue(r.HKEY.CURRENT_USER, `${base}\\UserChoiceLatest\\ProgId`, 'ProgId')
      || r.getValue(r.HKEY.CURRENT_USER, `${base}\\UserChoiceLatest`, 'ProgId')
      || r.getValue(r.HKEY.CURRENT_USER, `${base}\\UserChoice`, 'ProgId');
    // 無ければ、拡張子の通常の登録（HKEY_CLASSES_ROOT は自分のユーザーと PC 全体の登録をまとめて見せる）
    if (!progId) progId = r.getValue(r.HKEY.CLASSES_ROOT, ext, null);
    if (!progId || typeof progId !== 'string') return { progId: null, command: null, ours: false };
    // 識別名を文字列で比べず、開くときのコマンドに PDF Studio.exe が含まれるかで判定する
    // （「プログラムから開く」で選ぶと Applications\PDF Studio.exe など別の識別名になるため）
    const command = r.getValue(r.HKEY.CLASSES_ROOT, `${progId}\\shell\\open\\command`, null);
    const ours = typeof command === 'string' && command.toLowerCase().includes(EXE);
    return { progId, command: typeof command === 'string' ? command : null, ours };
  } catch (e) {
    log('WARN', `既定のアプリを読めません (${ext}): ${e.message}`);
    return null;
  }
}

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
const readSettings = () => { try { return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')); } catch { return {}; } };
function writeSettings(patch) {
  try { fs.writeFileSync(settingsPath(), JSON.stringify({ ...readSettings(), ...patch })); } catch { /* 保存できなくても動作は続ける */ }
}

/**
 * 起動時に呼ぶ。installed: インストール版か（インストール不要版は Windows に登録されないので、調べてログに残すだけ）
 */
async function checkTiffDefault({ installed, log }) {
  if (process.platform !== 'win32') return;
  const results = EXTS.map((ext) => [ext, inspect(ext, log)]);
  log('INFO', `tiff default: ${JSON.stringify(Object.fromEntries(results))}`);
  if (!installed) return;
  // 読めなかった拡張子がある・すでに既定になっている場合は何もしない
  if (results.some(([, r]) => r == null) || results.every(([, r]) => r.ours)) return;
  const s = readSettings();
  if (s.tiffDefaultPrompt === false) return;
  if (s.tiffDefaultAskedAt && Date.now() - Date.parse(s.tiffDefaultAskedAt) < REMIND_DAYS * 86400000) return;
  writeSettings({ tiffDefaultAskedAt: new Date().toISOString() });
  const parent = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  const { response } = await dialog.showMessageBox(parent, {
    type: 'info',
    buttons: [T('OK'), T('今後表示しない')],
    defaultId: 0, cancelId: 0, noLink: true,
    message: T('TIFF ファイルを開く既定のアプリが PDF Studio になっていません'),
    detail: T('PDF Studio で TIFF を開くようにするには、次の手順で設定してください。\n\n1. エクスプローラーで TIFF ファイル（.tif）を右クリック\n2.「プログラムから開く」→「別のプログラムを選択」\n3.「PDF Studio」を選び、「常に使う」を押す\n\n.tiff のファイルがある場合は、同じ手順で設定してください。この案内は 1 週間ごとに表示します。')
  });
  if (response === 1) writeSettings({ tiffDefaultPrompt: false });
}

module.exports = { checkTiffDefault, inspect };
