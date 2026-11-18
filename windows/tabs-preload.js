// タブバー（ウィンドウ上部）に公開する API。文書の画面（preload.js）とは別
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tabs', {
  ready: () => ipcRenderer.send('tabs:ready'),
  activate: (id) => ipcRenderer.send('tabs:activate', id),
  close: (id) => ipcRenderer.send('tabs:close', id),
  newTab: () => ipcRenderer.send('tabs:new'),
  move: (id, index) => ipcRenderer.send('tabs:move', id, index),
  contextMenu: (id) => ipcRenderer.send('tabs:menu', id),
  layoutMenu: () => ipcRenderer.send('tabs:layout-menu'),
  open: (files) => ipcRenderer.send('tabs:open', files),
  onState: (cb) => ipcRenderer.on('tabs:state', (e, s) => cb(s))
});
