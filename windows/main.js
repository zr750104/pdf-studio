// PDF Studio for Windows — メインプロセス
const { app, BrowserWindow, WebContentsView, Menu, dialog, ipcMain, protocol, net, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const updater = require('./updater');
const i18n = require('./i18n');
const errorlog = require('./errorlog');
const defaultapp = require('./defaultapp');
const T = i18n.t;

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
]);

const ROOT = __dirname;
const PERFTEST = process.argv.includes('--perftest');
const SELFTEST = process.argv.includes('--selftest') || PERFTEST;
const selftestQueue = { open: [], save: [], folder: [], message: [], askSave: [] };
const fromQueue = (k) => (SELFTEST && selftestQueue[k].length ? { hit: true, v: selftestQueue[k].shift() } : { hit: false });
// 自動テストは、ウィンドウを見えなくして裏で動かす（画面を占有せず、フォーカスも奪わない）。
// 描画は止めない（見えないウィンドウの描画が間引かれると、表示を待つテストが進まなくなる）。
// 様子を見たいときは PDFSTUDIO_TEST_VISIBLE=1 で起動する
const TEST_HIDDEN = SELFTEST && process.env.PDFSTUDIO_TEST_VISIBLE !== '1';
if (TEST_HIDDEN) {
  for (const sw of ['disable-renderer-backgrounding', 'disable-backgrounding-occluded-windows', 'disable-background-timer-throttling']) app.commandLine.appendSwitch(sw);
  // ウィンドウを前に出さない（そのウィンドウで表示中のタブの画面へフォーカスだけ移す）
  BrowserWindow.prototype.focus = function focusInBackground() {
    const wc = hosts.get(this.id)?.active?.wc;
    if (wc && !wc.isDestroyed()) wc.focus(); else this.webContents?.focus();
  };
  if (process.platform === 'darwin') app.dock?.hide();
  // Mac の Electron は webContents.focus() でアプリごと前面に出す（キー入力とメニューバーを奪う）ので、
  // テストでは何もしない。ページには focus emulation でフォーカスがあるように見せている
  if (process.platform === 'darwin') app.on('web-contents-created', (_e, wc) => { wc.focus = () => {}; });
  // 見えないアプリは Mac の省電力（App Nap）でタイマーが間引かれ、テストが止まることがあるので止めない
  app.whenReady().then(() => require('electron').powerSaveBlocker.start('prevent-app-suspension'));
}
// 自動テストが途中で止まったら、どこで止まったかを出して終わる（黙って待ち続けないように）
const testWatch = { last: Date.now(), line: '（まだ何も確かめていない）', unexpected: 0 };
if (SELFTEST && !PERFTEST) {
  const LIMIT = 180_000;
  setInterval(() => {
    if (Date.now() - testWatch.last < LIMIT) return;
    process.stdout.write(`❌ 自動テストが止まりました: 「${testWatch.line}」のあと ${LIMIT / 1000} 秒進みません\n`);
    app.exit(2);
  }, 10_000).unref?.();
}
/** 自動テストのウィンドウを見えなくし、マウスも素通りさせる（描画は続く） */
function hideForTest(win) {
  if (!TEST_HIDDEN) return;
  // 不透明度 0 だと Mac が描画を止めることがあるので、目には見えないほど薄くする
  win.setOpacity(0.01);
  win.setIgnoreMouseEvents(true);
  win.setSkipTaskbar(true);
}
// ---------------------------------------------------------------- ウィンドウとタブ
// 1 つのウィンドウに複数の文書をタブで開く。タブごとに文書の画面（renderer/index.html）を
// WebContentsView で持ち、ウィンドウ自身の画面はタブバー（renderer/tabs.html）にする。
// 文書の画面は 1 文書用のまま（タブごとに別のプロセスなので、重い文書がほかのタブを止めない）

const windows = new Map(); // 文書の webContents.id -> タブ { win, host, view, wc, dirty, forceClose, initial, title, empty }
const hosts = new Map();   // BrowserWindow.id -> { win, tabs, active, mode, panes, mru, closing, forceClose }
let lastHost = null;       // 最後に操作したウィンドウ（エクスプローラーから開いたファイルの行き先）
const STRIP_H = 36;        // タブバーの高さ
const PANE_INSET = 2;      // 並べて表示のときの枠の太さ（renderer/tabs.js の B と同じ）
const MODES = { single: 1, h: 2, v: 2, grid: 4 };
let testTabUsed = false;

const docPrefs = () => ({
  preload: path.join(ROOT, 'preload.js'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  spellcheck: false
});

/** 新しいウィンドウ。initial を渡すとそのファイルのタブ、empty なら空のまま（タブを移すとき） */
function createWindow(initial = null, { empty = false } = {}) {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'PDF Studio',
    icon: path.join(ROOT, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    backgroundColor: '#2b2b2b',
    show: false,
    webPreferences: { ...docPrefs(), preload: path.join(ROOT, 'tabs-preload.js') }
  });
  const host = { win, tabs: [], active: null, mode: 'single', panes: [], mru: [], closing: false, forceClose: false, ready: false, pending: [] };
  hosts.set(win.id, host);
  lastHost = host;
  emulateFocusForTest(win.webContents);
  win.loadURL('app://local/renderer/tabs.html');
  // ウィンドウが表示できるようになってからタブを作る。
  // それより前に作ったタブは、数十秒のあいだ画面が描かれないことがあった（Mac で確認）
  win.once('show', () => {
    host.ready = true;
    for (const fn of host.pending.splice(0)) fn();
  });
  // タブはウィンドウの show の知らせのあとで作る（それより前に作ると描画が止まる）。
  // 知らせがなかなか来ない環境でも、待たずに作ると止まるので、代わりの処理は入れない
  hideForTest(win);
  // 裏で動かすテストでは、見えないウィンドウに ready-to-show が来ないことがあるので、すぐに（前に出さずに）表示する
  if (TEST_HIDDEN) {
    win.showInactive();
    // Mac では前に出さずに表示すると show の知らせが来ないことがあるので、表示できていれば代わりに知らせる
    setTimeout(() => { if (!host.ready && !win.isDestroyed() && win.isVisible()) win.emit('show'); }, 300);
  }
  else win.once('ready-to-show', () => win.show());
  // 表示されたら画面の位置を合わせ直す（表示前に作ったタブが描かれないままにならないように）

  win.on('focus', () => { if (lastHost !== host) { lastHost = host; buildMenu(); } });
  for (const ev of ['resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'restore']) win.on(ev, () => layout(host));
  win.on('close', (e) => {
    onWindowClose(host, e);
    // 閉じると決まったウィンドウは、前回の続きの記録から外す（最後のウィンドウなら記録はそのまま）。
    // 確認を出すために止めたときは、まだ終了をやめたとは限らないので、記録はそのまま（やめたと決まったら resumeSession）
    if (!e.defaultPrevented) { host.windowClosing = true; scheduleSession(); }
  });
  win.on('closed', () => {
    // 移す途中のタブ（まだ並んでいない）も含めて閉じる
    for (const tab of [...windows.values()]) if (tab.host === host) destroyTab(tab, { keepWindow: true });
    hosts.delete(host.win.id);
    if (lastHost === host) lastHost = [...hosts.values()].at(-1) || null;
    buildMenu();
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('before-input-event', (e, input) => tabKeys(host, e, input));
  if (!empty) whenReady(host, () => addTab(host, initial));
  return win;
}

/** ウィンドウの準備ができてから fn を実行する */
function whenReady(host, fn) {
  if (host.ready) fn();
  else host.pending.push(fn);
}

/** タブを追加する */
function addTab(host, initial = null, { activate = true } = {}) {
  const view = new WebContentsView({ webPreferences: docPrefs() });
  view.setBackgroundColor('#2b2b2b');
  const wc = view.webContents;
  const tab = {
    win: host.win, host, view, wc, dirty: false, forceClose: false, initial, title: 'PDF Studio', empty: !initial,
    // 開くファイルの場所は最初から持つ（読み込み中に終了・異常終了しても前回の続きから消えないように。開けなかったら外す）
    path: docPathOk(initial?.path) ? initial.path : null,
    // 前回の続きで開くタブは、表示するまで前のページ・倍率のまま記録する
    viewState: initial?.view ? { page: initial.view.page | 0, scale: +initial.view.scale || 0, fit: initial.view.fit || null } : null,
    // 異常終了時の写しから開いたタブ：開けて新しい写しができる（または保存・閉じる）までは元の写しを残す
    recoveredFrom: initial?.recoveredFrom || null, recoveredOpened: false
  };
  windows.set(wc.id, tab);
  host.tabs.push(tab);
  host.mru.push(tab);
  host.win.contentView.addChildView(view);
  setupDocContents(tab);
  // 自動テストは最初のタブだけで動かす（テスト中に開いたタブでは動かさない）
  const extra = process.argv.filter((a) => a.startsWith('--pf-')).map((a) => `&${a.slice(5)}=1`).join('');
  // PDFSTUDIO_ONLY=tabs など：自動テストの一部だけを動かす（調べるとき用）
  const only = process.env.PDFSTUDIO_ONLY ? `&only=${encodeURIComponent(process.env.PDFSTUDIO_ONLY)}` : '';
  const test = SELFTEST && !testTabUsed ? (PERFTEST ? `?perftest=1${extra}` : `?selftest=1${only}`) : '';
  if (test) testTabUsed = true;
  wc.loadURL(`app://local/renderer/index.html${test}`);
  if (activate || !host.active) activateTab(host, tab);
  else { fillPanes(host); layout(host); }
  return tab;
}

/** 裏で動かす自動テストでは、ウィンドウにフォーカスが無くても、画面はフォーカスがあるものとして動かす
 *  （無いと、文字の選択やドラッグなどがフォーカスのある時と違う動きになる） */
function emulateFocusForTest(wc) {
  if (!TEST_HIDDEN) return;
  wc.setBackgroundThrottling(false);
  const on = () => {
    try {
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
      wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    } catch { /* 使えなくてもテストは続ける */ }
  };
  on();
  wc.on('did-finish-load', on);
}

function setupDocContents(tab) {
  const wc = tab.wc;
  emulateFocusForTest(wc);
  // 画面（レンダラー）が落ちたタブは、異常終了時の写しを消さない（保存しないで閉じても、次の起動で復元できるように）
  wc.on('render-process-gone', (e, d) => {
    if (d?.reason === 'clean-exit') return;
    tab.crashed = true;
    updater.log('WARN', `renderer gone: ${d?.reason}`);
  });
  if (SELFTEST) {
    wc.on('console-message', (e) => {
      const d = process.env.PDFSTUDIO_TEST_OUT || path.join(os.tmpdir(), 'pdfstudio-test');
      fs.appendFileSync(path.join(d, 'console.txt'), `[${e.level}] ${e.message}\n`);
    });
  }
  // アプリの画面以外へは移動しない（ファイルのドロップなどで画面が置き換わるのを防ぐ）
  wc.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://local/')) e.preventDefault();
  });
  // 外部リンクはブラウザで開く
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:|^mailto:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // 並べて表示で画面をクリックしたら、その画面を操作中にする
  wc.on('focus', () => {
    const host = tab.host;
    if (host.active === tab || !host.tabs.includes(tab)) return;
    // 見えていないタブ（裏で読み込みが終わったときなど）がフォーカスを取っても、操作中にはしない
    if (!paneRects(host).some((r) => r.tab === tab)) {
      if (host.active && !host.active.wc.isDestroyed()) host.active.wc.focus();
      return;
    }
    host.active = tab;
    touch(host, tab);
    sendStrip(host);
    updateTitle(host);
  });
  wc.on('before-input-event', (e, input) => tabKeys(tab.host, e, input));
  // 読み込み直後に画面が描かれないままになることがあった（Mac で確認）ため、描き直しを促す
  wc.on('did-finish-load', () => { if (!wc.isDestroyed()) wc.invalidate(); });
  wc.on('destroyed', () => { if (windows.get(tab.id) === tab) destroyTab(tab); });
  tab.id = wc.id;
}

/** Ctrl+Tab / Ctrl+Shift+Tab でタブを切り替える */
function tabKeys(host, e, input) {
  if (input.type !== 'keyDown' || !input.control || input.alt || input.meta || input.key !== 'Tab') return;
  e.preventDefault();
  cycleTab(host, input.shift ? -1 : 1);
}

function cycleTab(host, d) {
  if (!host || host.tabs.length < 2) return;
  const i = host.tabs.indexOf(host.active);
  activateTab(host, host.tabs[(i + d + host.tabs.length) % host.tabs.length]);
}

const touch = (host, tab) => { host.mru = [tab, ...host.mru.filter((t) => t !== tab)]; };

/** タブを前に出す。並べて表示で見えていなければ、操作中の画面と入れ替える */
function activateTab(host, tab) {
  if (!host.tabs.includes(tab)) return;
  if (host.mode !== 'single' && !host.panes.includes(tab)) {
    const i = host.panes.indexOf(host.active);
    if (host.panes.length < MODES[host.mode]) host.panes.push(tab); // 空きがあれば増やす
    else if (i >= 0) host.panes[i] = tab;
    else host.panes[0] = tab;
    if (host.mode === 'grid') host.panes.sort((a, b) => host.tabs.indexOf(a) - host.tabs.indexOf(b));
  }
  host.active = tab;
  touch(host, tab);
  layout(host);
  if (!tab.wc.isDestroyed()) tab.wc.focus();
  updateTitle(host);
  scheduleSession(); // 表示中のタブも前回の続きに入れる
}

/** 並べて表示の切り替え。single | h（左右）| v（上下）| grid（すべて、最大 4 画面） */
function setMode(host, mode) {
  if (!host || !MODES[mode]) return;
  host.mode = mode;
  fillPanes(host, true);
  layout(host);
  buildMenu(); // メニューの選択状態を合わせる
  if (host.active && !host.active.wc.isDestroyed()) host.active.wc.focus();
}

/** 並べて表示する画面を決める（足りなければ最近使ったタブで埋める） */
function fillPanes(host, reset = false) {
  const n = MODES[host.mode];
  if (n === 1) { host.panes = []; return; }
  if (reset) host.panes = host.active ? [host.active] : [];
  host.panes = host.panes.filter((t) => host.tabs.includes(t));
  for (const t of host.mru) if (host.panes.length < n && !host.panes.includes(t)) host.panes.push(t);
  // 「すべて並べる」はタブの順に並べる
  if (host.mode === 'grid') host.panes.sort((a, b) => host.tabs.indexOf(a) - host.tabs.indexOf(b));
}

/** 見えている画面とその位置 */
function paneRects(host) {
  if (host.win.isDestroyed()) return [];
  const [w, h] = host.win.getContentSize();
  const area = { x: 0, y: STRIP_H, width: w, height: Math.max(0, h - STRIP_H) };
  const panes = host.mode !== 'single' && host.panes.length > 1 ? host.panes : host.active ? [host.active] : [];
  if (panes.length <= 1) return panes.map((tab) => ({ tab, rect: area }));
  const n = panes.length;
  const cells = [];
  if (host.mode === 'v') for (let i = 0; i < n; i++) cells.push([0, i, 1, n]);
  else if (host.mode === 'grid' && n === 4) for (let i = 0; i < 4; i++) cells.push([i % 2, Math.floor(i / 2), 2, 2]);
  else for (let i = 0; i < n; i++) cells.push([i, 0, n, 1]);
  const I = PANE_INSET;
  return panes.map((tab, i) => {
    const [cx, cy, cols, rows] = cells[i];
    const x0 = Math.round(area.x + (area.width * cx) / cols);
    const x1 = Math.round(area.x + (area.width * (cx + 1)) / cols);
    const y0 = Math.round(area.y + (area.height * cy) / rows);
    const y1 = Math.round(area.y + (area.height * (cy + 1)) / rows);
    return { tab, rect: { x: x0 + I, y: y0 + I, width: Math.max(0, x1 - x0 - 2 * I), height: Math.max(0, y1 - y0 - 2 * I) } };
  });
}

/** 画面の位置を合わせる（ウィンドウの大きさが変わったとき・タブを切り替えたとき） */
function layout(host) {
  if (!host || host.win.isDestroyed()) return;
  const rects = paneRects(host);
  for (const tab of host.tabs) {
    const hit = rects.find((r) => r.tab === tab);
    if (hit) tab.view.setBounds(hit.rect);
    const was = tab.shownNow;
    tab.view.setVisible(!!hit);
    tab.shownNow = !!hit;
    // 隠れていた画面を出したら描き直しを促す
    if (hit && !was && !tab.wc.isDestroyed()) tab.wc.invalidate();
  }
  sendStrip(host, rects);
}

const tabLabel = (tab) => {
  const s = String(tab.title || '').replace(/^● /, '').replace(/ - PDF Studio$/, '');
  return !s || s === 'PDF Studio' ? T('新しいタブ') : s;
};

function sendStrip(host, rects = paneRects(host)) {
  if (!host || host.win.isDestroyed()) return;
  host.win.webContents.send('tabs:state', {
    tabs: host.tabs.map((t) => ({ id: t.id, title: tabLabel(t), dirty: t.dirty && !t.convertedOnly })),
    active: host.active?.id ?? null,
    mode: host.mode,
    frames: rects.length > 1 ? rects.map((r) => ({ id: r.tab.id, ...r.rect })) : [],
    labels: { newTab: T('新しいタブ'), close: T('閉じる'), layout: T('並べて表示') }
  });
}

function updateTitle(host) {
  if (!host || host.win.isDestroyed()) return;
  host.win.setTitle(host.active?.title || 'PDF Studio');
}

// 閉じるときの保存の確認（ask: 毎回確かめる / save: 確かめずに保存 / discard: 確かめずに保存しない）。
// 自動テストでは本物の設定ファイルを書き換えないよう、メモリーだけに持つ
const SAVE_PROMPTS = ['ask', 'save', 'discard'];
let testSavePrompt = 'ask';
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const readSettingsFile = () => { try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return {}; } };
function savePrompt() {
  const v = SELFTEST ? testSavePrompt : readSettingsFile().savePrompt;
  return SAVE_PROMPTS.includes(v) ? v : 'ask';
}
function setSavePrompt(v) {
  if (!SAVE_PROMPTS.includes(v)) return;
  if (SELFTEST) testSavePrompt = v;
  else setSetting('savePrompt', v); // ほかの設定を消さないよう、読めないときは書かない
  buildMenu();
}

/** 保存していない変更があれば確かめる。0 保存 / 1 保存しない / 2 キャンセル。
 *  「今後は確認しない」に印を付けて保存・保存しないを選ぶと、次からはその操作を確かめずに行う（キャンセルは覚えない）。
 *  チェックボックスの状態は同期版のダイアログでは受け取れないため、非同期で表示する */
async function askSave(win, tab = null, { force = false } = {}) {
  const pref = force ? 'ask' : savePrompt();
  // 確かめずに保存したタブは、保存できなかったとき（名前を付けて保存のキャンセル・書き込みの失敗）にいつもの確認を出す
  if (tab) tab.autoSaved = pref === 'save';
  if (pref === 'save') return 0;
  if (pref === 'discard') return 1;
  const q = fromQueue('askSave');
  let response, checkboxChecked = false;
  if (q.hit) {
    // 自動テスト：数字だけなら選んだボタン、{ r, remember } なら「今後は確認しない」にも印を付けた
    if (typeof q.v === 'object') ({ r: response, remember: checkboxChecked } = q.v);
    else response = q.v;
  } else if (SELFTEST) {
    // 自動テストで予定していない確認：本物の画面は出さずに（見えないウィンドウで止まらないように）キャンセルとして記録する
    const line = `❌ 自動テストで予定していない「変更内容を保存しますか？」の確認 (${tab ? tabLabel(tab) : '-'})`;
    process.stdout.write(line + '\n');
    try { fs.appendFileSync(path.join(process.env.PDFSTUDIO_TEST_OUT || path.join(os.tmpdir(), 'pdfstudio-test'), 'log.txt'), line + '\n'); } catch { /* 書けなくても続ける */ }
    testWatch.unexpected++; // テストの終わりに失敗として数える
    response = 2;
  } else {
    ({ response, checkboxChecked } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: [T('保存'), T('保存しない'), T('キャンセル')],
      defaultId: 0,
      cancelId: 2,
      message: T('変更内容を保存しますか？'),
      detail: T('保存しないと変更内容は失われます。'),
      checkboxLabel: T('今後は確認せず、次から同じ操作をする（「編集」メニューの「閉じるときの保存の確認」で戻せます）')
    }));
  }
  if (checkboxChecked && (response === 0 || response === 1)) setSavePrompt(response === 0 ? 'save' : 'discard');
  return response;
}

// 閉じるときに保存を確かめるタブ。TIFF などを変換して開いただけ（元のファイルが残っている）なら確かめない
const needsAsk = (t) => t.dirty && !t.forceClose && !t.convertedOnly;

/** タブを閉じる（保存していなければ確かめる）。閉じなかったら false */
async function requestCloseTab(tab) {
  if (windows.get(tab.id) !== tab) return true; // もう閉じている
  const host = tab.host;
  // 確認を表示している間は、ほかの閉じる操作を受け付けない（確認が重なって出ないように）
  if (host.asking) return false;
  host.closing = false;
  if (needsAsk(tab)) {
    activateTab(host, tab);
    host.asking = true;
    let r;
    try { r = await askSave(host.win, tab); } finally { host.asking = false; }
    // 確かめている間に、タブが閉じられた・別のウィンドウへ移った・ウィンドウが閉じた
    if (windows.get(tab.id) !== tab) return true;
    if (tab.host !== host || host.win.isDestroyed()) return false;
    if (r === 2) return false;
    if (r === 0) { tab.wc.send('menu', 'save-and-close'); return 'pending'; }
  }
  keepWindowOpen(host, tab);
  destroyTab(tab);
  return true;
}

/** 最後のタブを閉じても、ウィンドウ（アプリ）は終わらせず空のタブを残す。
 *  ウィンドウの × で閉じているときと、もともと空のタブを閉じたときは、これまでどおりウィンドウを閉じる */
function keepWindowOpen(host, tab) {
  // ready 前（まだ表示されていない）のウィンドウにタブは足せないので、これまでどおり閉じる
  if (host.closing || tab.empty || host.win.isDestroyed() || !host.ready) return;
  if (host.tabs.length === 1 && host.tabs[0] === tab) addTab(host);
}

/** タブをウィンドウから外す（閉じるとき・別のウィンドウへ移すとき） */
function unlinkTab(tab) {
  const host = tab.host;
  host.tabs = host.tabs.filter((t) => t !== tab);
  host.mru = host.mru.filter((t) => t !== tab);
  host.panes = host.panes.filter((t) => t !== tab);
  if (!host.win.isDestroyed()) { try { host.win.contentView.removeChildView(tab.view); } catch { /* 外れている */ } }
  if (host.active === tab) host.active = host.mru[0] || host.tabs[0] || null;
  return host;
}

/** 残ったタブで表示を整える。タブがなくなったらウィンドウを閉じる */
function afterUnlink(host, keepWindow) {
  if (host.win.isDestroyed()) return;
  if (!host.tabs.length) {
    if (!keepWindow) { host.forceClose = true; host.win.close(); }
    return;
  }
  fillPanes(host);
  layout(host);
  if (host.active && !host.active.wc.isDestroyed()) host.active.wc.focus();
  updateTitle(host);
}

function destroyTab(tab, { keepWindow = false } = {}) {
  if (windows.get(tab.id) !== tab) return;
  windows.delete(tab.id);
  clearRecovery(tab); // 閉じた（保存した・保存しないを選んだ）ので写しは要らない
  scheduleSession();
  const host = unlinkTab(tab);
  if (!tab.wc.isDestroyed()) tab.wc.close();
  afterUnlink(host, keepWindow);
}

/** タブを新しいウィンドウに移す（文書は開いたまま） */
function moveTabToNewWindow(tab) {
  const old = tab.host;
  if (windows.get(tab.id) !== tab || old.tabs.length < 2) return;
  unlinkTab(tab);
  const win = createWindow(null, { empty: true });
  const host = hosts.get(win.id);
  tab.host = host;
  tab.win = win;
  afterUnlink(old, false);
  whenReady(host, () => {
    if (win.isDestroyed()) return;
    if (windows.get(tab.id) !== tab) { win.close(); return; }
    host.tabs.push(tab);
    host.mru.push(tab);
    win.contentView.addChildView(tab.view);
    activateTab(host, tab);
    // 付け替えた画面は描き直しを促す（そのままだと描かれないままになることがあった）
    tab.wc.invalidate();
    scheduleSession();
  });
}

/** ウィンドウを閉じるとき、保存していないタブを 1 つずつ確かめる */
function onWindowClose(host, e) {
  if (host.forceClose) return;
  const dirty = host.tabs.filter(needsAsk);
  if (!dirty.length) return;
  e.preventDefault();
  if (host.asking) return null;
  return closeDirtyTabs(host, dirty);
}

async function closeDirtyTabs(host, dirty) {
  host.asking = true;
  try {
    await askEachDirty(host, dirty);
  } finally {
    host.asking = false;
  }
}

async function askEachDirty(host, dirty) {
  // 「保存しない」はウィンドウを閉じると決まるまで印を付けない（途中でキャンセルしたら確認が残るように）
  const discard = [];
  for (const tab of dirty) {
    // 確かめている間に閉じた・別のウィンドウへ移ったタブは飛ばす
    if (windows.get(tab.id) !== tab || tab.host !== host) continue;
    activateTab(host, tab);
    const r = await askSave(host.win, tab);
    if (host.win.isDestroyed()) return;
    // キャンセル：ウィンドウを閉じない（終了の途中ならアプリの終了もやめる）ので、前回の続きの記録を再開する
    if (r === 2) { host.closing = false; resumeSession(); return; }
    // 確かめている間に、保存が終わって閉じた・別のウィンドウへ移ったタブは飛ばす
    if (windows.get(tab.id) !== tab || tab.host !== host) continue;
    if (r === 1) { discard.push(tab); continue; }
    // 先に「保存しない」を選んだタブは閉じる（保存のあとウィンドウを閉じ直すときに、もう一度聞かない）
    for (const t of discard) if (windows.get(t.id) === t) destroyTab(t, { keepWindow: true });
    // 保存してから閉じる。保存できたらタブが閉じ、続けてウィンドウを閉じ直す
    tab.wc.send('menu', 'save-and-close');
    host.closing = true;
    return;
  }
  for (const t of discard) t.forceClose = true;
  host.forceClose = true;
  host.win.close();
}

function entryFor(event) {
  return windows.get(event.sender.id);
}

/** ファイルを開く。ウィンドウがあればそのタブに（何も開いていないタブは置き換える） */
function openInHost(host, initial, { replaceBlank = true } = {}) {
  if (!host || host.win.isDestroyed()) { createWindow(initial); return; }
  if (!host.ready) { whenReady(host, () => openInHost(host, initial, { replaceBlank })); return; }
  const blank = replaceBlank && host.active?.empty && !host.active.dirty ? host.active : null;
  addTab(host, initial);
  if (blank) destroyTab(blank);
  if (host.win.isMinimized()) host.win.restore();
  host.win.focus();
}

/** 指定したファイルを開く（エクスプローラーから・起動時の引数から） */
function openPath(filePath) {
  openInHost(lastHost, { path: filePath });
}

/** 操作中のウィンドウの、操作中のタブ */
function focusedHost() {
  const w = BrowserWindow.getFocusedWindow();
  return (w && hosts.get(w.id)) || null;
}
const activeTab = () => focusedHost()?.active || null;

// ---------------------------------------------------------------- メニュー

function send(action, host = focusedHost()) {
  const tab = host?.active;
  if (tab && !tab.wc.isDestroyed()) tab.wc.send('menu', action);
}

/** 並べて表示のメニュー項目 */
function layoutItems(getHost) {
  const cur = getHost()?.mode;
  return [
    ['single', '1 画面'],
    ['h', '左右に 2 画面'],
    ['v', '上下に 2 画面'],
    ['grid', 'すべて並べる（最大 4 画面）']
  ].map(([mode, label]) => ({ label, type: 'radio', checked: cur ? cur === mode : mode === 'single', click: () => setMode(getHost(), mode) }));
}

function buildMenu() {
  const m = (label, action, accelerator) => ({ label, accelerator, click: () => send(action) });
  const sep = { type: 'separator' };
  const template = [
    {
      label: 'ファイル(&F)',
      submenu: [
        m('開く...', 'open', 'CmdOrCtrl+O'),
        {
          label: '最近使ったファイル',
          submenu: (() => {
            const list = recentFiles();
            // ファイル名は訳さない（noTr）。& はメニューの記号なので重ねる
            const items = list.map((p, i) => ({ label: `${i < 9 ? `&${i + 1} ` : ''}${path.basename(p).replace(/&/g, '&&')}`, noTr: true, toolTip: p, click: () => openRecent(p) }));
            return [
              ...(items.length ? items : [{ label: '（なし）', enabled: false }]),
              sep,
              { label: '一覧を消去', enabled: list.length > 0, click: () => clearRecent() },
              { label: '起動時に前回のファイルを開く', type: 'checkbox', checked: restoreEnabled(), click: (it) => { setSetting('restoreSession', it.checked); buildMenu(); } }
            ];
          })()
        },
        { label: '新しいタブ', accelerator: 'CmdOrCtrl+T', click: () => { const h = focusedHost(); if (h) addTab(h); else createWindow(); } },
        { label: '新しいウィンドウ', accelerator: 'CmdOrCtrl+Shift+W', click: () => createWindow() },
        m('新規（空白ページ）', 'new-blank', 'CmdOrCtrl+N'),
        m('ファイルから PDF を作成...', 'create-from-files', 'CmdOrCtrl+Shift+N'),
        m('複数のファイルを結合...', 'merge-files', 'CmdOrCtrl+Shift+M'),
        m('一括処理...', 'batch', 'CmdOrCtrl+Shift+B'),
        sep,
        m('上書き保存', 'save', 'CmdOrCtrl+S'),
        m('名前を付けて保存...', 'save-as', 'CmdOrCtrl+Shift+S'),
        m('ファイルサイズを縮小して保存...', 'save-optimized'),
        sep,
        {
          label: '書き出し',
          submenu: [
            m('Word 文書 (.docx)...', 'export-docx'),
            m('テキスト (.txt)...', 'export-text'),
            m('画像 (PNG / JPEG)...', 'export-images')
          ]
        },
        sep,
        m('印刷...', 'print', 'CmdOrCtrl+P'),
        sep,
        { label: 'タブを閉じる', accelerator: 'CmdOrCtrl+W', click: () => { const t = activeTab(); if (t) requestCloseTab(t); } },
        { label: '終了', role: 'quit' }
      ]
    },
    {
      label: '編集(&E)',
      submenu: [
        m('元に戻す', 'undo', 'CmdOrCtrl+Z'),
        m('やり直し', 'redo', 'CmdOrCtrl+Y'),
        sep,
        { label: '切り取り', role: 'cut' },
        { label: 'コピー', role: 'copy' },
        { label: '貼り付け', role: 'paste' },
        sep,
        m('検索...', 'find', 'CmdOrCtrl+F'),
        sep,
        {
          label: '閉じるときの保存の確認',
          submenu: [['ask', '毎回確かめる'], ['save', '確かめずに保存する'], ['discard', '確かめずに保存しない（変更は失われます）']]
            .map(([v, label]) => ({ label, type: 'radio', checked: savePrompt() === v, click: () => setSavePrompt(v) }))
        }
      ]
    },
    {
      label: '表示(&V)',
      submenu: [
        m('拡大', 'zoom-in', 'CmdOrCtrl+='),
        m('縮小', 'zoom-out', 'CmdOrCtrl+-'),
        m('実際のサイズ', 'zoom-100', 'CmdOrCtrl+0'),
        m('ページ全体を表示', 'zoom-page', 'CmdOrCtrl+9'),
        m('幅に合わせる', 'zoom-width', 'CmdOrCtrl+8'),
        sep,
        m('単一ページ（連続）', 'layout-single'),
        m('見開き（連続）', 'layout-two'),
        sep,
        m('前のページ', 'prev-page'),
        m('次のページ', 'next-page'),
        m('ページへ移動...', 'goto-page', 'CmdOrCtrl+G'),
        sep,
        m('サイドバー', 'toggle-sidebar', 'F4'),
        sep,
        {
          label: '並べて表示',
          submenu: layoutItems(() => focusedHost())
        },
        // Ctrl+Tab はメニューでは受けず、画面のキー入力で切り替える（どの画面にいても効くように）
        { label: '次のタブ', accelerator: 'Ctrl+Tab', registerAccelerator: false, click: () => cycleTab(focusedHost(), 1) },
        { label: '前のタブ', accelerator: 'Ctrl+Shift+Tab', registerAccelerator: false, click: () => cycleTab(focusedHost(), -1) },
        { label: '全画面表示', role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : [sep, { label: '開発者ツール', role: 'toggleDevTools' }])
      ]
    },
    {
      label: 'ページ(&P)',
      submenu: [
        m('右に 90° 回転', 'rotate-right', 'CmdOrCtrl+Shift+Plus'),
        m('左に 90° 回転', 'rotate-left', 'CmdOrCtrl+Shift+-'),
        sep,
        m('空白ページを挿入', 'insert-blank'),
        m('ファイルからページを挿入...', 'insert-file', 'CmdOrCtrl+Shift+I'),
        m('ページを複製', 'duplicate-pages'),
        m('ページを抽出...', 'extract-pages'),
        m('文書を分割...', 'split'),
        m('ページの大きさをそろえる...', 'normalize-size'),
        sep,
        m('ページを削除', 'delete-pages', 'CmdOrCtrl+Shift+D')
      ]
    },
    {
      label: '文書(&D)',
      submenu: [
        m('テキスト認識 (OCR)...', 'ocr'),
        sep,
        m('透かしを追加...', 'watermark'),
        m('ヘッダーとフッター / ページ番号...', 'header-footer'),
        m('ベイツ番号を付与...', 'bates'),
        sep,
        m('墨消しを適用...', 'apply-redactions'),
        m('注釈とフォームをフラット化...', 'flatten'),
        sep,
        m('パスワードで保護...', 'protect'),
        m('パスワード保護を解除', 'unprotect'),
        sep,
        m('測定の縮尺...', 'measure-scale'),
        m('縮尺を合わせる（キャリブレーション）...', 'calibrate'),
        sep,
        m('文書を比較...', 'compare'),
        m('重ねて比較（図面）...', 'compare-overlay'),
        m('文書のプロパティ...', 'properties', 'CmdOrCtrl+D')
      ]
    },
    {
      label: 'ヘルプ(&H)',
      submenu: [
        m('使い方', 'help', 'F1'),
        { label: '不具合を報告（エラーログを送信）...', click: () => errorlog.report() },
        { label: 'エラー発生時に報告をすすめる', type: 'checkbox', checked: errorlog.promptEnabled(), click: (it) => errorlog.setPromptEnabled(it.checked) },
        sep,
        { label: 'アップデートを確認...', click: () => updater.checkForUpdates(true) },
        { label: '配布ページを開く', click: () => shell.openExternal(updater.RELEASES_URL) },
        sep,
        { label: 'PDF Studio について', click: () => dialog.showMessageBox({ message: 'PDF Studio for Windows', detail: `${T(`バージョン ${app.getVersion()}`)}\n${T('PDF の閲覧・注釈・編集・ページ整理・OCR・保護に対応したエディタです。')}\n\n${T('インストール場所')}: ${path.dirname(process.execPath)}` }) }
      ]
    }
  ];
  // 表示言語の切り替え（表示メニューの最後）
  template[2].submenu.push(sep, {
    label: '言語 / Language',
    submenu: [['ja', '日本語'], ['en', 'English'], ['th', 'ไทย']].map(([l, label]) => ({ label, type: 'radio', checked: i18n.getLang() === l, click: () => changeLang(l) }))
  });
  const tr = (items) => items.map(({ noTr, ...it }) => ({ ...it, label: it.label && !noTr ? T(it.label) : it.label, submenu: Array.isArray(it.submenu) ? tr(it.submenu) : it.submenu }));
  Menu.setApplicationMenu(Menu.buildFromTemplate(tr(template)));
}

function changeLang(l) {
  if (l === i18n.getLang()) return;
  i18n.setLang(l);
  buildMenu();
  for (const tab of windows.values()) if (!tab.wc.isDestroyed()) tab.wc.send('lang', l);
  for (const host of hosts.values()) sendStrip(host);
}

// ---------------------------------------------------------------- 最近使ったファイル・前回の続き・異常終了時の復元
// どれも設定ファイル（settings.json）に置く。ファイルの場所はログには書かない。
// 自動テストでは本物の設定・復元用フォルダーに触れないよう、メモリーとテスト用フォルダーだけを使う

let testSettings = {};
/** 設定ファイルを読む。無いときは {}、読めない（ロック中など）ときは null（そのときは書かない。ほかの設定を消さないように） */
function readSettingsStrict() {
  let text;
  try { text = fs.readFileSync(settingsFile(), 'utf8'); } catch (e) { return e.code === 'ENOENT' ? {} : null; }
  try { return JSON.parse(text); } catch {
    // 壊れている（書きかけで終わったなど）：退避して作り直す（ずっと書けなくならないように）
    try { fs.renameSync(settingsFile(), settingsFile() + '.bak'); } catch { return null; }
    updater.log('WARN', 'settings.json was broken; moved to settings.json.bak');
    return {};
  }
}
function getSetting(k) { return SELFTEST ? testSettings[k] : (readSettingsStrict() || {})[k]; }
function setSetting(k, v) {
  if (SELFTEST) { testSettings[k] = v; return; }
  const cur = readSettingsStrict();
  if (!cur) return;
  // 一時ファイルに書いてから置き換える（書きかけの設定ファイルを残さない）
  const tmp = `${settingsFile()}.${process.pid}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify({ ...cur, [k]: v })); fs.renameSync(tmp, settingsFile()); } catch { try { fs.rmSync(tmp, { force: true }); } catch { /* 続ける */ } }
}

const RECENT_MAX = 10;
/** 最近使ったファイル・前回の続きに入れてよい場所（絶対パスの PDF・TIFF だけ） */
const docPathOk = (p) => typeof p === 'string' && path.isAbsolute(p) && /\.(pdf|tiff?)$/i.test(p);
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
function recentFiles() {
  const r = getSetting('recent');
  return Array.isArray(r) ? r.filter((x) => typeof x === 'string' && x) : [];
}
function addRecent(p) {
  if (!docPathOk(p)) return;
  setSetting('recent', [p, ...recentFiles().filter((x) => !samePath(x, p))].slice(0, RECENT_MAX));
  // タスクバーのジャンプリスト（Windows。関連付けされた形式だけ出る）
  if (!SELFTEST && process.platform === 'win32') { try { app.addRecentDocument(p); } catch { /* 出せなくても続ける */ } }
  recentChanged();
}
function clearRecent() {
  setSetting('recent', []);
  if (!SELFTEST && process.platform === 'win32') { try { app.clearRecentDocuments(); } catch { /* 続ける */ } }
  recentChanged();
}
function recentChanged() {
  buildMenu();
  for (const tab of windows.values()) if (!tab.wc.isDestroyed()) tab.wc.send('recent-changed');
}
/** 最近使ったファイルを開く。見つからなければ一覧から外して知らせる */
function openRecent(p, host = focusedHost() || lastHost) {
  if (!docPathOk(p) || !fs.existsSync(p)) {
    setSetting('recent', recentFiles().filter((x) => !samePath(x, p)));
    recentChanged();
    const tab = host?.active;
    if (tab && !tab.wc.isDestroyed()) tab.wc.send('toast', T('ファイルが見つかりません（移動または削除された可能性があります）'));
    return false;
  }
  // すでに開いていれば、そのタブに切り替える
  const open = [...windows.values()].find((t) => samePath(t.path, p));
  if (open) { activateTab(open.host, open); open.host.win.focus(); return true; }
  openInHost(host, { path: p });
  return true;
}

// 前回の続き：開いていたタブ（場所のあるもの）・ページ・倍率を覚え、次の起動で戻す
let sessionTimer = null;
let starting = true; // 起動の途中（前回の続きを開くまで）
const startedAt = Date.now();
let askingRestore = false; // 起動時に前回のファイルを開くかを聞いている間
const pendingOpen = []; // 聞いている間に、二重起動で開くよう頼まれたファイル
let keepDeclinedSession = false; // 「開かない」を選んだ（ファイルを開くまで前回の記録を残す）
let quitting = false; // 終了の途中（閉じていくウィンドウで記録が減らないように）
const restoreEnabled = () => getSetting('restoreSession') !== false;
function sessionData() {
  // 閉じようとしているウィンドウは入れない。ただし全部が閉じようとしている（アプリの終了）ときは、前の記録を残す
  const live = [...hosts.values()].filter((h) => !h.win.isDestroyed());
  const open = live.filter((h) => !h.windowClosing);
  if (!open.length) return null;
  const windowsData = open.map((h) => {
    // 前回の続きで開いている途中（ウィンドウの準備前でタブがまだない）なら、開こうとしているタブを記録する
    if (h.restoring && !h.tabs.length) return { tabs: h.restoring, active: 0 };
    const tabs = h.tabs.filter((t) => t.path);
    return { tabs: tabs.map((t) => ({ path: t.path, ...(t.viewState || {}) })), active: Math.max(0, tabs.indexOf(h.active)) };
  }).filter((w) => w.tabs.length);
  // 起動時につながらなかったファイルは、開いているタブと重ならなければ記録に残す（次の起動でまた試す）
  const left = deferredTabs.filter((d) => !windowsData.some((w) => w.tabs.some((t) => samePath(t.path, d.path))));
  if (left.length) windowsData.push({ tabs: left, active: 0 });
  return { windows: windowsData };
}
/** 終了をやめたと決まったとき（キャンセル・保存できずにウィンドウを残した）：前回の続きの記録を再開する */
function resumeSession() {
  quitting = false;
  scheduleSession();
}
function scheduleSession() {
  // 終了の途中・起動の途中（前回の続きを開き終えるまで）は記録しない（読み込んだ前回の記録を途中の状態で上書きしないように）
  if (quitting || starting) return;
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(saveSessionNow, 800);
}
function saveSessionNow() {
  clearTimeout(sessionTimer);
  const data = sessionData();
  if (data && keepDeclinedSession) {
    if (!data.windows.length) return;
    keepDeclinedSession = false;
  }
  if (data) setSetting('session', data);
}
/** ファイル・フォルダーがあるかを、時間を区切って確かめる（'yes' | 'no' | 'timeout'） */
let testUnreachable = null; // 自動テスト用：この場所で始まるものは「つながらない」ことにする
function existsSoon(p, ms = 1500) {
  if (SELFTEST && testUnreachable && p.startsWith(testUnreachable)) return new Promise((r) => setTimeout(() => r('timeout'), 50));
  return Promise.race([
    fs.promises.access(p).then(() => 'yes', () => 'no'),
    new Promise((r) => setTimeout(() => r('timeout'), ms))
  ]);
}
/** ドライブ・共有フォルダーの単位（C:\ や \\server\share） */
function rootOf(p) {
  // \\?\UNC\server\share\ の形は、共有フォルダーまでを単位にする（path.parse は \\?\UNC\ だけを返すため）
  const long = p.match(/^\\\\\?\\UNC\\[^\\]+\\[^\\]+\\/i);
  return long ? long[0] : path.parse(p).root;
}
// 前回の続きで、つながらなかった・確かめるのに時間がかかったため開かなかったタブ（記録から消さずに、次の起動でまた試す）。
// 3 回続けて開けなければ記録から外す（なくなった共有フォルダーで毎回待たないように）
let deferredTabs = [];
const DEFER_MAX = 3;
/** 前回のタブを開く。開いたら true。into を渡すと、新しいウィンドウではなくそのウィンドウのタブに開く（自動テスト用） */
async function restoreSession({ into = null } = {}) {
  const s = getSetting('session');
  const wins = Array.isArray(s?.windows) ? s.windows : [];
  // つながらないネットワークドライブで手元のファイルの確認まで待たされないよう、先にドライブ・共有フォルダーの単位で 1 回だけ確かめる
  const all = wins.flatMap((w) => (Array.isArray(w?.tabs) ? w.tabs : [])).filter((t) => docPathOk(t?.path));
  const roots = [...new Set(all.map((t) => rootOf(t.path)))];
  const rootOk = new Map(await Promise.all(roots.map(async (r) => [r, await existsSoon(r)])));
  deferredTabs = [];
  const checks = await Promise.all(wins.map((w) => Promise.all((Array.isArray(w?.tabs) ? w.tabs : []).map(async (t) => {
    if (!docPathOk(t?.path)) return null;
    const defer = () => {
      const tries = (t.tries | 0) + 1;
      if (tries < DEFER_MAX && !deferredTabs.some((d) => samePath(d.path, t.path))) deferredTabs.push({ ...t, tries });
      return null;
    };
    // ドライブ・共有フォルダーが見つからない（つないでいない）・時間切れのときは後回し
    const r = rootOk.get(rootOf(t.path));
    if (r !== 'yes') return defer();
    const f = await existsSoon(t.path);
    if (f === 'timeout') return defer();
    return f === 'yes' ? t : null; // ファイルだけがない（移動・削除）ときは外す
  }))));
  let opened = 0, missing = 0;
  for (const [wi, w] of wins.entries()) {
    const tabs = checks[wi].filter(Boolean);
    missing += checks[wi].length - tabs.length;
    if (!tabs.length) continue;
    const init = (t) => ({ path: t.path, view: { page: t.page | 0, scale: +t.scale || 0, fit: t.fit || null } });
    const host = into || hosts.get(createWindow(init(tabs[0])).id);
    if (!into) host.restoring = tabs.map((t) => ({ path: t.path, page: t.page | 0, scale: +t.scale || 0, fit: t.fit || null }));
    whenReady(host, () => {
      host.restoring = null;
      // 新しいウィンドウでは 1 つ目のタブはウィンドウと一緒にできている
      const made = into ? [] : [host.tabs[0]];
      for (const t of into ? tabs : tabs.slice(1)) made.push(addTab(host, init(t), { activate: false }));
      const act = made[Math.min(made.length - 1, Math.max(0, w.active | 0))];
      if (act && !into) activateTab(host, act);
    });
    opened += tabs.length;
  }
  if (opened || missing) updater.log('INFO', `session restore: ${opened} tabs${missing ? `, ${missing} missing` : ''}`);
  return opened > 0;
}

/** 前回開いていたファイルを開くかを聞く。open: 開くか、asked: 聞いたか（前回の記録にファイルがなければ聞かない）。
 *  answer を渡すと聞かずにその答え（0 開く / 1 開かない）を使う（自動テスト用） */
async function askRestore(answer = null) {
  const s = getSetting('session');
  const paths = (Array.isArray(s?.windows) ? s.windows : []).flatMap((w) => (Array.isArray(w?.tabs) ? w.tabs : [])).map((t) => t?.path).filter(docPathOk);
  if (!paths.length) return { open: false, asked: false, files: 0 };
  const names = paths.slice(0, 10).map((p) => `- ${path.basename(p)}`);
  if (paths.length > 10) names.push(T(`ほか ${paths.length - 10} 件`));
  const { response } = answer != null ? { response: answer } : await dialog.showMessageBox({
    type: 'question',
    buttons: [T('開く'), T('開かない')],
    defaultId: 0, cancelId: 1, noLink: true,
    message: T('前回開いていたファイルを開きますか？'),
    detail: `${names.join('\n')}\n\n${T('この確認を出さず、前回のファイルを開かないようにするには、「ファイル」メニューの「最近使ったファイル」にある「起動時に前回のファイルを開く」のチェックを外してください。')}`
  });
  updater.log('INFO', `session restore asked: ${response === 0 ? 'open' : 'skip'}`);
  // 「開かない」（Esc・閉じるも同じ）：前回の記録は消さずに残す（ファイルを開くまで空の状態で上書きしない。次の起動でまた聞く）
  if (response !== 0 && answer == null) keepDeclinedSession = true;
  return { open: response === 0, asked: true, files: paths.length };
}

// 異常終了時の復元：保存していない文書の写しを、復元用フォルダーに時々書いておく（文書の画面から送られてくる）。
// 保存した・閉じた（保存しないを選んだ場合も）ときに消す。正しく終了しなかったときだけ残る
const RUN_ID = `${Date.now()}-${process.pid}`;
const recoveryDir = () => (SELFTEST
  ? path.join(process.env.PDFSTUDIO_TEST_OUT || path.join(os.tmpdir(), 'pdfstudio-test'), 'recovery')
  : path.join(app.getPath('userData'), 'recovery'));
const recoveryBase = (tab) => path.join(recoveryDir(), `${RUN_ID}_${tab.id}`);
function clearRecovery(tab) {
  // 画面（レンダラー）が落ちたタブは、写しが唯一の内容なので消さない（次の起動で復元を聞く）
  if (tab.crashed) return;
  dropRecoveredFrom(tab);
  if (!tab.recoverySaved) return;
  tab.recoverySaved = false;
  for (const ext of ['.pdf', '.json']) { try { fs.rmSync(recoveryBase(tab) + ext, { force: true }); } catch { /* 消せなくても続ける */ } }
}
/** 写しから開いたタブの元の写しを消す（開けたあと、新しい写しができた・保存した・閉じたとき） */
function dropRecoveredFrom(tab) {
  if (!tab.recoveredFrom || !tab.recoveredOpened) return;
  removeRecoveryFiles([{ base: tab.recoveredFrom }]);
  tab.recoveredFrom = null;
}
/** 前に正しく終了しなかったときの写し（この起動のものは除く） */
function leftoverRecovery() {
  let names = [];
  try { names = fs.readdirSync(recoveryDir()); } catch { return []; }
  const out = [];
  // いま開いているタブの写し（この起動のもの・写しから開いて残しているもの）は対象外
  const inUse = new Set([...windows.values()].map((t) => t.recoveredFrom).filter(Boolean));
  const rm = (f) => { try { fs.rmSync(path.join(recoveryDir(), f), { force: true }); } catch { /* 続ける */ } };
  for (const n of names) {
    if (n.startsWith(RUN_ID + '_')) continue;
    // 書きかけの一時ファイル・記録のない写しは、前の起動の残りなので消す
    if (n.endsWith('.tmp')) { rm(n); continue; }
    if (n.endsWith('.pdf') && !names.includes(n.slice(0, -4) + '.json')) { rm(n); continue; }
    if (!n.endsWith('.json')) continue;
    const base = path.join(recoveryDir(), n.slice(0, -5));
    if (inUse.has(base)) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(base + '.json', 'utf8'));
      if (fs.existsSync(base + '.pdf')) out.push({ base, name: String(meta.name || 'document.pdf'), source: typeof meta.source === 'string' ? meta.source : null, savedAt: meta.savedAt });
      else rm(n);
    } catch { rm(n); rm(n.slice(0, -5) + '.pdf'); /* 壊れた記録は消す */ }
  }
  return out.sort((a, b) => String(a.savedAt).localeCompare(String(b.savedAt)));
}
function removeRecoveryFiles(items) {
  for (const it of items) for (const ext of ['.pdf', '.json']) { try { fs.rmSync(it.base + ext, { force: true }); } catch { /* 続ける */ } }
}
/** 起動したときに、前回の写しがあれば復元するかを聞く。0 復元 / 1 破棄 / 2 後で */
async function offerRecovery(host, answer = null) {
  const items = leftoverRecovery();
  if (!items.length) return null;
  let r = answer;
  if (r == null) {
    if (SELFTEST) return null;
    ({ response: r } = await dialog.showMessageBox(host?.win && !host.win.isDestroyed() ? host.win : undefined, {
      type: 'warning',
      buttons: [T('復元する'), T('破棄する'), T('後で決める')],
      defaultId: 0, cancelId: 2, noLink: true,
      message: T('前回 PDF Studio が正しく終了しなかったため、保存していない文書が残っています'),
      detail: `${items.map((x) => `- ${x.name}`).join('\n')}\n\n${T('「復元する」を選ぶと、保存していない状態で開きます。内容を確かめてから保存してください。')}`
    }));
  }
  updater.log('INFO', `recovery: ${items.length} left, answer ${r}`);
  if (r === 2) return r;
  if (r === 0) {
    const target = host && !host.win.isDestroyed() ? host : lastHost;
    for (const it of items) {
      let bytes;
      try { bytes = fs.readFileSync(it.base + '.pdf'); } catch { continue; } // 読めなかった写しは残す（次の起動でまた聞く）
      // 同じファイルを前回の続きで（変更前の状態で）開いていたら、復元したものを開いてからそのタブを閉じる
      // （先に閉じると、それが最後のタブのときウィンドウごと閉じてしまう）
      const same = it.source && [...windows.values()].find((t) => samePath(t.path, it.source) && (!t.dirty || t.convertedOnly));
      // 保存するときは保存先を聞く（落ちている間に元のファイルがほかで更新されていても、黙って上書きしないように）。
      // 元の写しは、開けて新しい写しができた・保存した・閉じたときに消す
      openInHost(target, { bytes, name: it.name, path: null, source: it.source, recovered: true, recoveredFrom: it.base }, { replaceBlank: !same });
      if (same) destroyTab(same);
    }
  }
  if (r === 1) removeRecoveryFiles(items);
  return r;
}

ipcMain.on('doc-source', (e, p) => {
  // 文書の元のファイル（開いた・保存した場所）。最近使ったファイルと前回の続きに使う
  const tab = entryFor(e);
  if (!tab || (p != null && !docPathOk(p))) return;
  tab.path = p || null;
  if (p) {
    addRecent(p);
    // 後回しにしていたファイルを開いたら、後回しの一覧から外す（このあと閉じたら、次の起動では開かない）
    deferredTabs = deferredTabs.filter((d) => !samePath(d.path, p));
  }
  scheduleSession();
});
ipcMain.on('doc-view', (e, v) => {
  const tab = entryFor(e);
  if (!tab || !v || typeof v !== 'object') return;
  tab.viewState = { page: v.page | 0, scale: Number.isFinite(+v.scale) ? +v.scale : 0, fit: ['width', 'page'].includes(v.fit) ? v.fit : null };
  scheduleSession();
});
ipcMain.handle('recent-files', () => recentFiles().map((p) => ({ path: p, name: path.basename(p), dir: path.dirname(p) })));
ipcMain.handle('open-recent', (e, p) => (typeof p === 'string' && recentFiles().some((x) => samePath(x, p)) ? openRecent(p, entryFor(e)?.host) : false));
ipcMain.on('recovery-opened', (e) => {
  // 写しから開いたタブが開けた（このあと新しい写しができる・保存する・閉じると、元の写しを消してよい）
  const tab = entryFor(e);
  if (tab?.recoveredFrom) tab.recoveredOpened = true;
});
ipcMain.handle('recovery-save', async (e, bytes, meta) => {
  const tab = entryFor(e);
  if (!tab || !ArrayBuffer.isView(bytes) || !tab.dirty) return false;
  try {
    await fs.promises.mkdir(recoveryDir(), { recursive: true });
    const base = recoveryBase(tab);
    // 大きな文書でもほかのウィンドウを止めないよう非同期で書く。書きかけを残さないよう、一時ファイルに書いてから名前を変える
    await fs.promises.writeFile(base + '.pdf.tmp', Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    const alive = () => windows.get(tab.id) === tab && tab.dirty;
    if (!alive()) { await fs.promises.rm(base + '.pdf.tmp', { force: true }); return false; } // 書いている間に保存・閉じた
    // 記録（.json）を先に置く（.pdf だけが残ると、次の起動で半端なものとして消されるため）
    await fs.promises.writeFile(base + '.json', JSON.stringify({
      name: String(meta?.name || 'document.pdf'), source: tab.path || null, savedAt: new Date().toISOString()
    }));
    await fs.promises.rename(base + '.pdf.tmp', base + '.pdf');
    if (!alive()) {
      // 書き終える直前に保存・閉じた：写しは要らない
      for (const ext of ['.pdf', '.json']) await fs.promises.rm(base + ext, { force: true });
      return false;
    }
    tab.recoverySaved = true;
    dropRecoveredFrom(tab); // 新しい写しができたので、元の写しは要らない
    return true;
  } catch (err) {
    updater.log('WARN', `recovery save failed: ${err.code || 'error'}`);
    return false;
  }
});

// ---------------------------------------------------------------- IPC

ipcMain.handle('get-initial', async (e) => {
  const entry = entryFor(e);
  const init = entry?.initial;
  if (!init) return null;
  entry.initial = null;
  if (init.bytes) return init;
  try {
    // 開くまでの時間を調べるため、読み込みの時間と大きさだけを記録する（ファイル名は書かない）
    const t0 = Date.now();
    const bytes = fs.readFileSync(init.path);
    if (!SELFTEST) updater.log('INFO', `open read: ${Date.now() - t0}ms ${(bytes.length / 1048576).toFixed(1)}MB ${path.extname(init.path).toLowerCase()} uptime ${Math.round(process.uptime() * 1000)}ms`);
    return { path: init.path, name: path.basename(init.path), bytes, view: init.view || null };
  } catch (err) {
    entry.path = null; // 開けなかったので、前回の続き・最近使ったファイルの対象から外す
    scheduleSession();
    return { error: err.message };
  }
});

ipcMain.on('set-dirty', (e, dirty, convertedOnly) => {
  const entry = entryFor(e);
  if (entry) {
    entry.dirty = dirty;
    entry.convertedOnly = !!(dirty && convertedOnly); // TIFF を変換して開いただけ（編集はしていない）
    if (dirty) entry.forceClose = false; // 編集し直したら、閉じるときにまた確かめる
    else clearRecovery(entry); // 保存できた（変更がなくなった）ので、異常終了時の写しは要らない
    sendStrip(entry.host);
  }
});

ipcMain.on('set-title', (e, title) => {
  const tab = entryFor(e);
  if (!tab) return;
  tab.title = String(title);
  if (tab.title !== 'PDF Studio') tab.empty = false;
  if (tab.host.active === tab) updateTitle(tab.host);
  sendStrip(tab.host);
});

// 「保存して閉じる」で保存できなかった（名前を付けて保存のキャンセル・書き込みの失敗）。
// 確かめずに保存する設定で閉じようとしていたときは、閉じられなくならないよう、この回だけいつもの確認を出す
ipcMain.on('save-close-failed', async (e) => {
  const tab = entryFor(e);
  if (!tab) return;
  const host = tab.host;
  const closing = host.closing;
  const auto = tab.autoSaved;
  tab.autoSaved = false;
  host.closing = false;
  // 保存できなかったのでウィンドウは閉じない（アプリの終了の途中なら、終了もやめたことになる）
  if (!auto || host.asking || host.win.isDestroyed()) { resumeSession(); return; }
  host.asking = true;
  let r;
  try { r = await askSave(host.win, null, { force: true }); } finally { host.asking = false; }
  if (windows.get(tab.id) !== tab || tab.host !== host || host.win.isDestroyed()) return;
  if (r === 0) {
    tab.wc.send('menu', 'save-and-close');
    host.closing = closing;
  } else if (r === 1) {
    tab.forceClose = true;
    if (closing) host.win.close();
    else { keepWindowOpen(host, tab); destroyTab(tab); resumeSession(); }
  } else resumeSession();
});

ipcMain.on('close-window', (e) => {
  const entry = entryFor(e);
  if (!entry) return;
  // 「保存して閉じる」で保存できた。ウィンドウを閉じる途中なら、続けて閉じ直す
  const host = entry.host;
  const closing = host.closing;
  entry.forceClose = true;
  keepWindowOpen(host, entry);
  destroyTab(entry);
  if (closing && host.tabs.length && !host.win.isDestroyed()) host.win.close();
});

const trFilters = (filters) => filters?.map((f) => ({ ...f, name: T(f.name) }));

ipcMain.on('get-lang', (e) => { e.returnValue = i18n.getLang(); });
// 動作の記録（updater.log に 1 行。個人情報は入れない）
ipcMain.on('log-info', (e, msg) => updater.log('INFO', String(msg).slice(0, 300)));
ipcMain.on('log-error', (e, source, err) => errorlog.record(source === 'handled' ? 'renderer-handled' : 'renderer', err));

ipcMain.handle('open-dialog', async (e, opts) => {
  const q = fromQueue('open');
  if (q.hit) return q.v.map((p) => ({ path: p, name: path.basename(p), bytes: fs.readFileSync(p) }));
  const r = await dialog.showOpenDialog(entryFor(e).win, {
    title: T(opts.title),
    filters: trFilters(opts.filters),
    properties: ['openFile', ...(opts.multiple ? ['multiSelections'] : [])]
  });
  if (r.canceled) return [];
  return r.filePaths.map((p) => ({ path: p, name: path.basename(p), bytes: opts.readContents === false ? null : fs.readFileSync(p) }));
});

ipcMain.handle('save-dialog', async (e, opts) => {
  const q = fromQueue('save');
  if (q.hit) return q.v;
  const r = await dialog.showSaveDialog(entryFor(e).win, { title: T(opts.title), defaultPath: opts.defaultPath, filters: trFilters(opts.filters) });
  return r.canceled ? null : r.filePath;
});

ipcMain.handle('choose-folder', async (e, title) => {
  const q = fromQueue('folder');
  if (q.hit) return q.v;
  const r = await dialog.showOpenDialog(entryFor(e).win, { title: T(title), properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

/** 一時ファイルに書いてから置き換える（書き込み途中で失敗しても元のファイルを壊さない） */
function writeAtomic(filePath, bytes) {
  const tmp = `${filePath}.${process.pid}-${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, Buffer.from(bytes));
    fs.renameSync(tmp, filePath);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    if (err.code === 'EBUSY' || err.code === 'EPERM') throw new Error(T('ファイルが他のアプリで開かれているため保存できません。そのアプリを閉じてからもう一度保存してください。'));
    throw err;
  }
}

ipcMain.handle('write-file', async (e, filePath, bytes) => {
  writeAtomic(filePath, bytes);
  return true;
});

ipcMain.handle('write-files', async (e, folder, files) => {
  for (const f of files) writeAtomic(path.join(folder, path.basename(f.name)), f.data);
  return files.length;
});

ipcMain.handle('file-size', async (e, filePath) => {
  try { return fs.statSync(filePath).size; } catch { return null; }
});

ipcMain.handle('read-asset', async (e, rel) => {
  const p = path.join(ROOT, 'assets', rel);
  if (!p.startsWith(path.join(ROOT, 'assets'))) throw new Error('invalid path');
  return fs.readFileSync(p);
});

// 2 つ目以降の文書は、同じウィンドウの新しいタブで開く
ipcMain.handle('open-in-new-window', async (e, bytes, name, filePath) => {
  openInHost(entryFor(e)?.host || lastHost, { bytes: Buffer.from(bytes), name, path: filePath || null }, { replaceBlank: false });
});

// ---------------------------------------------------------------- タブバー

/** タブバーからの送信だけ受け付ける */
const hostFor = (e) => { const h = hosts.get(BrowserWindow.fromWebContents(e.sender)?.id); return h && e.sender === h.win.webContents ? h : null; };
const tabOf = (host, id) => { const t = windows.get(id); return host && t?.host === host ? t : null; };
ipcMain.on('tabs:ready', (e) => sendStrip(hostFor(e)));
ipcMain.on('tabs:activate', (e, id) => { const h = hostFor(e); const t = tabOf(h, id); if (t) activateTab(h, t); });
ipcMain.on('tabs:close', (e, id) => { const t = tabOf(hostFor(e), id); if (t) requestCloseTab(t); });
ipcMain.on('tabs:new', (e) => { const h = hostFor(e); if (h) addTab(h); });
ipcMain.on('tabs:move', (e, id, index) => {
  const h = hostFor(e);
  const t = tabOf(h, id);
  if (!t || !Number.isInteger(index)) return;
  const from = h.tabs.indexOf(t);
  h.tabs.splice(from, 1);
  h.tabs.splice(Math.max(0, Math.min(h.tabs.length, index > from ? index - 1 : index)), 0, t);
  fillPanes(h);
  layout(h);
  if (h.active && !h.active.wc.isDestroyed()) h.active.wc.focus();
});
ipcMain.on('tabs:menu', (e, id) => {
  const h = hostFor(e);
  const t = tabOf(h, id);
  if (!t) return;
  const others = () => h.tabs.filter((x) => x !== t);
  Menu.buildFromTemplate([
    { label: T('タブを閉じる'), click: () => requestCloseTab(t) },
    { label: T('ほかのタブを閉じる'), enabled: h.tabs.length > 1, click: async () => { for (const x of others()) if ((await requestCloseTab(x)) !== true) break; } },
    { type: 'separator' },
    { label: T('新しいウィンドウに移す'), enabled: h.tabs.length > 1, click: () => moveTabToNewWindow(t) }
  ]).popup({ window: h.win });
});
ipcMain.on('tabs:layout-menu', (e) => {
  const h = hostFor(e);
  if (!h) return;
  Menu.buildFromTemplate(layoutItems(() => h).map((it) => ({ ...it, label: T(it.label) }))).popup({ window: h.win });
});
ipcMain.on('tabs:open', (e, files) => {
  const h = hostFor(e);
  if (!h || !Array.isArray(files)) return;
  for (const f of files) {
    if (!f || typeof f.name !== 'string' || !(f.bytes instanceof Uint8Array)) continue;
    // 場所は TIFF のときだけ受け取る（PDF は場所なしで開く。保存で元のファイルを上書きしないように）
    const where = typeof f.path === 'string' && /\.tiff?$/i.test(f.path) && path.isAbsolute(f.path) ? f.path : null;
    openInHost(h, { bytes: Buffer.from(f.bytes), name: path.basename(f.name), path: where });
  }
});

ipcMain.handle('open-path-new-window', async (e, p) => openPath(p));

ipcMain.handle('show-in-folder', async (e, p) => { if (!SELFTEST) shell.showItemInFolder(p); });

// 自動テスト用（--selftest 起動時のみ有効）
ipcMain.handle('selftest', async (e, cmd, arg) => {
  if (!SELFTEST) return null;
  const entry = entryFor(e);
  // 文書の画面が arg の大きさ（タブバーの分だけウィンドウを高くする。以前のウィンドウの大きさと同じ）
  if (cmd === 'size') { entry.win.setSize(arg[0], arg[1] + STRIP_H); layout(entry.host); return true; }
  if (cmd === 'tabs') {
    const h = entry.host;
    return { self: entry.id, active: h.active?.id ?? null, mode: h.mode, windows: hosts.size, tabs: h.tabs.map((t) => ({ id: t.id, title: tabLabel(t), dirty: t.dirty, mark: t.dirty && !t.convertedOnly, ask: needsAsk(t), rawTitle: t.title, visible: paneRects(h).some((r) => r.tab === t) })), panes: paneRects(h).map((r) => ({ id: r.tab.id, ...r.rect })) };
  }
  if (cmd === 'tab') {
    const h = entry.host;
    const t = arg.id != null ? tabOf(h, arg.id) : null;
    if (arg.do === 'new') return addTab(h, null, { activate: !!arg.activate }).id;
    if (arg.do === 'activate' && t) { activateTab(h, t); return true; }
    if (arg.do === 'close' && t) return await requestCloseTab(t);
    if (arg.do === 'force-close' && t) { destroyTab(t); return true; }
    if (arg.do === 'mode') { setMode(h, arg.mode); return true; }
    if (arg.do === 'menu') { send(arg.action, h); return true; }
    if (arg.do === 'move' && t) { const i = h.tabs.indexOf(t); h.tabs.splice(i, 1); h.tabs.splice(arg.index, 0, t); layout(h); return true; }
    if (arg.do === 'strip') return h.win.webContents.executeJavaScript(arg.js);
    if (arg.do === 'eval' && t) return t.wc.executeJavaScript(arg.js);
    // ほかのウィンドウに移ったタブも対象にする
    const any = windows.get(arg.id);
    if (arg.do === 'move-window' && t) { moveTabToNewWindow(t); return true; }
    if (arg.do === 'eval-any' && any) return any.wc.executeJavaScript(arg.js);
    if (arg.do === 'shot-any' && any) {
      const img = await any.wc.capturePage();
      fs.writeFileSync(path.join(process.env.PDFSTUDIO_TEST_OUT || path.join(os.tmpdir(), 'pdfstudio-test'), `${arg.name}.png`), img.toPNG());
      return true;
    }
    if (arg.do === 'close-any' && any) { destroyTab(any); return true; }
    if (arg.do === 'request-close-any' && any) {
      // タブの × と同じ閉じ方。閉じたあとのそのウィンドウの様子を返す
      const h = any.host;
      await requestCloseTab(any);
      return { windowOpen: !h.win.isDestroyed() && !h.forceClose, tabs: h.tabs.map((x) => ({ id: x.id, empty: x.empty })) };
    }
    if (arg.do === 'front-any' && any) {
      // 元のウィンドウと重ならない位置に動かして前に出す
      const b = entry.host.win.getBounds();
      any.host.win.setBounds({ x: b.x + 80, y: b.y + 60, width: b.width, height: b.height });
      any.host.win.moveTop();
      any.host.win.focus();
      return true;
    }
    if (arg.do === 'info-any' && any) {
      const w = any.host.win;
      const f = BrowserWindow.getFocusedWindow();
      return { ready: any.host.ready, inTabs: any.host.tabs.includes(any), active: any.host.active === any, viewVisible: any.view.getVisible(), winVisible: w.isVisible(), winFocused: w.isFocused(), focused: f ? (f === w ? 'moved' : f === entry.host.win ? 'main' : 'other') : 'none', moved: w.getBounds(), main: entry.host.win.getBounds() };
    }
    if (arg.do === 'askSave') { selftestQueue.askSave.push(...arg.answers); return true; }
    if (arg.do === 'window-close') { let prevented = false; await onWindowClose(h, { preventDefault: () => { prevented = true; } }); return prevented; }
    if (arg.do === 'ask-save') return await askSave(h.win);
    if (arg.do === 'busy-close' && t) { h.asking = true; try { return await requestCloseTab(t); } finally { h.asking = false; } }
    if (arg.do === 'askSave-clear') { const n = selftestQueue.askSave.length; selftestQueue.askSave.length = 0; return n; }
    if (arg.do === 'menu-save-prompt') {
      // メニューの「閉じるときの保存の確認」で選ばれている項目
      const ed = Menu.getApplicationMenu()?.items.find((it) => it.submenu?.items.some((x) => x.submenu?.items.length === 3 && x.submenu.items.every((y) => y.type === 'radio')));
      const sub = ed?.submenu.items.find((x) => x.submenu?.items.length === 3 && x.submenu.items.every((y) => y.type === 'radio'));
      return sub ? sub.submenu.items.findIndex((y) => y.checked) : -1;
    }
    if (arg.do === 'save-prompt') { if (arg.value) setSavePrompt(arg.value); return savePrompt(); }
    if (arg.do === 'state') return t ? { dirty: t.dirty, forceClose: t.forceClose, open: true } : { open: false };
    if (arg.do === 'focus-self') { h.win.focus(); return true; }
    return null;
  }
  if (cmd === 'errorlog') {
    if (arg?.record) errorlog.record('renderer-handled', { message: arg.record });
    return { log: errorlog.readLog(), body: errorlog.buildBody('test'), sanitized: errorlog.sanitize(arg?.sanitize || '') };
  }
  if (cmd === 'queue') { selftestQueue[arg.kind].push(arg.value); return true; }
  if (cmd === 'benchFiles') return fs.readdirSync(process.env.PDFSTUDIO_BENCH_DIR).filter((f) => /\.tiff?$/i.test(f)).sort();
  if (cmd === 'benchZoom') return !!process.env.PDFSTUDIO_BENCH_ZOOM;
  if (cmd === 'benchRead') return fs.readFileSync(path.join(process.env.PDFSTUDIO_BENCH_DIR, path.basename(arg)));
  if (cmd === 'outdir') { const d = process.env.PDFSTUDIO_TEST_OUT || path.join(os.tmpdir(), 'pdfstudio-test'); fs.mkdirSync(d, { recursive: true }); return d; }
  if (cmd === 'stripshot') {
    // タブバーと、並べて表示した画面をまとめて 1 枚に（確認用）
    const h = entry.host;
    const base = await h.win.webContents.capturePage();
    const parts = await Promise.all(paneRects(h).map(async (r) => ({ r: r.rect, img: await r.tab.wc.capturePage() })));
    const d = process.env.PDFSTUDIO_TEST_OUT || path.join(os.tmpdir(), 'pdfstudio-test');
    fs.writeFileSync(path.join(d, arg + '_strip.png'), base.toPNG());
    parts.forEach((p, i) => fs.writeFileSync(path.join(d, `${arg}_pane${i}.png`), p.img.toPNG()));
    return true;
  }
  if (cmd === 'capture') {
    // 画面の一部を写して返す（ページの絵が画面にそのまま出ているか、画素で確かめるため）
    const img = await entry.wc.capturePage(arg);
    const sz = img.getSize();
    return { w: sz.width, h: sz.height, data: img.toBitmap() };
  }
  if (cmd === 'shot') {
    const img = await entry.wc.capturePage();
    const d = process.env.PDFSTUDIO_TEST_OUT || path.join(os.tmpdir(), 'pdfstudio-test');
    fs.writeFileSync(path.join(d, arg + '.png'), img.toPNG());
    return true;
  }
  if (cmd === 'session') {
    // 最近使ったファイル・前回の続き・異常終了時の復元（テスト用の設定とフォルダーだけを使う）
    if (arg.do === 'state') {
      saveSessionNow();
      const files = (() => { try { return fs.readdirSync(recoveryDir()); } catch { return []; } })();
      return {
        recent: recentFiles(), session: getSetting('session') || null, restore: restoreEnabled(),
        tab: { path: entry.path || null, view: entry.viewState || null, recoverySaved: !!entry.recoverySaved },
        recovery: files, runId: RUN_ID
      };
    }
    if (arg.do === 'set') { testSettings[arg.key] = arg.value; buildMenu(); return true; }
    if (arg.do === 'unreachable') { testUnreachable = arg.prefix || null; return true; }
    if (arg.do === 'clear-recent') { clearRecent(); return recentFiles(); }
    if (arg.do === 'open-recent') return openRecent(arg.path, entry.host);
    if (arg.do === 'menu-recent') {
      const file = Menu.getApplicationMenu()?.items.find((x) => x.submenu?.items.some((y) => y.label === T('最近使ったファイル')));
      const sub = file?.submenu.items.find((y) => y.label === T('最近使ったファイル'))?.submenu;
      return sub ? sub.items.map((y) => ({ label: y.label, type: y.type, checked: y.checked, enabled: y.enabled })) : null;
    }
    if (arg.do === 'ask-restore') return askRestore(arg.answer);
    if (arg.do === 'restore') {
      // 前回の続きを開き直す（新しいウィンドウに開く）。開いたタブの id を返す
      const before = new Set(windows.keys());
      const ok = await restoreSession({ into: arg.newWindow ? null : entry.host });
      const immediate = sessionData(); // 読み込み前でも前回の続きに入っているか
      await new Promise((r) => setTimeout(r, 2500));
      return { ok, immediate, tabs: [...windows.values()].filter((t) => !before.has(t.id)).map((t) => ({ id: t.id, path: t.path || null, title: tabLabel(t) })) };
    }
    if (arg.do === 'fake-leftover') {
      // 前の起動が残した写しのふり（別の RUN_ID）
      fs.mkdirSync(recoveryDir(), { recursive: true });
      const base = path.join(recoveryDir(), `old-run_${arg.n || 1}`);
      fs.writeFileSync(base + '.pdf', Buffer.from(arg.bytes.buffer, arg.bytes.byteOffset, arg.bytes.byteLength));
      fs.writeFileSync(base + '.json', JSON.stringify({ name: arg.name, path: null, source: arg.source || null, savedAt: new Date().toISOString() }));
      return leftoverRecovery().length;
    }
    if (arg.do === 'offer') {
      const before = new Set(windows.keys());
      const r = await offerRecovery(entry.host, arg.answer);
      await new Promise((res) => setTimeout(res, 1500));
      return { r, left: leftoverRecovery().length, opened: [...windows.values()].filter((t) => !before.has(t.id)).map((t) => ({ id: t.id, title: tabLabel(t), dirty: t.dirty, path: t.path || null })) };
    }
    return null;
  }
  if (cmd === 'portable-openwith') {
    // インストール不要版の「プログラムから開く」の書き直しを決める部分（レジストリには触れない）
    const d = (o) => defaultapp.decidePortableOpenWith({ exe: 'D:\\new\\PDF Studio.exe', version: '1.5.22', exists: true, registeredIsInstalled: false, registeredVersion: null, ...o });
    return {
      parse: [defaultapp.exeFromCommand('"C:\\a b\\PDF Studio.exe" "%1"'), defaultapp.exeFromCommand('C:\\x\\PDF Studio.exe %1'), defaultapp.exeFromCommand(null)],
      cases: [
        d({ registeredExe: null }), d({ registeredExe: 'D:/new/./PDF Studio.exe' }),
        d({ registeredExe: 'd:\\NEW\\pdf studio.exe' }), d({ registeredExe: 'D:\\old\\PDF Studio.exe', exists: false }),
        d({ registeredExe: 'C:\\inst\\PDF Studio.exe', registeredIsInstalled: true }),
        d({ registeredExe: 'D:\\old\\PDF Studio.exe', registeredVersion: '1.5.21' }), d({ registeredExe: 'D:\\new2\\PDF Studio.exe', registeredVersion: '1.5.30' }),
        d({ registeredExe: 'D:\\new2\\PDF Studio.exe', registeredVersion: '1.5.30', exists: false })
      ],
      cmp: [defaultapp.compareVersion('1.5.10', '1.5.9'), defaultapp.compareVersion('1.5.9', '1.5.10'), defaultapp.compareVersion('1.5.9', '1.5.9'), defaultapp.compareVersion('1.5.22-beta.1', '1.5.22')]
    };
  }
  if (cmd === 'log') {
    testWatch.last = Date.now();
    testWatch.line = String(arg).slice(0, 200);
    process.stdout.write(arg + '\n');
    const d = process.env.PDFSTUDIO_TEST_OUT || path.join(os.tmpdir(), 'pdfstudio-test');
    fs.appendFileSync(path.join(d, 'log.txt'), arg + '\n');
    return true;
  }
  if (cmd === 'input') {
    // 実際のマウス・キー入力をウィンドウに送る（UI 操作のテスト用）
    for (const ev of arg) {
      if (ev.wait) { await new Promise((r) => setTimeout(r, ev.wait)); continue; }
      entry.wc.sendInputEvent(ev);
      await new Promise((r) => setTimeout(r, 8));
    }
    return true;
  }
  if (cmd === 'metrics') {
    const mb = (k) => Math.round(k / 1024);
    const m = app.getAppMetrics();
    return { self: e.sender.getOSProcessId(), total: mb(m.reduce((s, x) => s + x.memory.workingSetSize, 0)), byType: Object.fromEntries(m.map((x) => [x.type + '-' + x.pid, mb(x.memory.workingSetSize)])) };
  }
  if (cmd === 'done') {
    let code = arg || testWatch.unexpected ? 1 : 0;
    // 最後に、このウィンドウで最後のタブを閉じても空のタブが残る（アプリが終わらない）ことを確かめる
    const host = entry.host;
    if (!PERFTEST && host.ready && host.tabs.length === 1 && !entry.empty) {
      entry.dirty = false;
      await requestCloseTab(entry);
      const ok = !host.win.isDestroyed() && !host.forceClose && host.tabs.length === 1 && host.tabs[0] !== entry && host.tabs[0].empty;
      const line = `${ok ? '✅' : '❌'} 最後のタブを閉じても空のタブが残りアプリは終わらない (タブ ${host.tabs.length})`;
      process.stdout.write(line + '\n');
      if (!ok) code = 1;
    }
    host.forceClose = true;
    setTimeout(() => app.exit(code), 200);
    return true;
  }
  return null;
});
ipcMain.handle('open-external', async (e, url) => {
  if (/^(https?:|mailto:)/i.test(url)) await shell.openExternal(url);
});

ipcMain.handle('message-box', async (e, opts) => {
  const r = await dialog.showMessageBox(entryFor(e).win, { ...opts, message: T(opts.message), detail: T(opts.detail), buttons: opts.buttons?.map(T) });
  return r.response;
});

/** テキストファイルを読む。文字コードを判定する（BOM 付き UTF-16 / UTF-8 / それ以外は Shift_JIS） */
function readText(src) {
  const buf = Buffer.isBuffer(src) ? src : fs.readFileSync(src);
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(buf);
  } catch {
    return new TextDecoder('shift_jis').decode(buf);
  }
}

// 文書ファイル（Word / テキスト / HTML）→ PDF 変換（Chromium の印刷機能を使用）
// src はファイルの場所、または { bytes, name }（ドラッグ＆ドロップなど、場所が分からないとき）
ipcMain.handle('convert-to-pdf', async (e, src) => {
  const byBytes = src !== null && typeof src === 'object';
  if (byBytes ? !ArrayBuffer.isView(src.bytes) : typeof src !== 'string') throw new Error('invalid source');
  const ext = path.extname(byBytes ? String(src.name || '') : src).toLowerCase();
  // 受け取った中身はコピーせずに使う
  const input = byBytes ? Buffer.from(src.bytes.buffer, src.bytes.byteOffset, src.bytes.byteLength) : src;
  let html;
  if (ext === '.docx') {
    const mammoth = require('mammoth');
    const r = await mammoth.convertToHtml(byBytes ? { buffer: input } : { path: input });
    html = r.value;
  } else if (ext === '.html' || ext === '.htm') {
    html = readText(input);
  } else {
    const t = readText(input);
    html = '<pre>' + t.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</pre>';
  }
  const full = `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font-family:"Yu Gothic","Meiryo","Hiragino Sans","Noto Sans JP",sans-serif;font-size:11pt;line-height:1.6;color:#000}
    pre{white-space:pre-wrap;font-family:inherit}
    img{max-width:100%} table{border-collapse:collapse} td,th{border:1px solid #999;padding:4px}
  </style></head><body>${html}</body></html>`;
  // 同時に変換しても名前がぶつからないように乱数を付ける
  const tmp = path.join(os.tmpdir(), `pdfstudio-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.html`);
  fs.writeFileSync(tmp, full);
  const w = new BrowserWindow({ show: false, webPreferences: { javascript: false } });
  try {
    await w.loadFile(tmp);
    const pdf = await w.webContents.printToPDF({ pageSize: 'A4', printBackground: true, margins: { marginType: 'default' } });
    return pdf;
  } finally {
    w.destroy();
    fs.rmSync(tmp, { force: true });
  }
});

// Word (.docx) 書き出し
ipcMain.handle('export-docx', async (e, filePath, pages) => {
  const { Document, Packer, Paragraph, TextRun, PageBreak } = require('docx');
  const children = [];
  pages.forEach((lines, i) => {
    for (const line of lines) children.push(new Paragraph({ children: [new TextRun({ text: line, font: 'Yu Gothic' })] }));
    if (i < pages.length - 1) children.push(new Paragraph({ children: [new PageBreak()] }));
  });
  const doc = new Document({ sections: [{ children }] });
  fs.writeFileSync(filePath, await Packer.toBuffer(doc));
  return true;
});

// 印刷：ページ画像を一時フォルダに 1 枚ずつ受け取り、まとめて印刷する
const printJobs = new Map();
ipcMain.handle('print-begin', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfstudio-print-'));
  const id = path.basename(dir);
  printJobs.set(id, { dir, pages: [] });
  return id;
});
ipcMain.handle('print-page', async (e, id, index, bytes) => {
  const job = printJobs.get(id);
  if (!job) throw new Error('print job not found');
  const file = path.join(job.dir, `p${String(index).padStart(5, '0')}.jpg`);
  fs.writeFileSync(file, Buffer.from(bytes));
  job.pages.push(file);
  return true;
});
ipcMain.handle('print-cancel', async (e, id) => {
  const job = printJobs.get(id);
  if (job) fs.rmSync(job.dir, { recursive: true, force: true });
  printJobs.delete(id);
});
ipcMain.handle('print-run', async (e, id, landscape) => {
  const job = printJobs.get(id);
  if (!job) return 'no job';
  const body = job.pages.map((f) => `<div class="p"><img src="${pathToFileURL(f).href}"></div>`).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    @page{margin:0} body{margin:0} .p{page-break-after:always;width:100%;height:100vh;display:flex;align-items:center;justify-content:center}
    .p:last-child{page-break-after:auto} img{max-width:100%;max-height:100vh}
  </style></head><body>${body}</body></html>`;
  const htmlPath = path.join(job.dir, 'print.html');
  fs.writeFileSync(htmlPath, html);
  const w = new BrowserWindow({ show: false, webPreferences: { javascript: false } });
  try {
    await w.loadFile(htmlPath);
    return await new Promise((resolve) => {
      w.webContents.print({ silent: false, printBackground: true, landscape: !!landscape }, (ok, reason) => resolve(ok ? 'ok' : reason));
    });
  } finally {
    w.destroy();
    fs.rmSync(job.dir, { recursive: true, force: true });
    printJobs.delete(id);
  }
});

// ---------------------------------------------------------------- 起動

function filesFromArgv(argv) {
  return argv.slice(app.isPackaged ? 1 : 2).filter((a) => /\.(pdf|tiff?)$/i.test(a) && fs.existsSync(a));
}

// タスクバーでのグループ化や通知に使うアプリ ID（インストーラーの appId と同じ）
if (process.platform === 'win32') app.setAppUserModelId('local.pdfstudio');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (e, argv) => {
    const files = filesFromArgv(argv);
    // 前回のファイルを開くかを聞いている間は、指定されたファイルをためておき、答えのあとで開く（ファイルなしなら何もしない）
    if (askingRestore) { pendingOpen.push(...files); return; }
    if (files.length) files.forEach(openPath);
    // 起動の途中（前回の続きを開いている）は空のウィンドウを余分に作らない。
    // ただし、起動処理が失敗して印が残っても立ち直れるよう、10 秒たったら受け付ける
    else if (starting && Date.now() - startedAt < 10000) return;
    else if (lastHost && !lastHost.win.isDestroyed()) {
      // もう一度起動されたら、今のウィンドウに新しいタブを開く
      const host = lastHost;
      whenReady(host, () => { if (!host.win.isDestroyed() && !host.active?.empty) addTab(host); });
      if (lastHost.win.isMinimized()) lastHost.win.restore();
      lastHost.win.focus();
    } else createWindow();
  });

  app.whenReady().then(async () => {
    // 途中で失敗しても、起動中の印が残らないようにする（残ると前回の続きの記録が止まったままになる）
    try {
    protocol.handle('app', (req) => {
      const { pathname } = new URL(req.url);
      const p = path.normalize(path.join(ROOT, decodeURIComponent(pathname)));
      if (!p.startsWith(ROOT)) return new Response('forbidden', { status: 403 });
      return net.fetch(pathToFileURL(p).toString());
    });
    i18n.init(app.getPath('userData'));
    errorlog.init(app.getPath('userData'), { isSelftest: SELFTEST });
    if (!SELFTEST) {
      updater.logStartup();
      // 表示言語と、それが保存された設定（メニューで選んだ）かどうか
      updater.log('INFO', `lang: ${i18n.getLang()} (saved: ${i18n.savedLang() || 'none'})`);
      // 表示の重さを調べるため、GPU が使えているかを記録する
      app.once('gpu-info-update', () => {
        try { updater.log('INFO', `gpu: ${JSON.stringify(app.getGPUFeatureStatus())}`); } catch { /* 記録できなくても続ける */ }
      });
    }
    buildMenu();
    const files = filesFromArgv(process.argv);
    if (!SELFTEST) updater.log('INFO', `ready: uptime ${Math.round(process.uptime() * 1000)}ms`);
    // ファイルを指定して起動したときはそのファイルだけを開く。指定がなければ前回の続き（設定で切れる）
    if (files.length) files.forEach(openPath);
    else if (SELFTEST || !restoreEnabled()) createWindow();
    else {
      // 前回の続き。開く前に開くかどうかを聞く。開かない・開けなかった（失敗・開けるファイルがない）ときは空のウィンドウ
      let ok = false;
      askingRestore = true;
      try { if ((await askRestore()).open) ok = await restoreSession(); } catch (e) { updater.log('ERROR', e); }
      askingRestore = false;
      // 聞いている間にほかから開くよう頼まれたファイル
      // 前回の続きで開くもの（まだタブになっていないものも）・開いているもの・ためた中の重なりは除く
      const busy = [...[...hosts.values()].flatMap((h) => (h.restoring || []).map((t) => t.path)), ...[...windows.values()].map((t) => t.path)].filter(Boolean);
      const queued = [];
      for (const f of pendingOpen.splice(0)) if (![...busy, ...queued].some((x) => samePath(x, f))) queued.push(f);
      try { queued.forEach(openPath); } catch (e) { updater.log('ERROR', e); }
      if (queued.length) ok = true;
      try { if (!ok && !hosts.size) createWindow(); } catch (e) { updater.log('ERROR', e); }
    }
    starting = false;
    scheduleSession(); // 起動中は止めていた前回の続きの記録を、開き終えた状態で書く
    // 前回正しく終了しなかったときの写しがあれば、復元するかを聞く
    if (!SELFTEST) { const h = lastHost; if (h) whenReady(h, () => setTimeout(() => offerRecovery(lastHost).catch((e) => updater.log('ERROR', e)), 1500)); }
    if (SELFTEST) BrowserWindow.getAllWindows()[0]?.setSize(1400, 900 + STRIP_H);
    else {
      updater.setUnsavedChecker(() => [...windows.values()].some((e) => e.dirty && !e.convertedOnly));
      updater.startAutoCheck();
      // TIFF の既定のアプリが PDF Studio でなければ設定の手順を案内する（ほかの起動時のお知らせと重ならないよう遅らせる）
      setTimeout(() => defaultapp.checkTiffDefault({ installed: updater.isInstalled(), log: updater.log }).catch((e) => updater.log('ERROR', e)), 12000);
      // インストール不要版：新しい版のフォルダーで起動したら、ダブルクリックで開くアプリの場所を書き直す
      if (!updater.isInstalled()) setTimeout(() => defaultapp.repairPortableOpenWith({ log: updater.log, findInstalls: updater.findInstalls }), 3000);
      // 別の場所にも入っていないか（古い版のショートカットから起動してしまうのを防ぐ）
      setTimeout(() => updater.checkDuplicateInstalls().catch(() => {}), 4000);
      // 更新のあとインストーラーから起動されたときは、更新できたことを知らせる
      if (process.argv.includes('--updated')) {
        const host = [...hosts.values()][0];
        if (host) whenReady(host, () => {
          const tab = host.active;
          tab?.wc.once('did-finish-load', () => setTimeout(() => { if (!tab.wc.isDestroyed()) tab.wc.send('toast', T(`バージョン ${app.getVersion()} に更新しました`)); }, 1500));
        });
      }
    }
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
    } finally {
      if (starting) { starting = false; scheduleSession(); }
    }
  });

  app.on('window-all-closed', () => app.quit());
  // 「次回の終了時に更新」を選んでいたら、終了するときにインストーラーを起動する
  // 終了するときは、閉じ始める前に前回の続きを書いておく（閉じていくタブで記録が減らないように）
  app.on('before-quit', () => { saveSessionNow(); quitting = true; });
  app.on('will-quit', () => updater.installAtQuit());
}
