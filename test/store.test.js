const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/main/store');

const PDF = path.join(__dirname, 'fixtures', 'mini-paper.pdf');
const fresh = () => new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'srstore-')), null);

test('folders: create, rename, reject duplicates and empty names', () => {
  const s = fresh();
  const a = s.createFolder('  毕业论文  ');
  assert.equal(a.name, '毕业论文');
  assert.throws(() => s.createFolder('毕业论文'), /已经有/);
  assert.throws(() => s.createFolder('   '), /不能为空/);
  const b = s.createFolder('Deepfake');
  assert.throws(() => s.renameFolder(b.id, '毕业论文'), /已经有/);
  s.renameFolder(b.id, 'Cyber');
  assert.deepEqual(s.folders().map((f) => f.name), ['毕业论文', 'Cyber']);
  s.renameFolder(b.id, 'cyber'); // same folder, different case is fine
  assert.equal(s.folders()[1].name, 'cyber');
});

test('a paper can be in several folders; unknown ids are dropped', () => {
  const s = fresh();
  const a = s.createFolder('A'), b = s.createFolder('B');
  const p = s.addPdf(PDF, [a.id, 'nope', a.id]);
  assert.deepEqual(s.get(p.id).folders, [a.id]);
  s.setPaperFolders(p.id, [a.id, b.id]);
  assert.deepEqual(s.get(p.id).folders, [a.id, b.id]);
});

test('deleting a folder keeps its papers and removes the label', () => {
  const s = fresh();
  const a = s.createFolder('A'), b = s.createFolder('B');
  const p = s.addPdf(PDF, [a.id, b.id]);
  s.deleteFolder(a.id);
  assert.equal(s.folders().length, 1);
  assert.deepEqual(s.get(p.id).folders, [b.id]);
  assert.ok(fs.existsSync(s.pdfPath(p.id)));
});

test('removing a paper deletes its files; interrupted papers become errors', () => {
  const s = fresh();
  const p = s.addPdf(PDF);
  s.writeData(p.id, { title: 'x' });
  const q = s.addPdf(PDF);
  s.markInterrupted();
  assert.equal(s.get(q.id).status, 'error');
  s.remove(p.id);
  assert.equal(s.get(p.id), undefined);
  assert.ok(!fs.existsSync(s.pdfPath(p.id)) && !fs.existsSync(s.dataPath(p.id)));
});

test('settings default to Codex and keep the key across provider saves', () => {
  const s = fresh();
  assert.equal(s.getSettings().prov, 'codex');
  s.setSettings({ prov: 'claude', model: 'claude-opus-5-5', key: 'sk-ant-1' });
  assert.equal(s.getSettings().key, 'sk-ant-1');
  s.setSettings({ prov: 'codex', model: '', key: 'sk-ant-1' });
  assert.deepEqual([s.getSettings().prov, s.getSettings().model], ['codex', '']);
});
