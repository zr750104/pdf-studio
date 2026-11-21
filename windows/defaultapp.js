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
  // 開くコマンドにはアプリの場所（ユーザー名を含む）が入るので書かず、識別名と PDF Studio かどうかだけ
  log('INFO', `tiff default: ${JSON.stringify(Object.fromEntries(results.map(([ext, r]) => [ext, r && { progId: r.progId, ours: r.ours }])))}`);
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

// ---------------------------------------------------------------- インストール不要版の「プログラムから開く」
// インストール不要版を「プログラムから開く」で選ぶと、Windows は exe の場所を
// HKCU\Software\Classes\Applications\PDF Studio.exe\shell\open\command に覚える。
// 新しい版を別のフォルダーに展開して古いフォルダーを消すと、ダブルクリックしても開かなくなるため、
// 起動したときに、いま動いている exe の場所へ書き直す。

/** 開くコマンドから exe の場所を取り出す（"C:\...\PDF Studio.exe" "%1" の形） */
function exeFromCommand(command) {
  if (typeof command !== 'string') return null;
  const m = command.match(/^\s*"([^"]+)"/) || command.match(/^\s*(.+?\.exe)(?=\s|$)/i);
  return m ? m[1] : null;
}

/** 版を比べる（a が新しければ正、同じなら 0） */
function compareVersion(a, b) {
  const [ma, pra] = String(a || '0').split('-');
  const [mb, prb] = String(b || '0').split('-');
  const pa = ma.split('.').map((x) => parseInt(x, 10) || 0);
  const pb = mb.split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  // 数字が同じなら、試験版（1.5.22-beta など）のほうが古い
  if (!!pra !== !!prb) return pra ? -1 : 1;
  return 0;
}

// Windows の場所として比べる（大文字小文字・区切り・. や .. の違いを吸収。どの OS で試しても同じ結果）
const sameExe = (a, b) => typeof a === 'string' && typeof b === 'string' && !!a && !!b
  && path.win32.normalize(a).toLowerCase() === path.win32.normalize(b).toLowerCase();

/**
 * 登録を書き直すかを決める（レジストリに触れない、テストできる部分）。
 * registeredExe: いま登録されている exe（なければ null）、exists: その exe があるか、
 * registeredIsInstalled: それがインストール版か、registeredVersion: このアプリが前に書いたときの版
 * （そのとき書いた exe が今の登録と同じときだけ渡す。利用者が選び直すと、Windows は場所だけ書き換えるため）
 * 戻り値: 'same' | 'update' | 'none' | 'keep-installed' | 'keep-newer'
 */
function decidePortableOpenWith({ registeredExe, exe, exists, registeredIsInstalled, registeredVersion, version }) {
  // 「プログラムから開く」で選ばれたことがなければ何もしない（使っていない人の登録を作らない。インストール版とも重ならない）
  if (!registeredExe) return 'none';
  if (sameExe(registeredExe, exe)) return 'same';
  if (!exists) return 'update';
  if (registeredIsInstalled) return 'keep-installed';
  if (registeredVersion && compareVersion(registeredVersion, version) > 0) return 'keep-newer';
  return 'update';
}

/** インストール不要版の起動時に呼ぶ。ログにはファイルの場所を書かない */
function repairPortableOpenWith({ log, findInstalls }) {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  // 前回、書き直している途中でアプリが止まった（セキュリティソフトに止められたなど）ときは、もう試さない。
  // 印は設定ファイルとは別の小さなファイル（作って消すだけ。設定ファイルの読み書きの失敗でほかの設定を消さないように）
  const pending = path.join(app.getPath('userData'), 'portable-openwith.pending');
  if (fs.existsSync(pending)) { log('INFO', 'portable open-with: skipped (interrupted before)'); return; }
  const r = loadReg(log);
  if (!r) return;
  const exe = process.execPath;
  const keyPath = `Software\\Classes\\Applications\\${path.basename(exe)}`;
  try {
    const command = r.getValue(r.HKEY.CURRENT_USER, `${keyPath}\\shell\\open\\command`, null);
    const registeredExe = exeFromCommand(command);
    const exists = !!registeredExe && fs.existsSync(registeredExe);
    // インストール版か：決まったインストール先と同じ、または隣にアンインストーラーがある
    const registeredIsInstalled = exists && (findInstalls().some((x) => sameExe(path.join(x.dir, 'PDF Studio.exe'), registeredExe))
      || fs.existsSync(path.join(path.dirname(registeredExe), `Uninstall ${app.getName()}.exe`)));
    // 前に書いた版は、そのとき書いた exe が今の登録と同じときだけ信用する
    const writtenVersion = r.getValue(r.HKEY.CURRENT_USER, keyPath, 'PDFStudioVersion');
    const writtenExe = r.getValue(r.HKEY.CURRENT_USER, keyPath, 'PDFStudioExe');
    const decision = decidePortableOpenWith({
      registeredExe, exe, exists, registeredIsInstalled, version: app.getVersion(),
      registeredVersion: typeof writtenVersion === 'string' && typeof writtenExe === 'string' && sameExe(writtenExe, registeredExe) ? writtenVersion : null
    });
    log('INFO', `portable open-with: ${decision}${registeredExe && !exists ? ' (old exe missing)' : ''}`);
    if (decision !== 'update' && decision !== 'same') return;
    // すでに今の exe を指し、記録も今の版なら書かない（起動のたびに書かないように）
    if (decision === 'same' && writtenVersion === app.getVersion() && sameExe(writtenExe, exe)) return;
    // 書いている途中でアプリごと止められたら、次回からは試さないよう、先に印を付けて書き終えたら消す
    fs.writeFileSync(pending, '');
    try {
      const k = r.createKey(r.HKEY.CURRENT_USER, keyPath, r.Access.ALL_ACCESS);
      try {
        r.setValueSZ(k, 'FriendlyAppName', 'PDF Studio');
        r.setValueSZ(k, 'PDFStudioVersion', app.getVersion());
        r.setValueSZ(k, 'PDFStudioExe', exe);
      } finally { r.closeKey(k); }
      if (decision === 'update') {
        const c = r.createKey(r.HKEY.CURRENT_USER, `${keyPath}\\shell\\open\\command`, r.Access.ALL_ACCESS);
        try { r.setValueSZ(c, null, `"${exe}" "%1"`); } finally { r.closeKey(c); }
        const t = r.createKey(r.HKEY.CURRENT_USER, `${keyPath}\\SupportedTypes`, r.Access.ALL_ACCESS);
        try { for (const ext of ['.pdf', ...EXTS]) r.setValueSZ(t, ext, ''); } finally { r.closeKey(t); }
      }
    } finally {
      // 例外で終わったときも消す（止められたのではないので、次回また試す）
      try { fs.rmSync(pending, { force: true }); } catch (e) { log('WARN', `portable open-with: could not clear marker: ${e.code || e.message}`); }
    }
  } catch (e) {
    log('WARN', `portable open-with: ${e.message}`);
  }
}

module.exports = { checkTiffDefault, inspect, repairPortableOpenWith, decidePortableOpenWith, exeFromCommand, compareVersion };
