// タブバー：タブの表示・切り替え・閉じる・並べ替え。状態はメインプロセスが持ち、ここは表示するだけ
'use strict';
(() => {
  const list = document.getElementById('tablist');
  const frames = document.getElementById('frames');
  const newBtn = document.getElementById('new-tab');
  const layoutBtn = document.getElementById('layout');
  const B = 2; // 枠の太さ（メインプロセスの PANE_INSET と同じ）
  let dragId = null;

  function render(s) {
    newBtn.title = s.labels.newTab;
    layoutBtn.title = s.labels.layout;
    layoutBtn.classList.toggle('on', s.mode !== 'single');
    const shown = new Set(s.frames.map((f) => f.id));
    list.replaceChildren(...s.tabs.map((tab) => {
      const el = document.createElement('div');
      el.className = `tab${tab.id === s.active ? ' active' : ''}${shown.has(tab.id) ? ' shown' : ''}`;
      el.setAttribute('role', 'tab');
      el.dataset.id = tab.id;
      el.title = tab.title;
      el.draggable = true;
      if (tab.dirty) {
        const dot = document.createElement('span');
        dot.className = 'dot';
        dot.textContent = '●';
        el.append(dot);
      }
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = tab.title;
      const x = document.createElement('button');
      x.className = 'x';
      x.textContent = '×';
      x.title = s.labels.close;
      x.addEventListener('mousedown', (e) => e.stopPropagation());
      x.addEventListener('click', (e) => { e.stopPropagation(); window.tabs.close(tab.id); });
      el.append(label, x);
      el.addEventListener('mousedown', (e) => { if (e.button === 0) window.tabs.activate(tab.id); });
      // ホイールクリックで閉じる
      el.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); window.tabs.close(tab.id); } });
      el.addEventListener('contextmenu', (e) => { e.preventDefault(); window.tabs.contextMenu(tab.id); });
      el.addEventListener('dragstart', (e) => { dragId = tab.id; e.dataTransfer.effectAllowed = 'move'; });
      el.addEventListener('dragend', () => { dragId = null; clearDrop(); });
      return el;
    }));
    frames.replaceChildren(...s.frames.map((f) => {
      const el = document.createElement('div');
      el.className = `frame${f.id === s.active ? ' active' : ''}`;
      Object.assign(el.style, { left: `${f.x - B}px`, top: `${f.y - B}px`, width: `${f.width + 2 * B}px`, height: `${f.height + 2 * B}px` });
      return el;
    }));
  }

  const clearDrop = () => list.querySelectorAll('.drop-before').forEach((x) => x.classList.remove('drop-before'));
  /** 並べ替えで落とす位置（何番目の前か） */
  function dropIndex(x) {
    const tabs = [...list.children];
    const i = tabs.findIndex((el) => { const r = el.getBoundingClientRect(); return x < r.left + r.width / 2; });
    return i < 0 ? tabs.length : i;
  }

  document.addEventListener('dragover', (e) => {
    e.preventDefault();
    clearDrop();
    if (dragId == null) return;
    const i = dropIndex(e.clientX);
    list.children[i]?.classList.add('drop-before');
  });
  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    clearDrop();
    if (dragId != null) { window.tabs.move(dragId, dropIndex(e.clientX)); dragId = null; return; }
    // ファイルのドロップは新しいタブで開く
    const files = [...e.dataTransfer.files].filter((f) => /\.(pdf|tiff?)$/i.test(f.name));
    const out = [];
    // TIFF は元のファイルの場所も渡す（場所が分かれば、見ただけで閉じるときに保存を確かめない）
    for (const f of files) out.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()), path: /\.tiff?$/i.test(f.name) ? window.tabs.pathForFile(f) : null });
    if (out.length) window.tabs.open(out);
  });
  // タブの何もないところをダブルクリックで新しいタブ
  document.getElementById('strip').addEventListener('dblclick', (e) => { if (e.target.id === 'strip' || e.target.id === 'tablist' || e.target.classList.contains('spacer')) window.tabs.newTab(); });
  newBtn.addEventListener('click', () => window.tabs.newTab());
  layoutBtn.addEventListener('click', () => window.tabs.layoutMenu());

  window.tabs.onState(render);
  window.tabs.ready();
})();
