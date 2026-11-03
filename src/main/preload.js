const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  listLibrary: () => ipcRenderer.invoke('library:list'),
  importPdf: () => ipcRenderer.invoke('library:import'),
  importFiles: (files) => ipcRenderer.invoke('library:importPaths', [...files].map((f) => webUtils.getPathForFile(f))),
  retry: (id) => ipcRenderer.invoke('library:retry', id),
  remove: (id) => ipcRenderer.invoke('library:remove', id),
  touch: (id, patch) => ipcRenderer.invoke('library:touch', id, patch),
  getPaper: (id) => ipcRenderer.invoke('paper:get', id),
  showPdf: (id) => ipcRenderer.invoke('paper:showPdf', id),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (s) => ipcRenderer.invoke('settings:set', s),
  testSettings: (s) => ipcRenderer.invoke('settings:test', s),
  codexStatus: () => ipcRenderer.invoke('codex:status'),
  codexLogin: () => ipcRenderer.invoke('codex:login'),
  explain: (req) => ipcRenderer.invoke('ai:explain', req),
  onLibrary: (fn) => ipcRenderer.on('library:changed', (_e, list) => fn(list)),
  onProgress: (fn) => ipcRenderer.on('paper:progress', (_e, p) => fn(p)),
});
