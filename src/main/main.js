const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, net } = require('electron');
const path = require('path');
const { Store } = require('./store');
const ai = require('./ai');
const codex = require('./codex');
const refs = require('./refs');

let win, store;
const running = new Set();
const lookingUp = new Set(); // papers whose reference links are being looked up
const triedOnOpen = new Set(); // look up an opened paper at most once per app run

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}
function broadcastLibrary() { send('library:changed', store.list()); }
function broadcastFolders() { send('folders:changed', store.folders()); }

async function processPaper(id) {
  if (running.has(id)) return;
  running.add(id);
  const entry = store.update(id, { status: 'processing', progress: 0, error: '' });
  broadcastLibrary();
  let last = 0;
  try {
    const cfg = store.getSettings();
    const paper = await ai.analyzePaper(cfg, store.readPdf(id), entry.fileName, (chars) => {
      if (chars - last > 400) { last = chars; send('paper:progress', { id, chars }); }
    });
    paper.provider = cfg.prov;
    paper.model = cfg.model;
    store.writeData(id, paper);
    store.update(id, { status: 'ready', title: paper.title || entry.title, authors: paper.authors, progress: 0 });
    lookupRefs(id);
  } catch (err) {
    store.update(id, { status: 'error', error: err.message || String(err) });
  } finally {
    running.delete(id);
    broadcastLibrary();
  }
}

// Find original links for references that have none, in the background.
// Electron's net.fetch uses the system proxy and certificates, like the browser.
async function lookupRefs(id) {
  if (lookingUp.has(id) || process.env.SCHOLAREADER_NO_LOOKUP) return;
  const paper = store.readData(id);
  if (!paper || !refs.needsLookup(paper.references)) return;
  lookingUp.add(id);
  send('paper:refs', { id, state: 'start', done: 0, total: paper.references.filter((r) => !r.url && !r.lookup).length });
  let unreachable = 0;
  try {
    ({ unreachable } = await refs.resolveReferences(paper.references, {
      fetchFn: (url, opts) => net.fetch(url, opts),
      // Tests point these at a local mock server.
      bases: { crossref: process.env.SCHOLAREADER_CROSSREF_URL || 'https://api.crossref.org', s2: process.env.SCHOLAREADER_S2_URL || 'https://api.semanticscholar.org' },
      onProgress: (done, total) => send('paper:refs', { id, state: 'progress', done, total }),
    }));
    const latest = store.readData(id);
    // Skip the write if the paper was deleted or is being processed again meanwhile.
    if (latest && !running.has(id)) { latest.references = paper.references; store.writeData(id, latest); }
  } catch (err) {
    console.error('reference lookup failed', err);
  } finally {
    lookingUp.delete(id);
    send('paper:refs', { id, state: 'done', unreachable });
  }
}

function importPaths(paths, folderIds = []) {
  const pdfs = paths.filter((p) => /\.pdf$/i.test(p));
  for (const p of pdfs) {
    const entry = store.addPdf(p, folderIds);
    processPaper(entry.id);
  }
  broadcastLibrary();
  return pdfs.length;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Reference links open in the default browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) { e.preventDefault(); if (/^https?:\/\//.test(url)) shell.openExternal(url); }
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  store = new Store(process.env.SCHOLAREADER_DATA_DIR || app.getPath('userData'), safeStorage);
  store.markInterrupted();

  ipcMain.handle('library:list', () => store.list());
  ipcMain.handle('library:import', async (_e, folderIds) => {
    const r = await dialog.showOpenDialog(win, { title: '添加文章', properties: ['openFile', 'multiSelections'], filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    return r.canceled ? 0 : importPaths(r.filePaths, folderIds);
  });
  ipcMain.handle('library:importPaths', (_e, paths, folderIds) => importPaths(Array.isArray(paths) ? paths : [], folderIds));
  const folderCall = (fn) => async (...args) => {
    try { const value = fn(...args); broadcastFolders(); broadcastLibrary(); return { ok: true, value }; } catch (err) { return { ok: false, error: err.message }; }
  };
  ipcMain.handle('folders:list', () => store.folders());
  ipcMain.handle('folders:create', folderCall((_e, name) => store.createFolder(name)));
  ipcMain.handle('folders:rename', folderCall((_e, id, name) => store.renameFolder(id, name)));
  ipcMain.handle('folders:delete', folderCall((_e, id) => store.deleteFolder(id)));
  ipcMain.handle('library:setFolders', folderCall((_e, id, ids) => store.setPaperFolders(id, ids)));
  ipcMain.handle('library:retry', (_e, id) => { processPaper(id); return true; });
  ipcMain.handle('library:remove', (_e, id) => {
    if (running.has(id)) return false; // still being processed
    store.remove(id); broadcastLibrary(); return true;
  });
  ipcMain.handle('library:touch', (_e, id, patch) => { const t = Number(patch && patch.openedAt); if (t > 0) store.update(id, { openedAt: t }); return true; });
  ipcMain.handle('paper:get', (_e, id) => {
    const data = store.readData(id);
    // Older papers get their links filled in on open (once per run, so an offline Mac doesn't loop).
    if (data && !running.has(id) && !triedOnOpen.has(id)) { triedOnOpen.add(id); lookupRefs(id); }
    return data && { ...data, refsLooking: lookingUp.has(id) };
  });
  ipcMain.handle('paper:showPdf', (_e, id) => shell.openPath(store.pdfPath(id)));

  ipcMain.handle('settings:get', () => {
    const s = store.getSettings();
    return { prov: s.prov, model: s.model, hasKey: !!s.key, keyHint: s.key ? `…${s.key.slice(-4)}` : '' };
  });
  ipcMain.handle('settings:set', (_e, s) => {
    const cur = store.getSettings();
    const key = s.key === undefined ? cur.key : String(s.key).trim();
    const prov = ['codex', 'claude', 'openai'].includes(s.prov) ? s.prov : cur.prov;
    store.setSettings({ prov, model: String(s.model ?? '').trim(), key, codexPath: cur.codexPath });
    return true;
  });
  ipcMain.handle('codex:status', () => codex.status(store.getSettings().codexPath));
  ipcMain.handle('codex:login', async () => {
    try { return { ok: true, status: await codex.login(store.getSettings().codexPath) }; } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('settings:test', async (_e, s) => {
    const cur = store.getSettings();
    const cfg = { prov: s.prov, model: s.model, codexPath: cur.codexPath, key: s.key === undefined ? cur.key : String(s.key).trim() };
    try { await ai.testConnection(cfg); return { ok: true }; } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('ai:explain', async (_e, req) => {
    try { return { ok: true, text: await ai.explain(store.getSettings(), req) }; } catch (err) { return { ok: false, error: err.message }; }
  });

  createWindow();
  // Used by automated tests: import a PDF at startup without the file dialog.
  if (process.env.SCHOLAREADER_IMPORT) win.webContents.once('did-finish-load', () => importPaths([process.env.SCHOLAREADER_IMPORT]));
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
