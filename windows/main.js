// PDF Studio for Windows — メインプロセス
const { app, BrowserWindow, WebContentsView, Menu, dialog, ipcMain, protocol, net, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
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
  win.loadURL('app://local/renderer/tabs.html');
  // ウィンドウが表示できるようになってからタブを作る。
  // それより前に作ったタブは、数十秒のあいだ画面が描かれないことがあった（Mac で確認）
  win.once('show', () => {
    host.ready = true;
    for (const fn of host.pending.splice(0)) fn();
  });
  // タブはウィンドウの show の知らせのあとで作る（それより前に作ると描画が止まる）。
  // 知らせがなかなか来ない環境でも、待たずに作ると止まるので、代わりの処理は入れない
  win.once('ready-to-show', () => win.show());
  // 表示されたら画面の位置を合わせ直す（表示前に作ったタブが描かれないままにならないように）

  win.on('focus', () => { if (lastHost !== host) { lastHost = host; buildMenu(); } });
  for (const ev of ['resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'restore']) win.on(ev, () => layout(host));
  win.on('close', (e) => onWindowClose(host, e));
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
  const tab = { win: host.win, host, view, wc, dirty: false, forceClose: false, initial, title: 'PDF Studio', empty: !initial };
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

function setupDocContents(tab) {
  const wc = tab.wc;
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
    tabs: host.tabs.map((t) => ({ id: t.id, title: tabLabel(t), dirty: t.dirty })),
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

/** 保存していない変更があれば確かめる。0 保存 / 1 保存しない / 2 キャンセル */
function askSave(win) {
  const q = fromQueue('askSave');
  if (q.hit) return q.v;
  return dialog.showMessageBoxSync(win, {
    type: 'warning',
    buttons: [T('保存'), T('保存しない'), T('キャンセル')],
    defaultId: 0,
    cancelId: 2,
    message: T('変更内容を保存しますか？'),
    detail: T('保存しないと変更内容は失われます。')
  });
}

/** タブを閉じる（保存していなければ確かめる）。閉じなかったら false */
function requestCloseTab(tab) {
  if (windows.get(tab.id) !== tab) return true; // もう閉じている
  const host = tab.host;
  host.closing = false;
  if (tab.dirty && !tab.forceClose) {
    activateTab(host, tab);
    const r = askSave(host.win);
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
  });
}

/** ウィンドウを閉じるとき、保存していないタブを 1 つずつ確かめる */
function onWindowClose(host, e) {
  if (host.forceClose) return;
  const dirty = host.tabs.filter((t) => t.dirty && !t.forceClose);
  if (!dirty.length) return;
  e.preventDefault();
  // 「保存しない」はウィンドウを閉じると決まるまで印を付けない（途中でキャンセルしたら確認が残るように）
  const discard = [];
  for (const tab of dirty) {
    activateTab(host, tab);
    const r = askSave(host.win);
    if (r === 2) { host.closing = false; return; }
    if (r === 1) { discard.push(tab); continue; }
    // 先に「保存しない」を選んだタブは閉じる（保存のあとウィンドウを閉じ直すときに、もう一度聞かない）
    for (const t of discard) destroyTab(t, { keepWindow: true });
    // 保存してから閉じる。保存できたらタブが閉じ、続けてウィンドウを閉じ直す
    host.closing = true;
    tab.wc.send('menu', 'save-and-close');
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
        m('検索...', 'find', 'CmdOrCtrl+F')
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
  const tr = (items) => items.map((it) => ({ ...it, label: it.label && T(it.label), submenu: Array.isArray(it.submenu) ? tr(it.submenu) : it.submenu }));
  Menu.setApplicationMenu(Menu.buildFromTemplate(tr(template)));
}

function changeLang(l) {
  if (l === i18n.getLang()) return;
  i18n.setLang(l);
  buildMenu();
  for (const tab of windows.values()) if (!tab.wc.isDestroyed()) tab.wc.send('lang', l);
  for (const host of hosts.values()) sendStrip(host);
}

// ---------------------------------------------------------------- IPC

ipcMain.handle('get-initial', async (e) => {
  const entry = entryFor(e);
  const init = entry?.initial;
  if (!init) return null;
  entry.initial = null;
  if (init.bytes) return init;
  try {
    return { path: init.path, name: path.basename(init.path), bytes: fs.readFileSync(init.path) };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.on('set-dirty', (e, dirty) => {
  const entry = entryFor(e);
  if (entry) {
    entry.dirty = dirty;
    if (dirty) entry.forceClose = false; // 編集し直したら、閉じるときにまた確かめる
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
    { label: T('ほかのタブを閉じる'), enabled: h.tabs.length > 1, click: () => { for (const x of others()) if (requestCloseTab(x) !== true) break; } },
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
    openInHost(h, { bytes: Buffer.from(f.bytes), name: path.basename(f.name), path: null });
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
    return { self: entry.id, active: h.active?.id ?? null, mode: h.mode, windows: hosts.size, tabs: h.tabs.map((t) => ({ id: t.id, title: tabLabel(t), dirty: t.dirty, visible: paneRects(h).some((r) => r.tab === t) })), panes: paneRects(h).map((r) => ({ id: r.tab.id, ...r.rect })) };
  }
  if (cmd === 'tab') {
    const h = entry.host;
    const t = arg.id != null ? tabOf(h, arg.id) : null;
    if (arg.do === 'new') return addTab(h, null, { activate: !!arg.activate }).id;
    if (arg.do === 'activate' && t) { activateTab(h, t); return true; }
    if (arg.do === 'close' && t) return requestCloseTab(t);
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
    if (arg.do === 'close-any' && any) { destroyTab(any); return true; }
    if (arg.do === 'request-close-any' && any) {
      // タブの × と同じ閉じ方。閉じたあとのそのウィンドウの様子を返す
      const h = any.host;
      requestCloseTab(any);
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
    if (arg.do === 'window-close') { let prevented = false; onWindowClose(h, { preventDefault: () => { prevented = true; } }); return prevented; }
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
  if (cmd === 'shot') {
    const img = await entry.wc.capturePage();
    const d = process.env.PDFSTUDIO_TEST_OUT || path.join(os.tmpdir(), 'pdfstudio-test');
    fs.writeFileSync(path.join(d, arg + '.png'), img.toPNG());
    return true;
  }
  if (cmd === 'log') {
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
    let code = arg ? 1 : 0;
    // 最後に、このウィンドウで最後のタブを閉じても空のタブが残る（アプリが終わらない）ことを確かめる
    const host = entry.host;
    if (!PERFTEST && host.ready && host.tabs.length === 1 && !entry.empty) {
      entry.dirty = false;
      requestCloseTab(entry);
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
function readText(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(buf);
  } catch {
    return new TextDecoder('shift_jis').decode(buf);
  }
}

// 文書ファイル（Word / テキスト / HTML）→ PDF 変換（Chromium の印刷機能を使用）
ipcMain.handle('convert-to-pdf', async (e, filePath) => {
  const ext = path.extname(filePath).toLowerCase();
  let html;
  if (ext === '.docx') {
    const mammoth = require('mammoth');
    const r = await mammoth.convertToHtml({ path: filePath });
    html = r.value;
  } else if (ext === '.html' || ext === '.htm') {
    html = readText(filePath);
  } else {
    const t = readText(filePath);
    html = '<pre>' + t.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</pre>';
  }
  const full = `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font-family:"Yu Gothic","Meiryo","Hiragino Sans","Noto Sans JP",sans-serif;font-size:11pt;line-height:1.6;color:#000}
    pre{white-space:pre-wrap;font-family:inherit}
    img{max-width:100%} table{border-collapse:collapse} td,th{border:1px solid #999;padding:4px}
  </style></head><body>${html}</body></html>`;
  const tmp = path.join(os.tmpdir(), `pdfstudio-${Date.now()}.html`);
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
    if (files.length) files.forEach(openPath);
    else if (lastHost && !lastHost.win.isDestroyed()) {
      // もう一度起動されたら、今のウィンドウに新しいタブを開く
      const host = lastHost;
      whenReady(host, () => { if (!host.win.isDestroyed() && !host.active?.empty) addTab(host); });
      if (lastHost.win.isMinimized()) lastHost.win.restore();
      lastHost.win.focus();
    } else createWindow();
  });

  app.whenReady().then(() => {
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
    if (files.length) files.forEach(openPath);
    else createWindow();
    if (SELFTEST) BrowserWindow.getAllWindows()[0]?.setSize(1400, 900 + STRIP_H);
    else {
      updater.setUnsavedChecker(() => [...windows.values()].some((e) => e.dirty));
      updater.startAutoCheck();
      // TIFF の既定のアプリが PDF Studio でなければ設定の手順を案内する（ほかの起動時のお知らせと重ならないよう遅らせる）
      setTimeout(() => defaultapp.checkTiffDefault({ installed: updater.isInstalled(), log: updater.log }).catch((e) => updater.log('ERROR', e)), 12000);
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
  });

  app.on('window-all-closed', () => app.quit());
  // 「次回の終了時に更新」を選んでいたら、終了するときにインストーラーを起動する
  app.on('will-quit', () => updater.installAtQuit());
}
