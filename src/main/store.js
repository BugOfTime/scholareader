// Local storage under the app's userData folder:
//   library.json        list of papers (metadata + status)
//   papers/<id>.pdf     the imported PDF
//   papers/<id>.json    the AI result (layout, translation, references, summary)
//   folders.json        project folders [{ id, name, createdAt }]; papers list folder ids in `folders`
//   settings.json       provider + model
//   api-key.bin         API key, encrypted with the OS keychain when available
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class Store {
  constructor(dir, safeStorage) {
    this.dir = dir;
    this.safe = safeStorage;
    this.papersDir = path.join(dir, 'papers');
    fs.mkdirSync(this.papersDir, { recursive: true });
    this.libFile = path.join(dir, 'library.json');
    this.settingsFile = path.join(dir, 'settings.json');
    this.foldersFile = path.join(dir, 'folders.json');
    this.keyFile = path.join(dir, 'api-key.bin');
  }

  readJSON(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
  }
  writeJSON(file, data) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  }

  list() { return this.readJSON(this.libFile, []); }
  saveList(list) { this.writeJSON(this.libFile, list); }
  get(id) { return this.list().find((p) => p.id === id); }
  update(id, patch) {
    const list = this.list();
    const i = list.findIndex((p) => p.id === id);
    if (i < 0) return null;
    list[i] = { ...list[i], ...patch };
    this.saveList(list);
    return list[i];
  }

  addPdf(srcPath, folderIds = []) {
    const id = crypto.randomUUID();
    fs.copyFileSync(srcPath, this.pdfPath(id));
    const fileName = path.basename(srcPath);
    const entry = { id, fileName, title: fileName.replace(/\.pdf$/i, ''), authors: '', status: 'processing', progress: 0, error: '', addedAt: Date.now(), openedAt: 0, folders: this.validFolderIds(folderIds) };
    this.saveList([entry, ...this.list()]);
    return entry;
  }
  remove(id) {
    this.saveList(this.list().filter((p) => p.id !== id));
    for (const f of [this.pdfPath(id), this.dataPath(id)]) { try { fs.unlinkSync(f); } catch {} }
  }

  // ---- folders (a paper can be in any number of folders) ----
  folders() { return this.readJSON(this.foldersFile, []); }
  validFolderIds(ids) {
    const known = new Set(this.folders().map((f) => f.id));
    return [...new Set((Array.isArray(ids) ? ids : []).filter((id) => known.has(id)))];
  }
  cleanName(name) {
    const n = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!n) throw new Error('文件夹名称不能为空。');
    return n;
  }
  createFolder(name) {
    const n = this.cleanName(name);
    const list = this.folders();
    if (list.some((f) => f.name.toLowerCase() === n.toLowerCase())) throw new Error(`已经有叫“${n}”的文件夹了。`);
    const folder = { id: crypto.randomUUID(), name: n, createdAt: Date.now() };
    this.writeJSON(this.foldersFile, [...list, folder]);
    return folder;
  }
  renameFolder(id, name) {
    const n = this.cleanName(name);
    const list = this.folders();
    if (list.some((f) => f.id !== id && f.name.toLowerCase() === n.toLowerCase())) throw new Error(`已经有叫“${n}”的文件夹了。`);
    const f = list.find((x) => x.id === id);
    if (!f) throw new Error('文件夹不存在。');
    f.name = n;
    this.writeJSON(this.foldersFile, list);
    return f;
  }
  // Deleting a folder never deletes papers; it only removes the label from them.
  deleteFolder(id) {
    this.writeJSON(this.foldersFile, this.folders().filter((f) => f.id !== id));
    const list = this.list();
    for (const p of list) if (Array.isArray(p.folders)) p.folders = p.folders.filter((x) => x !== id);
    this.saveList(list);
  }
  setPaperFolders(paperId, ids) { return this.update(paperId, { folders: this.validFolderIds(ids) }); }

  pdfPath(id) { return path.join(this.papersDir, `${id}.pdf`); }
  dataPath(id) { return path.join(this.papersDir, `${id}.json`); }
  readPdf(id) { return fs.readFileSync(this.pdfPath(id)); }
  readData(id) { return this.readJSON(this.dataPath(id), null); }
  writeData(id, data) { this.writeJSON(this.dataPath(id), data); }

  // Papers left "processing" when the app quit cannot resume.
  markInterrupted() {
    const list = this.list();
    let changed = false;
    for (const p of list) if (p.status === 'processing') { p.status = 'error'; p.error = '处理被中断，请点“重试”。'; changed = true; }
    if (changed) this.saveList(list);
  }

  getSettings() {
    const s = this.readJSON(this.settingsFile, {});
    const prov = ['codex', 'claude', 'openai'].includes(s.prov) ? s.prov : 'codex';
    const model = typeof s.model === 'string' ? s.model : prov === 'claude' ? 'claude-opus-5-5' : '';
    return { prov, model, key: this.readKey(), codexPath: s.codexPath || '' };
  }
  setSettings({ prov, model, key, codexPath }) {
    this.writeJSON(this.settingsFile, { prov, model, codexPath: codexPath || '' });
    this.writeKey(key || '');
  }
  readKey() {
    try {
      const buf = fs.readFileSync(this.keyFile);
      if (buf[0] === 1) return this.safe.decryptString(buf.subarray(1));
      return buf.subarray(1).toString('utf8');
    } catch { return ''; }
  }
  writeKey(key) {
    if (!key) { try { fs.unlinkSync(this.keyFile); } catch {} return; }
    const enc = this.safe && this.safe.isEncryptionAvailable();
    const body = enc ? this.safe.encryptString(key) : Buffer.from(key, 'utf8');
    fs.writeFileSync(this.keyFile, Buffer.concat([Buffer.from([enc ? 1 : 0]), body]), { mode: 0o600 });
  }
}

module.exports = { Store };
